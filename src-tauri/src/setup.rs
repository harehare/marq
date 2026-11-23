//! Makes a new worktree ready before the agent starts, from an environment note's `copy:` and `setup:`
//! (see `environment`): the same steps for every session, instead of each agent finding them out.
//!
//! `copy:` takes files that git does not carry (`.env.local`) from the project's own checkout, if the
//! worktree does not have them. `setup:` runs its commands one after the other in the worktree, with the
//! session's `MARQ_*` variables, after the session's resources are made. If one fails, the session does
//! not start (it shows the error, and resuming it tries again).
//!
//! What ran is remembered in `.marq/setup/<worktree>.json` with the commands as they were, so a resumed
//! session, or a later phase on the same worktree, does not install everything again; a change to the
//! commands runs them again. Nothing runs when the session works in the project's own checkout: a
//! person's working copy is not set up behind their back.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::environment::Environment;
use crate::error::{Error, Result};
use crate::resources;

/// An install can take a while.
const TIMEOUT: Duration = Duration::from_secs(900);

/// FNV-1a: stable across runs, for a file name.
fn hash(s: &str) -> String {
    format!("{:016x}", s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3)))
}

fn marker_path(vault: &Path, cwd: &Path) -> PathBuf {
    vault.join(".marq/setup").join(format!("{}.json", hash(&cwd.to_string_lossy())))
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Copies the files `copy:` lists from `project` into `cwd`, those that are not there yet. Returns the
/// ones it copied. A file that does not exist, is not a file or leads out of the project is skipped.
fn copy_files(project: &Path, cwd: &Path, files: &[String]) -> Vec<String> {
    let Ok(root) = project.canonicalize() else { return vec![] };
    let mut copied = vec![];
    for rel in files {
        let (src, dst) = (project.join(rel), cwd.join(rel));
        // A symlink in the project must not lead the copy to somewhere else.
        if dst.exists() || !src.canonicalize().is_ok_and(|s| s.starts_with(&root) && s.is_file()) {
            continue;
        }
        if dst.parent().is_some_and(|d| std::fs::create_dir_all(d).is_ok()) && std::fs::copy(&src, &dst).is_ok() {
            copied.push(rel.clone());
        }
    }
    copied
}

/// Runs the environment's `copy:` and `setup:` in the session's worktree `cwd`. Does nothing for a
/// session in the project's own checkout. `setup:` commands only run for a trusted environment.
pub fn prepare(vault: &Path, project: &Path, cwd: &Path, env: &Environment, vars: &Value, progress: &dyn Fn(&str)) -> Result<()> {
    if (env.setup.is_empty() && env.copy.is_empty()) || same_dir(project, cwd) {
        return Ok(());
    }
    if !env.copy.is_empty() {
        let copied = copy_files(project, cwd, &env.copy);
        if !copied.is_empty() {
            progress(&format!("Copied {}…", copied.join(", ")));
        }
    }
    if !env.trusted || env.setup.is_empty() {
        return Ok(());
    }
    let key = env.setup.join("\n");
    let marker = marker_path(vault, cwd);
    let done = std::fs::read_to_string(&marker).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).is_some_and(|m| m["commands"] == key);
    if done {
        return Ok(());
    }
    for (i, command) in env.setup.iter().enumerate() {
        progress(&format!("Setup {}/{}: {command}", i + 1, env.setup.len()));
        resources::run(command, cwd, vars, TIMEOUT).map_err(|e| Error::Other(format!("setup failed on `{command}`: {e}")))?;
    }
    std::fs::create_dir_all(marker.parent().unwrap())?;
    std::fs::write(&marker, json!({ "cwd": cwd.to_string_lossy(), "commands": key }).to_string())?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn env(yaml: &str, trusted: bool) -> Environment {
        crate::environment::parse(&format!("---\n{yaml}\n---\n"), "n.md", trusted)
    }

    fn quiet(_: &str) {}

    #[test]
    fn copies_missing_files_and_stays_inside_the_project() {
        let (project, wt) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        std::fs::write(project.path().join(".env.local"), "A=1").unwrap();
        std::fs::write(project.path().join("kept"), "from project").unwrap();
        std::fs::write(wt.path().join("kept"), "mine").unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), project.path().join("link")).unwrap();
        let files: Vec<String> = [".env.local", "kept", "link", "missing"].iter().map(|s| s.to_string()).collect();
        assert_eq!(copy_files(project.path(), wt.path(), &files), [".env.local"]);
        assert_eq!(std::fs::read_to_string(wt.path().join("kept")).unwrap(), "mine");
        assert!(!wt.path().join("link").exists());
        // `..` and absolute paths never reach copy_files: the note's parser drops them.
        assert!(env("copy: [../x, /etc/passwd, ok]", true).copy == ["ok"]);
    }

    #[test]
    fn runs_setup_once_and_again_when_it_changes() {
        let (vault, project, wt) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let e = env("setup:\n  - echo a >> ran\n  - echo b >> ran", true);
        prepare(vault.path(), project.path(), wt.path(), &e, &json!({}), &quiet).unwrap();
        prepare(vault.path(), project.path(), wt.path(), &e, &json!({}), &quiet).unwrap();
        assert_eq!(std::fs::read_to_string(wt.path().join("ran")).unwrap(), "a\nb\n");
        let e = env("setup: echo c >> ran", true);
        prepare(vault.path(), project.path(), wt.path(), &e, &json!({}), &quiet).unwrap();
        assert_eq!(std::fs::read_to_string(wt.path().join("ran")).unwrap(), "a\nb\nc\n");
    }

    #[test]
    fn a_failure_stops_the_start_and_is_retried() {
        let (vault, project, wt) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let e = env("setup:\n  - echo broken; exit 2\n  - touch after", true);
        let err = prepare(vault.path(), project.path(), wt.path(), &e, &json!({}), &quiet).unwrap_err().to_string();
        assert!(err.contains("echo broken") && err.contains("broken"), "{err}");
        assert!(!wt.path().join("after").exists());
        let e = env("setup: touch after", true);
        prepare(vault.path(), project.path(), wt.path(), &e, &json!({}), &quiet).unwrap();
        assert!(wt.path().join("after").exists());
    }

    #[test]
    fn untrusted_setup_and_the_projects_own_checkout_are_left_alone() {
        let (vault, project, wt) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let e = env("setup: touch ran", false);
        prepare(vault.path(), project.path(), wt.path(), &e, &json!({}), &quiet).unwrap();
        assert!(!wt.path().join("ran").exists());
        let e = env("setup: touch ran", true);
        prepare(vault.path(), project.path(), project.path(), &e, &json!({}), &quiet).unwrap();
        assert!(!project.path().join("ran").exists());
    }
}
