//! Workspaces: a set of directories a session works on, kept as a note so it can be picked again.
//!
//! ```markdown
//! ---
//! type: workspace
//! title: "mq + docs"
//! project: ~/dev/git/mq            # where the session runs
//! directories:
//!   - path: ~/dev/git/mq-docs
//!     worktree: true               # gets its own worktree on the session's branch
//!   - path: ~/dev/git/mq-lib       # used as it is (worktree: false is the default)
//! ---
//! What each directory is for. The agent gets this text with the list.
//! ```
//!
//! A request names one with `workspace:` (path, id or title), or lists `directories:` itself in the
//! same form; its own `project:` wins over the workspace's. The agent can read and edit every
//! directory (Claude Code's additional directories). Those with `worktree: true` that are git
//! repositories get a worktree like the project's when the session gets one, and show in the
//! Changes panel next to it.

use crate::vault::PathSlash;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::{git, vault};

pub const FOLDER: &str = "workspaces";

/// A directory as a workspace or request lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DirSpec {
    pub path: String,
    #[serde(default)]
    pub worktree: bool,
}

/// A directory a session was given, beyond the one it runs in.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtraDir {
    /// What the agent works in: the worktree when it has one, else the directory itself.
    pub path: String,
    /// As the workspace or request wrote it.
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<git::Worktree>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Workspace {
    pub path: String,
    pub rel: String,
    pub title: String,
    pub project: Option<String>,
    pub directories: Vec<DirSpec>,
    /// The body: what the directories are for.
    pub notes: String,
}

/// `directories:` in a note's frontmatter: items are `path` strings or `{path, worktree}` maps.
pub fn dirs_of(text: &str) -> Vec<DirSpec> {
    use yaml_rust2::{Yaml, YamlLoader};
    let Some(fm) = vault::split_frontmatter(text).0 else { return vec![] };
    if !fm.lines().any(|l| l.starts_with("directories:")) {
        return vec![];
    }
    let Ok(docs) = YamlLoader::load_from_str(fm) else { return vec![] };
    let Some(Yaml::Array(items)) = docs.first().map(|d| d["directories"].clone()) else { return vec![] };
    items
        .iter()
        .filter_map(|y| match y {
            Yaml::String(p) => Some(DirSpec { path: p.trim().to_string(), worktree: false }),
            Yaml::Hash(_) => Some(DirSpec { path: y["path"].as_str()?.trim().to_string(), worktree: y["worktree"].as_bool().unwrap_or(false) }),
            _ => None,
        })
        .filter(|d| !d.path.is_empty())
        .collect()
}

/// The `directories:` block for a note's frontmatter, or "" when there are none.
pub fn render_dirs(dirs: &[DirSpec]) -> String {
    if dirs.is_empty() {
        return String::new();
    }
    let items: String = dirs
        .iter()
        .map(|d| format!("  - path: {}\n    worktree: {}\n", serde_json::to_string(d.path.trim()).unwrap(), d.worktree))
        .collect();
    format!("directories:\n{items}")
}

pub fn parse(text: &str, path: &Path, vault: &Path) -> Option<Workspace> {
    if vault::fm_get(text, "type").as_deref() != Some("workspace") {
        return None;
    }
    Some(Workspace {
        path: path.to_string_lossy().into_owned(),
        rel: path.strip_prefix(vault).unwrap_or(path).to_slash(),
        title: vault::fm_get(text, "title").unwrap_or_else(|| path.file_stem().unwrap_or_default().to_string_lossy().into_owned()),
        project: vault::fm_get(text, "project").filter(|p| !p.trim().is_empty()),
        directories: dirs_of(text),
        notes: vault::split_frontmatter(text).1.lines().filter(|l| !l.starts_with("# ")).collect::<Vec<_>>().join("\n").trim().to_string(),
    })
}

