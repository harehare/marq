//! Untitled notes and scratch memos.
//!
//! A quick note (`notes/`) or a scratch memo (`scratch/`) starts without a name: the file is named
//! after the time, and the frontmatter has `untitled: true`, so its title is read from the body
//! (the first heading, else the first line). Empty ones are removed when their tab closes and on
//! startup; scratch memos left alone for `[scratch] keep_days` days go to the Trash.

use crate::vault::PathSlash;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::error::{Error, Result};
use crate::{organize, vault};

pub const NOTES_DIR: &str = "notes";
pub const SCRATCH_DIR: &str = "scratch";
const DEFAULT_KEEP_DAYS: u64 = 7;
/// An empty untitled file younger than this may still be open in a tab, so the startup sweep keeps it.
const EMPTY_GRACE: Duration = Duration::from_secs(10 * 60);

/// Creates an untitled note (`scratch = false`) or scratch memo and returns its absolute path.
pub fn create(vault: &Path, scratch: bool) -> Result<PathBuf> {
    let dir = if scratch { SCRATCH_DIR } else { NOTES_DIR };
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H%M").to_string();
    std::fs::create_dir_all(vault.join(dir))?;
    let rel = (1..)
        .map(|n| if n == 1 { format!("{dir}/{stamp}.md") } else { format!("{dir}/{stamp}-{n}.md") })
        .find(|r| !vault.join(r).exists())
        .unwrap();
    let now = vault::now();
    let kind = if scratch { "scratch" } else { "note" };
    let text = format!("---\nid: {}\ntype: {kind}\nuntitled: true\ncreated: {now}\nupdated: {now}\n---\n", vault::new_id());
    let path = vault::resolve(vault, &rel)?;
    std::fs::write(&path, text)?;
    Ok(path)
}

/// The title of an untitled note: its first heading, else its first line of text, as plain text and
/// shortened. Code blocks are passed over (their first line is used only when there is nothing else),
/// and Markdown syntax is dropped, so the tree shows `Plan` rather than `**Plan**` or a fence.
pub fn title_from_body(text: &str) -> Option<String> {
    let body = vault::split_frontmatter(text).1;
    let mut fence: Option<&str> = None;
    let (mut heading, mut first, mut code) = (None, None, None);
    for line in body.lines().map(str::trim) {
        if let Some(f) = fence {
            if line.starts_with(f) && line.trim_start_matches(f.chars().next().unwrap()).trim().is_empty() {
                fence = None;
            } else if code.is_none() && !line.is_empty() {
                code = Some(line);
            }
            continue;
        }
        if let Some(f) = ["```", "~~~"].into_iter().find(|f| line.starts_with(f)) {
            fence = Some(f);
            continue;
        }
        if line.starts_with("# ") {
            heading = Some(line);
            break;
        }
        if first.is_none() && !is_rule(line) {
            first = Some(line).filter(|l| !plain(l).is_empty());
        }
    }
    let t = plain(heading.or(first).or(code)?);
    if t.is_empty() {
        return None;
    }
    let mut s: String = t.chars().take(60).collect();
    if t.chars().count() > 60 {
        s.push('…');
    }
    Some(s)
}

/// A thematic break or table divider (`---`, `***`, `|---|---|`), which says nothing.
fn is_rule(line: &str) -> bool {
    !line.is_empty() && line.chars().all(|c| matches!(c, '-' | '*' | '_' | '=' | '|' | ':' | ' '))
}

