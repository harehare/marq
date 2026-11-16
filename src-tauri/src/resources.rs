//! What a worktree cannot isolate (a database, a bucket prefix, a scratch directory) made for each
//! session and removed after it, from an environment note's `resources:` (see `environment`).
//!
//! Before the agent starts, Marq runs each resource's `create` in the session's directory, with the
//! session's `MARQ_*` variables. If one fails, the session does not start (it shows the error, and
//! resuming it tries again). When the session is marked done, or deleted, Marq runs `drop`.
//!
//! What was made is kept in `.marq/resources/<session>.json`, with the `drop` command as it was when
//! the resource was made, so a later edit of the note cannot change what gets dropped. A command that
//! was cut off (the app stopped, the session was cancelled) leaves its resource `creating`, which
//! means unknown: the next start runs `create` again, and `drop` runs for it too. That is why both
//! commands should be safe to run twice. A `drop` that fails keeps its entry, and the next attempt
//! (marking done again) retries it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::environment::{self, Environment};
use crate::error::{Error, Result};
use crate::{shell, vault};

const TIMEOUT: Duration = Duration::from_secs(120);

/// What is known about one resource of a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    /// `creating` (unknown if it exists), `ready`, `dropping` or `failed`.
    pub state: String,
    /// The `drop` command, expanded, as it was when the resource was made.
    pub drop: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

type Ledger = BTreeMap<String, Entry>;

fn ledger_path(vault: &Path, session: &str) -> Result<PathBuf> {
    if session.is_empty() || !session.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(Error::Other("bad session id".into()));
    }
    Ok(vault.join(".marq/resources").join(format!("{session}.json")))
}

