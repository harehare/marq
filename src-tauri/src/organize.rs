//! Folders, moves and renames in the vault, keeping relative Markdown links working (SPEC §20).
//!
//! Marq's own links (anchors, sessions, requests) use ids, so they survive moves. Links people
//! write, such as `[plan](../docs/plan.md)`, are relative paths and are rewritten here.

use std::collections::HashMap;
use std::path::Path;

use regex::Regex;
use serde::Serialize;

use crate::error::{Error, Result};
use crate::vault;

/// Folders in the vault, relative, including empty ones. Dot folders are skipped.
pub fn list_dirs(vault: &Path) -> Vec<String> {
    let mut dirs: Vec<String> = walkdir::WalkDir::new(vault)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_dir())
        .map(|e| rel_of(vault, e.path()))
        .collect();
    dirs.sort();
    dirs
}

fn rel_of(vault: &Path, p: &Path) -> String {
    p.strip_prefix(vault).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// Rejects paths Marq manages itself (`sessions/`) or hides (dot folders), and escapes from the vault.
fn check_movable(rel: &str) -> Result<()> {
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Err(Error::Other("the vault root cannot be moved".into()));
    }
    if parts.iter().any(|p| p.starts_with('.') || *p == "..") {
        return Err(Error::Other(format!("{rel} is hidden or outside the vault")));
    }
    if parts[0] == "sessions" {
        return Err(Error::Other("files in sessions/ are managed by Marq and cannot be moved".into()));
    }
    Ok(())
}

/// Creates a folder (and its parents) inside the vault. Returns its relative path.
pub fn create_folder(vault: &Path, rel: &str) -> Result<String> {
    let rel = rel.trim().trim_matches('/');
    check_movable(rel)?;
    let full = vault.join(rel);
    std::fs::create_dir_all(&full)?;
    // Resolve after creating, so a symlink cannot point it outside the vault.
    vault::resolve(vault, rel)?;
    Ok(rel.to_string())
}

/// One Markdown file that moved, as absolute paths (for open tabs) and relative ones.
#[derive(Debug, Serialize, Clone)]
pub struct Moved {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Serialize)]
pub struct MoveResult {
    /// Where the file or folder ended up, relative to the vault.
    pub to: String,
    pub moved: Vec<Moved>,
    /// Notes whose links were rewritten.
    pub relinked: Vec<String>,
}

/// Moves or renames a note or folder. `to` may name an existing folder to move into, or end in `/`.
/// Nothing is overwritten. Relative links in and to the moved notes are rewritten.
pub fn move_path(vault: &Path, from: &str, to: &str) -> Result<MoveResult> {
    let from = from.trim().trim_matches('/');
    let mut to = to.trim().trim_start_matches('/').to_string();
    check_movable(from)?;
    let src = vault.join(from);
    if !src.exists() {
        return Err(Error::Other(format!("{from} does not exist")));
    }
    let name = Path::new(from).file_name().unwrap_or_default().to_string_lossy().into_owned();
    if to.is_empty() || to.ends_with('/') || vault.join(&to).is_dir() {
        to = format!("{}/{name}", to.trim_end_matches('/')).trim_start_matches('/').to_string();
    }
    if src.is_file() && from.ends_with(".md") && !to.ends_with(".md") {
        to.push_str(".md");
    }
    check_movable(&to)?;
    if to == from {
        return Ok(MoveResult { to, moved: vec![], relinked: vec![] });
    }
    if src.is_dir() && (to.starts_with(&format!("{from}/"))) {
        return Err(Error::Other("a folder cannot be moved into itself".into()));
    }
    let dest = vault.join(&to);
    if dest.exists() {
        return Err(Error::Other(format!("{to} already exists")));
    }

    // Old and new relative paths of every Markdown file that moves.
    let mut map: HashMap<String, String> = HashMap::new();
    if src.is_dir() {
        for e in walkdir::WalkDir::new(&src).into_iter().filter_map(|e| e.ok()) {
            if e.file_type().is_file() && e.path().extension().is_some_and(|x| x == "md") {
                let old = rel_of(vault, e.path());
                let new = format!("{to}{}", &old[from.len()..]);
                map.insert(old, new);
            }
        }
    } else if from.ends_with(".md") {
        map.insert(from.to_string(), to.clone());
    }

    std::fs::create_dir_all(dest.parent().unwrap())?;
    vault::resolve(vault, &to)?;
    std::fs::rename(&src, &dest)?;

    let relinked = relink(vault, &map)?;
    let moved = map
        .iter()
        .map(|(o, n)| Moved {
            from: vault.join(o).to_string_lossy().into_owned(),
            to: vault.join(n).to_string_lossy().into_owned(),
        })
        .collect();
    Ok(MoveResult { to, moved, relinked })
}