pub fn list(vault: &Path) -> Vec<Workspace> {
    let mut out: Vec<Workspace> = vault::list_files(vault)
        .into_iter()
        .filter(|f| f.kind.as_deref() == Some("workspace"))
        .filter_map(|f| parse(&std::fs::read_to_string(&f.path).ok()?, Path::new(&f.path), vault))
        .collect();
    out.sort_by_key(|w| w.title.to_lowercase());
    out
}

/// A workspace by path, id or title.
pub fn find(vault: &Path, name: &str) -> Result<Workspace> {
    let name = name.trim();
    let by_path = vault::find_note(vault, name).and_then(|p| parse(&std::fs::read_to_string(&p).ok()?, &p, vault));
    by_path
        .or_else(|| list(vault).into_iter().find(|w| w.title.eq_ignore_ascii_case(name) || w.rel.trim_end_matches(".md").ends_with(name)))
        .ok_or_else(|| Error::Other(format!("no workspace \"{name}\" (a note with type: workspace)")))
}

/// Writes `workspaces/<title>.md`. Returns its path.
pub fn create(vault: &Path, title: &str, project: &str, dirs: &[DirSpec], notes: &str) -> Result<PathBuf> {
    let title = title.trim();
    if title.is_empty() {
        return Err(Error::Other("a workspace needs a name".into()));
    }
    let rel = vault::unique_path(vault, FOLDER, title);
    std::fs::create_dir_all(vault.join(FOLDER))?;
    let notes = match notes.trim() {
        "" => "<!-- What each directory is for. The agent gets this with the list. -->",
        n => n,
    };
    let text = format!(
        "---\nid: {}\ntype: workspace\ntitle: {}\ncreated: {}\nproject: {}\n{}---\n# {title}\n\n{notes}\n",
        vault::new_id(),
        serde_json::to_string(title).unwrap(),
        vault::now(),
        serde_json::to_string(project.trim()).unwrap(),
        if dirs.is_empty() {
            "directories: []                  # e.g. [{path: ~/dev/git/docs, worktree: true}, ~/dev/git/lib]\n".to_string()
        } else {
            render_dirs(dirs)
        },
    );
    let path = vault.join(rel);
    std::fs::write(&path, text)?;
    Ok(path)
}

/// Overwrites a workspace note's project and directories. Its id, title, other keys and body stay
/// as written.
pub fn update(path: &Path, project: &str, dirs: &[DirSpec]) -> Result<()> {
    let text = std::fs::read_to_string(path)?;
    if vault::fm_get(&text, "type").as_deref() != Some("workspace") {
        return Err(Error::Other(format!("{} is not a workspace note", path.display())));
    }
    let text = vault::fm_set(&text, "project", &serde_json::to_string(project.trim()).unwrap());
    let (Some(fm), body) = vault::split_frontmatter(&text) else { return Ok(()) };
    let block = if dirs.is_empty() { "directories: []\n".to_string() } else { render_dirs(dirs) };
    // The old block: the `directories:` line and the list under it.
    let (mut lines, mut in_block, mut placed) = (String::new(), false, false);
    for l in fm.lines() {
        if l.starts_with("directories:") {
            (in_block, placed) = (true, true);
            lines.push_str(&block);
        } else if !(in_block && (l.trim().is_empty() || l.starts_with([' ', '\t', '-']))) {
            in_block = false;
            lines.push_str(l);
            lines.push('\n');
        }
    }
    if !placed {
        lines.push_str(&block);
    }
    std::fs::write(path, format!("---\n{lines}---\n{body}"))?;
    Ok(())
}

/// What a request runs on: its project (else the workspace's), the other directories (its own,
/// else the workspace's), and the workspace's notes for the agent.
pub struct Resolved {
    pub project: Option<String>,
    pub dirs: Vec<DirSpec>,
    pub notes: Option<(String, String)>,
    /// The workspace note it names, relative to the vault.
    pub workspace: Option<String>,
}

