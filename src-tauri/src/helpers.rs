//! Helpers: standing sessions with a role, such as a translator, that other work sends requests to.
//!
//! A helper is a note under `helpers/`. Its body is the role's instructions; the frontmatter may set
//! `model`, `agent`, `project` (the directory it runs in, the vault by default) and `permission_mode`.
//! The first request starts a session that reads the instructions, and marq writes its id to the
//! note's `session:`, so later requests go to the same conversation. Clearing `session:` (or
//! sending with `fresh`) starts over.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::agents;
use crate::error::{Error, Result};
use crate::relay;
use crate::session::{self, SessionMeta};
use crate::sidecar::{Runner, Turn};
use crate::vault;

pub const DIR: &str = "helpers";

#[derive(Debug, Serialize)]
pub struct Helper {
    /// Relative to the vault.
    pub path: String,
    pub name: String,
    /// The first line of the instructions.
    pub summary: String,
    pub model: Option<String>,
    pub agent: Option<String>,
    /// The session requests go to, while it still exists.
    pub session: Option<String>,
}

fn name_of(path: &Path, text: &str) -> String {
    vault::fm_get(text, "title")
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| path.file_stem().unwrap_or_default().to_string_lossy().into_owned())
}

fn instructions(text: &str) -> &str {
    vault::split_frontmatter(text).1.trim()
}

/// The helper's session, if the note names one that is still logged.
fn live_session(vault: &Path, text: &str) -> Option<String> {
    vault::fm_get(text, "session").filter(|id| !id.is_empty() && session::meta(vault, id).is_ok())
}

pub fn list(vault: &Path) -> Vec<Helper> {
    let Ok(dir) = std::fs::read_dir(vault.join(DIR)) else { return vec![] };
    let mut out: Vec<Helper> = dir
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .filter_map(|p| {
            let text = std::fs::read_to_string(&p).ok()?;
            let summary = instructions(&text).lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim_start_matches(['#', ' ']).to_string();
            Some(Helper {
                path: p.strip_prefix(vault).unwrap_or(&p).to_string_lossy().into_owned(),
                name: name_of(&p, &text),
                summary,
                model: vault::fm_get(&text, "model").filter(|s| !s.is_empty()),
                agent: vault::fm_get(&text, "agent").filter(|s| !s.is_empty() && s != agents::DEFAULT),
                session: live_session(vault, &text),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Writes a new helper note with a starting template and returns its path relative to the vault.
pub fn create(vault: &Path, name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::Other("give the helper a name".into()));
    }
    std::fs::create_dir_all(vault.join(DIR))?;
    let base = format!("{DIR}/{}", vault::slug(name));
    let mut rel = format!("{base}.md");
    let mut n = 2;
    while vault.join(&rel).exists() {
        rel = format!("{base}-{n}.md");
        n += 1;
    }
    let text = format!(
        "---\ntitle: {}\n---\nYou are the {name} helper. Other sessions and the user send you requests; do each one and answer with the result only.\n",
        serde_json::to_string(name).unwrap()
    );
    std::fs::write(vault.join(&rel), text)?;
    Ok(rel)
}

/// Sends `text` to the helper at `path`, starting its session first when it has none (or `fresh`).
/// From a session (`from`), the answer can come back to it. Returns the helper's session id.
pub fn send(app: &AppHandle, vault: &Path, path: &str, text: &str, from: Option<&str>, reply: bool, fresh: bool) -> Result<String> {
    if text.trim().is_empty() {
        return Err(Error::Other("the message is empty".into()));
    }
    let p = vault::resolve(vault, path)?;
    let note = std::fs::read_to_string(&p)?;
    let id = match live_session(vault, &note).filter(|_| !fresh) {
        Some(id) => id,
        None => start(app, vault, &p, &note)?,
    };
    match from {
        Some(from) => relay::send(app, vault, from, &id, text, reply, relay::By::User)?,
        None => {
            let meta = session::meta(vault, &id)?;
            app.state::<Runner>().start(app.clone(), vault.to_path_buf(), meta, text.trim().to_string(), Turn::Resume)?;
        }
    }
    Ok(id)
}

/// Starts the helper's session on its instructions and records it in the note. Requests sent right
/// after queue behind this first turn.
fn start(app: &AppHandle, vault: &Path, p: &PathBuf, note: &str) -> Result<String> {
    let name = name_of(p, note);
    let rules = instructions(note);
    if rules.is_empty() {
        return Err(Error::Other(format!("the helper \"{name}\" has no instructions; write them in its note")));
    }
    let id = vault::new_id();
    let cwd = vault::fm_get(note, "project").filter(|s| !s.is_empty()).unwrap_or_else(|| vault.to_string_lossy().into_owned());
    let meta = SessionMeta {
        id: id.clone(),
        title: name.clone(),
        // Not an id any note holds, so turn results are not written back into the helper note.
        origin: format!("helper-{id}"),
        origin_path: p.strip_prefix(vault).unwrap_or(p).to_string_lossy().into_owned(),
        cwd,
        started: vault::now(),
        permission_mode: vault::fm_get(note, "permission_mode").filter(|s| !s.is_empty()),
        model: vault::fm_get(note, "model").filter(|s| !s.is_empty()),
        agent: vault::fm_get(note, "agent").filter(|s| !s.is_empty() && s != agents::DEFAULT),
        worktree: None,
        crew: None,
    };
    let prompt = format!(
        "You are a standing helper in Marq named \"{name}\". Requests will follow in later messages, \
         each answered on its own. Your instructions:\n\n<instructions>\n{rules}\n</instructions>\n\n\
         For now, reply with one short line saying you are ready."
    );
    app.state::<Runner>().start(app.clone(), vault.to_path_buf(), meta, prompt, Turn::New)?;
    std::fs::write(p, vault::fm_set(note, "session", &id))?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_helpers_with_their_first_line() {
        let dir = std::env::temp_dir().join(format!("marq-helpers-{}", vault::new_id()));
        let rel = create(&dir, "翻訳").unwrap();
        assert!(rel.starts_with("helpers/"));
        let all = list(&dir);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "翻訳");
        assert!(all[0].summary.starts_with("You are the 翻訳 helper."));
        assert_eq!(all[0].session, None);
        std::fs::remove_dir_all(dir).ok();
    }
}