/// A line of Markdown as plain text: block markers, emphasis, code spans, links and HTML removed.
fn plain(line: &str) -> String {
    let mut l = line.trim();
    // Block markers: headings, quotes, list items, task boxes.
    loop {
        let before = l;
        l = l.trim_start_matches('#').trim_start();
        l = l.strip_prefix('>').unwrap_or(l).trim_start();
        for m in ["- ", "* ", "+ "] {
            l = l.strip_prefix(m).unwrap_or(l);
        }
        if let Some((n, rest)) = l.split_once(". ").or_else(|| l.split_once(") "))
            && !n.is_empty() && n.len() <= 3 && n.chars().all(|c| c.is_ascii_digit())
        {
            l = rest;
        }
        for m in ["[ ] ", "[x] ", "[X] "] {
            l = l.strip_prefix(m).unwrap_or(l);
        }
        l = l.trim_start();
        if l == before {
            break;
        }
    }
    let chars: Vec<char> = l.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            // `[[note]]` and `[[note|label]]`: the label, else the note.
            '[' if chars.get(i + 1) == Some(&'[') => {
                let rest: String = chars[i + 2..].iter().collect();
                if let Some(end) = rest.find("]]") {
                    let inner = &rest[..end];
                    out.push_str(inner.rsplit('|').next().unwrap_or(inner));
                    i += 2 + rest[..end + 2].chars().count();
                    continue;
                }
                out.push(c);
            }
            // `[text](url)` and `![alt](src)`: the text.
            '[' | '!' => {
                let start = if c == '!' && chars.get(i + 1) == Some(&'[') { i + 1 } else { i };
                let rest: String = chars[start..].iter().collect();
                if rest.starts_with('[')
                    && let Some(close) = rest.find("](")
                    && let Some(end) = rest[close..].find(')')
                {
                    out.push_str(&rest[1..close]);
                    i = start + rest[..close + end + 1].chars().count();
                    continue;
                }
                out.push(c);
            }
            // HTML tags.
            '<' => match chars[i..].iter().position(|&c| c == '>') {
                Some(end) if chars.get(i + 1).is_some_and(|c| c.is_ascii_alphabetic() || *c == '/' || *c == '!') => i += end,
                _ => out.push(c),
            },
            '`' => {}
            // Emphasis markers; a lone `*` or `_` inside a word (snake_case) stays.
            '*' | '~' => {}
            '_' => {
                let inside = i > 0 && chars[i - 1].is_alphanumeric() && chars.get(i + 1).is_some_and(|c| c.is_alphanumeric());
                if inside {
                    out.push(c);
                }
            }
            _ => out.push(c),
        }
        i += 1;
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_untitled(text: &str) -> bool {
    vault::fm_get(text, "untitled").as_deref() == Some("true")
}

fn is_empty(text: &str) -> bool {
    vault::split_frontmatter(text).1.trim().is_empty()
}

/// Deletes an untitled note or scratch memo that has nothing in it. Returns whether it did.
pub fn discard_if_empty(vault: &Path, path: &str) -> Result<bool> {
    let p = vault::resolve(vault, path)?;
    let Ok(text) = std::fs::read_to_string(&p) else { return Ok(false) };
    if !is_untitled(&text) || !is_empty(&text) {
        return Ok(false);
    }
    std::fs::remove_file(&p)?;
    Ok(true)
}

/// What the startup sweep did.
#[derive(Debug, Default, serde::Serialize)]
pub struct Swept {
    /// Empty untitled notes and memos, deleted.
    pub removed: Vec<String>,
    /// Scratch memos older than `keep_days`, moved to the Trash.
    pub trashed: Vec<String>,
}

/// `[scratch] keep_days` from the settings; 0 keeps memos until you delete them.
pub fn keep_days() -> u64 {
    crate::config::read().ok().and_then(|c| c["scratch"]["keep_days"].as_u64()).unwrap_or(DEFAULT_KEEP_DAYS)
}

/// Removes empty untitled files in `notes/` and `scratch/`, and trashes scratch memos not changed
/// for `keep_days` days (none when 0).
pub fn sweep(vault: &Path, keep_days: u64, trash: impl Fn(&Path) -> Result<()>) -> Result<Swept> {
    let mut out = Swept::default();
    let now = SystemTime::now();
    let age = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|m| now.duration_since(m).ok());
    for dir in [NOTES_DIR, SCRATCH_DIR] {
        let Ok(entries) = std::fs::read_dir(vault.join(dir)) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_none_or(|x| x != "md") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            let rel = p.strip_prefix(vault).unwrap_or(&p).to_slash();
            let old = age(&p).unwrap_or_default();
            if is_untitled(&text) && is_empty(&text) && old > EMPTY_GRACE {
                std::fs::remove_file(&p)?;
                out.removed.push(rel);
            } else if dir == SCRATCH_DIR
                && keep_days > 0
                && vault::fm_get(&text, "type").as_deref() == Some("scratch")
                && old > Duration::from_secs(keep_days * 24 * 60 * 60)
            {
                trash(&p)?;
                out.trashed.push(rel);
            }
        }
    }
    Ok(out)
}