pub fn resolve(vault: &Path, text: &str) -> Result<Resolved> {
    let own = dirs_of(text);
    let project = vault::fm_get(text, "project").filter(|p| !p.trim().is_empty());
    let Some(name) = vault::fm_get(text, "workspace").filter(|w| !w.trim().is_empty()) else {
        return Ok(Resolved { project, dirs: own, notes: None, workspace: None });
    };
    let ws = find(vault, &name)?;
    let notes = (!ws.notes.is_empty() && !ws.notes.starts_with("<!--")).then(|| (ws.rel.clone(), ws.notes.clone()));
    Ok(Resolved {
        project: project.or(ws.project),
        dirs: if own.is_empty() { ws.directories } else { own },
        notes,
        workspace: Some(ws.rel),
    })
}

/// Sets up the other directories for a new session: worktrees where asked (and when the session
/// itself works in one), on `branch`, else the directories as they are. Missing directories fail
/// the start rather than leaving the agent without them.
pub fn prepare(dirs: &[DirSpec], session_id: &str, branch: Option<&str>, project: Option<&Path>) -> Result<Vec<ExtraDir>> {
    let mut out = vec![];
    for d in dirs {
        let dir = vault::expand_home(&d.path);
        if !dir.is_dir() {
            return Err(Error::Other(format!("the workspace directory {} does not exist", d.path)));
        }
        let repo = git::repo_root(&dir);
        let same_repo = project.and_then(git::repo_root).is_some_and(|p| Some(&p) == repo.as_ref());
        let worktree = match (repo, branch) {
            // The project's own repository already has the session's worktree.
            (Some(repo), Some(branch)) if d.worktree && !same_repo => {
                let name = git::branch_name(&repo, Some(branch), session_id)?;
                Some(git::create(&repo, session_id, &name, false, &git::Base::Head)?)
            }
            _ => None,
        };
        let path = worktree.as_ref().map_or_else(|| dir.to_string_lossy().into_owned(), |w| w.path.clone());
        out.push(ExtraDir { path, source: d.path.clone(), worktree });
    }
    Ok(out)
}