pub fn ledger(vault: &Path, session: &str) -> Ledger {
    ledger_path(vault, session)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save(vault: &Path, session: &str, l: &Ledger) -> Result<()> {
    let path = ledger_path(vault, session)?;
    if l.is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(path, serde_json::to_string_pretty(l).map_err(|e| Error::Other(e.to_string()))?)?;
    Ok(())
}

/// Runs a command line in `cwd` with the shell's PATH and `vars`. Ok with its output, or Err with why not.
fn run(command: &str, cwd: &Path, vars: &Value, timeout: Duration) -> std::result::Result<String, String> {
    let out_path = std::env::temp_dir().join(format!("marq-resource-{}.log", vault::new_id()));
    let out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = shell::system_command(command);
    cmd.current_dir(cwd).env("PATH", shell::path()).stdin(Stdio::null()).stdout(out).stderr(err);
    for (k, v) in vars.as_object().into_iter().flatten() {
        if let Some(v) = v.as_str() {
            cmd.env(k, v);
        }
    }
    let started = Instant::now();
    let result = match cmd.spawn() {
        Err(e) => Err(format!("could not run it: {e}")),
        Ok(mut child) => loop {
            match child.try_wait() {
                Ok(Some(s)) if s.success() => break Ok(()),
                Ok(Some(s)) => break Err(format!("it exited with {s}")),
                Ok(None) if started.elapsed() > timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(format!("it did not finish in {}s and was stopped", timeout.as_secs()));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(e) => break Err(e.to_string()),
            }
        },
    };
    let output = std::fs::read_to_string(&out_path).unwrap_or_default();
    let _ = std::fs::remove_file(&out_path);
    let tail: String = {
        let t = output.trim();
        let skip = t.chars().count().saturating_sub(600);
        t.chars().skip(skip).collect()
    };
    match result {
        Ok(()) => Ok(tail),
        Err(e) => Err(if tail.is_empty() { e } else { format!("{e}: {tail}") }),
    }
}

/// Makes the environment's resources for the session, those that are not made yet. Does nothing for a
/// file that is not trusted. `vars` is the session's environment (`MARQ_*`). Stops at the first failure.
pub fn provision(vault: &Path, id: &str, cwd: &Path, env: &Environment, vars: &Value, progress: &dyn Fn(&str)) -> Result<()> {
    if !env.trusted || env.resources.is_empty() {
        return Ok(());
    }
    let short = &id[id.len().saturating_sub(8)..];
    let mut l = ledger(vault, id);
    for r in &env.resources {
        if l.get(&r.name).is_some_and(|e| e.state == "ready") {
            continue;
        }
        let create = environment::expand(&r.create, short);
        progress(&format!("Creating {}…", r.name));
        // Written before the command runs, so that a cut-off leaves a trace that it may exist.
        let drop = l.get(&r.name).map_or_else(|| environment::expand(&r.drop, short), |e| e.drop.clone());
        l.insert(r.name.clone(), Entry { state: "creating".into(), drop, cwd: cwd.to_string_lossy().into_owned(), error: None });
        save(vault, id, &l)?;
        match run(&create, cwd, vars, TIMEOUT) {
            Ok(_) => l.get_mut(&r.name).unwrap().state = "ready".into(),
            Err(e) => {
                let entry = l.get_mut(&r.name).unwrap();
                entry.state = "failed".into();
                entry.error = Some(e.clone());
                save(vault, id, &l)?;
                return Err(Error::Other(format!("could not create the resource {}: {e}", r.name)));
            }
        }
        save(vault, id, &l)?;
    }
    Ok(())
}

/// Drops everything made for the session. Returns what could not be dropped, with the command to run
/// by hand; those stay in the ledger.
pub fn release(vault: &Path, id: &str, vars: &Value, progress: &dyn Fn(&str)) -> Vec<String> {
    let mut l = ledger(vault, id);
    let mut failures = vec![];
    for name in l.keys().cloned().collect::<Vec<_>>() {
        let e = l[&name].clone();
        progress(&format!("Dropping {name}…"));
        let cwd = if Path::new(&e.cwd).is_dir() { PathBuf::from(&e.cwd) } else { vault.to_path_buf() };
        match run(&e.drop, &cwd, vars, TIMEOUT) {
            Ok(_) => {
                l.remove(&name);
            }
            Err(err) => {
                let entry = l.get_mut(&name).unwrap();
                entry.state = "failed".into();
                entry.error = Some(err.clone());
                failures.push(format!("{name}: {err} (run `{}` yourself, or mark the session done again to retry)", e.drop));
            }
        }
        let _ = save(vault, id, &l);
    }
    failures
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "0192f1c2-aaaa-7000-8000-123456789abc";

    fn env(dir: &Path, create: &str, drop: &str) -> Environment {
        let note = format!(
            "---\nresources:\n  db:\n    create: {create}\n    drop: {drop}\n---\n"
        );
        let _ = dir;
        environment::parse(&note, "n.md", true)
    }

    fn no_progress(_: &str) {}

    #[test]
    fn makes_a_resource_once_and_drops_it() {
        let vault = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_string_lossy();
        let e = env(dir.path(), &format!("'touch {d}/db_{{id}}'"), &format!("'rm -f {d}/db_{{id}}'"));
        let vars = json!({});
        provision(vault.path(), ID, dir.path(), &e, &vars, &no_progress).unwrap();
        assert!(dir.path().join("db_56789abc").exists());
        assert_eq!(ledger(vault.path(), ID)["db"].state, "ready");
        // A second start does not run create again.
        std::fs::remove_file(dir.path().join("db_56789abc")).unwrap();
        provision(vault.path(), ID, dir.path(), &e, &vars, &no_progress).unwrap();
        assert!(!dir.path().join("db_56789abc").exists());
        // Dropped with the command saved when it was made, and the ledger is gone.
        std::fs::write(dir.path().join("db_56789abc"), "").unwrap();
        assert!(release(vault.path(), ID, &vars, &no_progress).is_empty());
        assert!(!dir.path().join("db_56789abc").exists());
        assert!(ledger(vault.path(), ID).is_empty());
    }

    #[test]
    fn a_failed_create_stops_the_start_and_is_retried() {
        let vault = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let e = env(dir.path(), "'echo no database {id}; exit 3'", "'true {id}'");
        let err = provision(vault.path(), ID, dir.path(), &e, &json!({}), &no_progress).unwrap_err().to_string();
        assert!(err.contains("db") && err.contains("no database 56789abc"), "{err}");
        assert_eq!(ledger(vault.path(), ID)["db"].state, "failed");
        // Fixed, the next start makes it.
        let e = env(dir.path(), "'true {id}'", "'true {id}'");
        provision(vault.path(), ID, dir.path(), &e, &json!({}), &no_progress).unwrap();
        assert_eq!(ledger(vault.path(), ID)["db"].state, "ready");
    }

    #[test]
    fn a_create_that_was_cut_off_runs_again() {
        let vault = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut l = Ledger::new();
        l.insert("db".into(), Entry { state: "creating".into(), drop: "true".into(), cwd: dir.path().to_string_lossy().into(), error: None });
        save(vault.path(), ID, &l).unwrap();
        let d = dir.path().to_string_lossy();
        let e = env(dir.path(), &format!("'touch {d}/again_{{id}}'"), "'true {id}'");
        provision(vault.path(), ID, dir.path(), &e, &json!({}), &no_progress).unwrap();
        assert!(dir.path().join("again_56789abc").exists());
    }

    #[test]
    fn a_failed_drop_stays_in_the_ledger() {
        let vault = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let e = env(dir.path(), "'true {id}'", "'exit 1 # {id}'");
        provision(vault.path(), ID, dir.path(), &e, &json!({}), &no_progress).unwrap();
        let failures = release(vault.path(), ID, &json!({}), &no_progress);
        assert_eq!(failures.len(), 1);
        assert_eq!(ledger(vault.path(), ID)["db"].state, "failed");
    }

    #[test]
    fn an_untrusted_file_makes_nothing() {
        let vault = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_string_lossy();
        let mut e = env(dir.path(), &format!("'touch {d}/x_{{id}}'"), "'true {id}'");
        e.trusted = false;
        provision(vault.path(), ID, dir.path(), &e, &json!({}), &no_progress).unwrap();
        assert!(!dir.path().join("x_56789abc").exists() && ledger(vault.path(), ID).is_empty());
    }

    #[test]
    fn a_command_without_the_id_is_left_out() {
        let e = environment::parse("---\nresources:\n  db:\n    create: createdb app\n    drop: dropdb app_{id}\n---\n", "n.md", true);
        assert!(e.resources.is_empty() && e.invalid.len() == 1, "{:?}", e.invalid);
    }
}