/// Keeps a scratch memo: moves it to `to` (a path relative to the vault) and makes it a note.
pub fn keep(vault: &Path, from: &str, to: &str) -> Result<organize::MoveResult> {
    let src = vault::resolve(vault, from)?;
    let text = std::fs::read_to_string(&src)?;
    if vault::fm_get(&text, "type").as_deref() != Some("scratch") {
        return Err(Error::Other(format!("{from} is not a scratch memo")));
    }
    let from_rel = src.strip_prefix(vault.canonicalize()?).unwrap_or(&src).to_slash();
    let r = organize::move_path(vault, &from_rel, to)?;
    let dest = vault.join(&r.to);
    let text = std::fs::read_to_string(&dest)?;
    std::fs::write(&dest, vault::fm_set(&vault::fm_set(&text, "type", "note"), "updated", &vault::now()))?;
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_come_from_the_body() {
        assert_eq!(title_from_body("---\nuntitled: true\n---\n\nhello\n# Plan\n").as_deref(), Some("Plan"));
        assert_eq!(title_from_body("---\nuntitled: true\n---\n\nbuy milk\n").as_deref(), Some("buy milk"));
        assert_eq!(title_from_body("---\nuntitled: true\n---\n\n").as_deref(), None);
        let t = |body: &str| title_from_body(&format!("---\nuntitled: true\n---\n{body}"));
        // Code blocks are passed over, headings inside them too.
        assert_eq!(t("```rust\n# not a heading\nfn main() {}\n```\nafter the code\n").as_deref(), Some("after the code"));
        assert_eq!(t("~~~\nonly code\n~~~\n").as_deref(), Some("only code"));
        assert_eq!(t("```\n```\n").as_deref(), None);
        // Markdown is dropped.
        assert_eq!(t("- [ ] **Fix** the `parser`\n").as_deref(), Some("Fix the parser"));
        assert_eq!(t("> see [the spec](notes/spec.md) and [[Roadmap|plan]]\n").as_deref(), Some("see the spec and plan"));
        assert_eq!(t("---\n\n1. keep snake_case _names_\n").as_deref(), Some("keep snake_case names"));
        assert_eq!(t("## Notes\n# **Plan** <br>\n").as_deref(), Some("Plan"));
    }

    #[test]
    fn creates_discards_and_keeps() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        let a = create(v, true).unwrap();
        let b = create(v, true).unwrap();
        assert_ne!(a, b);
        assert!(a.starts_with(v.canonicalize().unwrap().join("scratch")));
        // Empty: removed on close.
        assert!(discard_if_empty(v, &a.to_string_lossy()).unwrap());
        assert!(!a.exists());
        // With text: kept, and Keep turns it into a note.
        std::fs::write(&b, format!("{}# Idea\n", std::fs::read_to_string(&b).unwrap())).unwrap();
        assert!(!discard_if_empty(v, &b.to_string_lossy()).unwrap());
        let rel = b.strip_prefix(v.canonicalize().unwrap()).unwrap().to_string_lossy().into_owned();
        let r = keep(v, &rel, "notes/idea").unwrap();
        assert_eq!(r.to, "notes/idea.md");
        let text = std::fs::read_to_string(v.join("notes/idea.md")).unwrap();
        assert_eq!(vault::fm_get(&text, "type").as_deref(), Some("note"));
        // An ordinary note is never discarded.
        std::fs::write(v.join("notes/plain.md"), "").unwrap();
        assert!(!discard_if_empty(v, "notes/plain.md").unwrap());
    }

    #[test]
    fn sweep_skips_fresh_files() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        let a = create(v, false).unwrap();
        let s = sweep(v, 7, |_| panic!("nothing is old enough to trash")).unwrap();
        assert!(s.removed.is_empty() && s.trashed.is_empty());
        assert!(a.exists());
    }
}