/// What the agent is told about the other directories.
pub fn system_prompt(dirs: &[ExtraDir], notes: Option<&str>) -> String {
    if dirs.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = dirs
        .iter()
        .map(|d| match &d.worktree {
            Some(w) => format!("- {} (a worktree of {} on branch {}; edit here, not in {})", d.path, w.repo, w.branch, d.source),
            None => format!("- {}", d.path),
        })
        .collect();
    let notes = notes.map(|n| format!("\n\nWhat they are for:\n{n}")).unwrap_or_default();
    format!(
        "\n\nThis task spans several directories. Besides the working directory, you can read and edit:\n{}{notes}",
        lines.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_directories() {
        let text = "---\ntype: workspace\ntitle: W\nproject: ~/a\ndirectories:\n  - path: ~/b\n    worktree: true\n  - ~/c\n  - path: \"~/d e\"\n---\n# W\n\nb holds the docs.\n";
        assert_eq!(
            dirs_of(text),
            [
                DirSpec { path: "~/b".into(), worktree: true },
                DirSpec { path: "~/c".into(), worktree: false },
                DirSpec { path: "~/d e".into(), worktree: false },
            ]
        );
        let w = parse(text, Path::new("/v/workspaces/w.md"), Path::new("/v")).unwrap();
        assert_eq!((w.rel.as_str(), w.project.as_deref(), w.notes.as_str()), ("workspaces/w.md", Some("~/a"), "b holds the docs."));
        // Rendered again, it reads back the same.
        let again = format!("---\n{}---\n", render_dirs(&w.directories));
        assert_eq!(dirs_of(&again), w.directories);
    }

    #[test]
    fn prepares_worktrees_where_asked() {
        let root = std::env::temp_dir().join(format!("marq-ws-git-{}", vault::new_id()));
        let repo = |name: &str| {
            let d = root.join(name);
            std::fs::create_dir_all(&d).unwrap();
            for args in [&["init", "-q", "-b", "main"][..], &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]] {
                assert!(crate::shell::command("git").arg("-C").arg(&d).args(args).status().unwrap().success());
            }
            d
        };
        let (docs, lib) = (repo(&format!("docs-{}", vault::new_id())), repo("lib"));
        let id = vault::new_id();
        let specs = [
            DirSpec { path: docs.to_string_lossy().into(), worktree: true },
            DirSpec { path: lib.to_string_lossy().into(), worktree: false },
        ];
        let dirs = prepare(&specs, &id, Some("marq/feature"), None).unwrap();
        let wt = dirs[0].worktree.clone().expect("docs gets a worktree");
        assert_eq!((wt.branch.as_str(), dirs[0].path.as_str()), ("marq/feature", wt.path.as_str()));
        assert!(Path::new(&wt.path).join(".git").exists());
        assert_eq!((dirs[1].worktree.is_none(), dirs[1].path.as_str()), (true, lib.to_str().unwrap()));
        // Without a worktree of its own, the session uses every directory as it is.
        assert!(prepare(&specs, &vault::new_id(), None, None).unwrap()[0].worktree.is_none());
        assert!(prepare(&[DirSpec { path: "/no/such/dir".into(), worktree: false }], &id, None, None).is_err());
        git::remove(&wt).unwrap();
        let _ = std::fs::remove_dir_all(Path::new(&wt.path).parent().unwrap());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn resolves_a_requests_workspace() {
        let dir = std::env::temp_dir().join(format!("marq-ws-{}", vault::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ws = create(&dir, "mq + docs", "~/dev/mq", &[DirSpec { path: "~/dev/docs".into(), worktree: true }], "docs live here").unwrap();
        assert!(ws.starts_with(dir.join(FOLDER)));
        let r = resolve(&dir, "---\ntype: request\nworkspace: mq + docs\n---\n").unwrap();
        assert_eq!(r.project.as_deref(), Some("~/dev/mq"));
        assert_eq!(r.dirs, [DirSpec { path: "~/dev/docs".into(), worktree: true }]);
        assert_eq!(r.notes.unwrap().1, "docs live here");
        assert!(r.workspace.is_some_and(|w| w.starts_with("workspaces/") && w.ends_with("mq-docs.md")));
        // The request's own project and directories win.
        let r = resolve(&dir, "---\nworkspace: mq + docs\nproject: ~/x\ndirectories:\n  - ~/y\n---\n").unwrap();
        assert_eq!((r.project.as_deref(), r.dirs[0].path.as_str()), (Some("~/x"), "~/y"));
        assert!(resolve(&dir, "---\nworkspace: nope\n---\n").is_err());

        // Overwriting keeps the note's id and body, and replaces the project and the list.
        let before = std::fs::read_to_string(&ws).unwrap();
        let new = [DirSpec { path: "~/dev/site".into(), worktree: false }, DirSpec { path: "~/dev/lib".into(), worktree: true }];
        update(&ws, "~/dev/mq2", &new).unwrap();
        let after = std::fs::read_to_string(&ws).unwrap();
        let w = parse(&after, &ws, &dir).unwrap();
        assert_eq!((w.title.as_str(), w.project.as_deref(), w.notes.as_str()), ("mq + docs", Some("~/dev/mq2"), "docs live here"));
        assert_eq!(w.directories, new);
        assert_eq!(vault::fm_get(&after, "id"), vault::fm_get(&before, "id"));
        assert!(!after.contains("~/dev/docs"));
        // To none, and back from the empty form.
        update(&ws, "", &[]).unwrap();
        let w = parse(&std::fs::read_to_string(&ws).unwrap(), &ws, &dir).unwrap();
        assert_eq!((w.project, w.directories.len()), (None, 0));
        update(&ws, "~/dev/mq", &new[..1]).unwrap();
        assert_eq!(parse(&std::fs::read_to_string(&ws).unwrap(), &ws, &dir).unwrap().directories, new[..1]);
        // Only workspace notes.
        let other = dir.join("note.md");
        std::fs::write(&other, "---\ntype: request\n---\n").unwrap();
        assert!(update(&other, "~/x", &[]).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