fn link_re() -> Regex {
    // ](target.md) or ](target.md#part) or ](<target with spaces.md>), not URLs or absolute paths.
    Regex::new(r"\]\((<)?([^)<>\s]+?\.md|[^)<>]+?\.md)(#[^)>]*)?(>)?\)").unwrap()
}

/// Rewrites relative links after the moves in `map` (old relative path -> new). Returns changed notes.
fn relink(vault: &Path, map: &HashMap<String, String>) -> Result<Vec<String>> {
    if map.is_empty() {
        return Ok(vec![]);
    }
    let back: HashMap<&str, &str> = map.iter().map(|(o, n)| (n.as_str(), o.as_str())).collect();
    let re = link_re();
    let mut changed = vec![];
    for f in vault::list_files(vault) {
        let now = f.rel.replace('\\', "/");
        let was = back.get(now.as_str()).copied().unwrap_or(&now).to_string();
        let file_moved = was != now;
        let Ok(text) = std::fs::read_to_string(&f.path) else { continue };
        let out = re.replace_all(&text, |c: &regex::Captures| {
            let whole = c[0].to_string();
            let target = &c[2];
            if target.contains("://") || target.starts_with('/') {
                return whole;
            }
            let decoded = target.replace("%20", " ");
            let Some(old_abs) = join_rel(parent(&was), &decoded) else { return whole };
            let target_moved = map.get(&old_abs);
            if !file_moved && target_moved.is_none() {
                return whole;
            }
            let new_abs = target_moved.cloned().unwrap_or(old_abs);
            let mut rel = relative(parent(&now), &new_abs);
            if target.contains("%20") {
                rel = rel.replace(' ', "%20");
            }
            let (open, close) = (c.get(1).map_or("", |m| m.as_str()), c.get(4).map_or("", |m| m.as_str()));
            format!("]({open}{rel}{}{close})", c.get(3).map_or("", |m| m.as_str()))
        });
        if out != text {
            std::fs::write(&f.path, out.as_ref())?;
            changed.push(now);
        }
    }
    Ok(changed)
}

fn parent(rel: &str) -> &str {
    rel.rfind('/').map_or("", |i| &rel[..i])
}

/// `dir` + `target`, normalized, relative to the vault. None when it climbs out of the vault.
fn join_rel(dir: &str, target: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    for p in target.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    Some(parts.join("/"))
}

