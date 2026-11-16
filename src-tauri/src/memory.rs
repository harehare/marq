//! What a session carries from run to run besides its transcript.
//!
//! - **Instructions**: `instructions.md` in the vault root is the user's standing rules for every
//!   session ("reply in Japanese", "never push"). It is read at the start of each run, so keep it short.
//! - **Progress**: a session's own notes on a long task (done, left, where it stopped), saved with
//!   `set_progress` in `.marq/progress/<session>.md`. A transcript can be compacted or the task can
//!   span follow-ups; the progress notes are given back at every start, so the next run carries on
//!   from them. They hold what cannot be looked up again, not copies of notes or code.
//!
//! Notes about the project itself are knowledge notes (see `knowledge`), listed by title and read on demand.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::vault;

pub const INSTRUCTIONS: &str = "instructions.md";
/// Longest instructions or progress text given to a session, in characters.
const MAX: usize = 4000;

pub(crate) fn clip(text: &str) -> String {
    let t = text.trim();
    if t.chars().count() <= MAX {
        return t.to_string();
    }
    format!("{}…", t.chars().take(MAX).collect::<String>().trim_end())
}

fn progress_path(vault: &Path, session: &str) -> Result<PathBuf> {
    if session.is_empty() || !session.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(Error::Other("bad session id".into()));
    }
    Ok(vault.join(".marq/progress").join(format!("{session}.md")))
}

/// Saves the session's progress notes, replacing the earlier ones. Empty text clears them.
pub fn set_progress(vault: &Path, session: &str, text: &str) -> Result<()> {
    let path = progress_path(vault, session)?;
    if text.trim().is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, clip(text))?;
    Ok(())
}

pub fn progress(vault: &Path, session: &str) -> Option<String> {
    let text = std::fs::read_to_string(progress_path(vault, session).ok()?).ok()?;
    (!text.trim().is_empty()).then_some(text)
}

/// `text` without its `<!-- … -->` comments, which are notes to the user and not for the agent.
pub(crate) fn without_comments(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        match rest[start..].find("-->") {
            Some(end) => rest = &rest[start + end + 3..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// The user's standing instructions without frontmatter or comments, if the note exists and has any.
pub fn instructions(vault: &Path) -> Option<String> {
    let text = std::fs::read_to_string(vault.join(INSTRUCTIONS)).ok()?;
    let body = without_comments(vault::split_frontmatter(&text).1);
    let body = body.trim();
    (!body.is_empty()).then(|| clip(body))
}

/// `instructions.md`, created with a comment that explains it when missing.
pub fn ensure_instructions(vault: &Path) -> Result<PathBuf> {
    let path = vault.join(INSTRUCTIONS);
    if !path.exists() {
        std::fs::write(
            &path,
            "---\ntype: note\ntitle: Standing instructions\n---\n\
<!-- Rules every session follows, in your words. Each session reads this when it starts, so keep it short:\n\
     the first 4,000 characters are used. This comment is not sent. For example:\n\
\n\
     - When a task is done, branch from main and commit with a Conventional Commits message. Do not push.\n\
     - Reply in Japanese.\n\
-->\n",
        )?;
    }
    Ok(path)
}

/// The system prompt addition for a session: instructions first, then its progress notes.
pub fn system_prompt(vault: &Path, session: &str) -> String {
    let mut out = String::new();
    if let Some(i) = instructions(vault) {
        out.push_str(&format!("\n\nThe user's standing instructions (instructions.md). Follow them in every task:\n{i}"));
    }
    if let Some(p) = progress(vault, session) {
        out.push_str(&format!(
            "\n\nYour progress notes from earlier runs of this session (saved with set_progress). Carry on from them \
and keep them current when something is finished or the plan changes:\n{}",
            clip(&p)
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instructions_skip_frontmatter_and_clip() {
        let dir = tempfile::tempdir().unwrap();
        assert!(instructions(dir.path()).is_none());
        std::fs::write(dir.path().join(INSTRUCTIONS), "---\ntitle: x\n---\nReply in Japanese.\n").unwrap();
        assert_eq!(instructions(dir.path()).unwrap(), "Reply in Japanese.");
        std::fs::write(dir.path().join(INSTRUCTIONS), "あ".repeat(MAX + 10)).unwrap();
        assert_eq!(instructions(dir.path()).unwrap().chars().count(), MAX + 1);
    }

    #[test]
    fn comments_are_not_sent_and_the_template_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = ensure_instructions(dir.path()).unwrap();
        assert_eq!(path, dir.path().join(INSTRUCTIONS));
        assert!(instructions(dir.path()).is_none(), "only a comment: nothing to send");
        std::fs::write(&path, "<!-- note -->\nBranch from main.\n<!-- unclosed").unwrap();
        assert_eq!(instructions(dir.path()).unwrap(), "Branch from main.");
        // An existing file is left alone.
        std::fs::write(&path, "mine").unwrap();
        ensure_instructions(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "mine");
    }

    #[test]
    fn progress_replaces_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        set_progress(dir.path(), "s1", "done: a").unwrap();
        set_progress(dir.path(), "s1", "done: a, b").unwrap();
        assert_eq!(progress(dir.path(), "s1").unwrap(), "done: a, b");
        assert!(system_prompt(dir.path(), "s1").contains("done: a, b"));
        assert!(system_prompt(dir.path(), "s2").is_empty());
        set_progress(dir.path(), "s1", "  ").unwrap();
        assert!(progress(dir.path(), "s1").is_none());
    }

    #[test]
    fn session_ids_cannot_escape_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert!(set_progress(dir.path(), "../x", "y").is_err());
    }
}