/// A relative link from `dir` to `target` (both vault-relative).
fn relative(dir: &str, target: &str) -> String {
    let from: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    let to: Vec<&str> = target.split('/').filter(|p| !p.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut out: Vec<&str> = vec![".."; from.len() - common];
    out.extend(&to[common..]);
    out.join("/")
}

/// A tree of the vault for Claude: folders and notes with their titles and types.
pub fn outline(vault: &Path, folder: Option<&str>) -> Result<Vec<serde_json::Value>> {
    let prefix = folder.map(|f| f.trim_matches('/')).filter(|f| !f.is_empty());
    if prefix.is_some_and(|p| p.split('/').any(|x| x.starts_with('.') || x == "..")) {
        return Err(Error::Other("hidden folders and paths outside the vault cannot be listed".into()));
    }
    let under = |rel: &str| prefix.is_none_or(|p| rel == p || rel.starts_with(&format!("{p}/")));
    let mut out: Vec<serde_json::Value> = list_dirs(vault)
        .into_iter()
        .filter(|d| under(d))
        .map(|d| serde_json::json!({"path": format!("{d}/"), "kind": "folder"}))
        .collect();
    out.extend(vault::list_files(vault).into_iter().filter(|f| under(&f.rel)).map(|f| {
        serde_json::json!({"path": f.rel, "title": f.title, "type": f.kind, "status": f.status})
    }));
    out.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(v: &Path, rel: &str, text: &str) {
        std::fs::create_dir_all(v.join(rel).parent().unwrap()).unwrap();
        std::fs::write(v.join(rel), text).unwrap();
    }
    fn read(v: &Path, rel: &str) -> String {
        std::fs::read_to_string(v.join(rel)).unwrap()
    }

    #[test]
    fn path_helpers() {
        assert_eq!(join_rel("notes/a", "../b/c.md").as_deref(), Some("notes/b/c.md"));
        assert_eq!(join_rel("", "../x.md"), None);
        assert_eq!(relative("notes/a", "notes/b/c.md"), "../b/c.md");
        assert_eq!(relative("", "docs/p.md"), "docs/p.md");
        assert_eq!(relative("docs", "docs/p.md"), "p.md");
    }

    #[test]
    fn moving_a_note_keeps_links() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        write(v, "plan.md", "# Plan\n\nSee [design](notes/design.md#api) and [web](https://x.com/a.md).\n");
        write(v, "notes/design.md", "# Design\n\nBack to [plan](../plan.md).\n");
        write(v, "notes/other.md", "[d](design.md) [s](<my notes.md>)\n");
        write(v, "notes/my notes.md", "spaces\n");

        let r = move_path(v, "notes/design.md", "archive/2026/").unwrap();
        assert_eq!(r.to, "archive/2026/design.md");
        assert!(v.join("archive/2026/design.md").exists() && !v.join("notes/design.md").exists());
        assert!(read(v, "plan.md").contains("[design](archive/2026/design.md#api)"));
        assert!(read(v, "plan.md").contains("(https://x.com/a.md)"));
        assert!(read(v, "archive/2026/design.md").contains("[plan](../../plan.md)"));
        assert!(read(v, "notes/other.md").contains("[d](../archive/2026/design.md)"));
        assert_eq!(r.relinked.len(), 3);

        // A folder moves with everything in it.
        let r = move_path(v, "notes", "old-notes").unwrap();
        assert_eq!(r.moved.len(), 2);
        assert!(read(v, "old-notes/other.md").contains("[d](../archive/2026/design.md)"));
        assert!(read(v, "old-notes/other.md").contains("(<my notes.md>)"));

        // Renaming without .md keeps it a note.
        assert_eq!(move_path(v, "plan.md", "roadmap").unwrap().to, "roadmap.md");
    }

    #[test]
    fn refuses_unsafe_moves() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        write(v, "a.md", "a\n");
        write(v, "b.md", "b\n");
        write(v, "sessions/s.md", "s\n");
        write(v, "f/x.md", "x\n");
        assert!(move_path(v, "a.md", "b.md").is_err(), "overwrite");
        assert!(move_path(v, "sessions/s.md", "s.md").is_err(), "managed");
        assert!(move_path(v, "a.md", "sessions/a.md").is_err(), "into managed");
        assert!(move_path(v, "a.md", "../a.md").is_err(), "outside");
        assert!(move_path(v, "f", "f/g").is_err(), "into itself");
        assert!(create_folder(v, ".hidden").is_err());
        assert_eq!(create_folder(v, "projects/new/").unwrap(), "projects/new");
        assert!(list_dirs(v).contains(&"projects/new".to_string()));
    }
}
