//! `[[Note]]` and `[[Note#Heading]]` in a prompt: the notes (or sections) are attached for the agent.
//!
//! The session log keeps the prompt as typed; only what goes to the agent carries the notes, after
//! the prompt, each in a `<note>` block with its path. A note too long to inline is named instead,
//! for the agent to read with `read_note`.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

use crate::{links, vault};

/// Notes longer than this (in characters) are named, not inlined.
const MAX_INLINE: usize = 20_000;

fn re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\[\]|#\n]+)(?:#([^\[\]|\n]*))?(?:\|[^\[\]\n]*)?\]\]").unwrap())
}

/// The lines under the heading named `name` (any level, ignoring case), up to the next heading of
/// the same or a higher level. Headings inside code fences are ignored.
fn section(body: &str, name: &str) -> Option<String> {
    let want = name.trim().to_lowercase();
    let mut fence = false;
    let mut found: Option<usize> = None;
    let mut out = vec![];
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            fence = !fence;
        }
        let level = if fence { 0 } else { line.chars().take_while(|c| *c == '#').count() };
        let is_heading = (1..=6).contains(&level) && line[level..].starts_with(' ');
        if let Some(l) = found {
            if is_heading && level <= l {
                break;
            }
            out.push(line);
        } else if is_heading && line[level..].trim().to_lowercase() == want {
            found = Some(level);
            out.push(line);
        }
    }
    found.map(|_| out.join("\n").trim().to_string())
}

/// `prompt` with the notes its `[[links]]` name attached after it; unchanged when it names none.
pub fn attach(vault: &Path, prompt: &str) -> String {
    let mut seen = vec![];
    let refs: Vec<(String, Option<String>)> = re()
        .captures_iter(prompt)
        .map(|c| (c[1].trim().to_string(), c.get(2).map(|h| h.as_str().trim().to_string()).filter(|h| !h.is_empty())))
        .filter(|r| {
            let new = !seen.contains(r);
            if new {
                seen.push(r.clone());
            }
            new
        })
        .collect();
    if refs.is_empty() {
        return prompt.to_string();
    }
    let files = vault::list_files(vault);
    let mut blocks = vec![];
    for (target, heading) in refs {
        let Some(f) = links::resolve(&files, &target) else {
            blocks.push(format!("<note missing=\"{target}\">No note by that name; search for it with search_notes if it matters.</note>"));
            continue;
        };
        let text = std::fs::read_to_string(&f.path).unwrap_or_default();
        let body = vault::split_frontmatter(&text).1.trim().to_string();
        let attr = |extra: &str| format!("path=\"{}\"{extra}", f.rel);
        let (attrs, content) = match &heading {
            Some(h) => match section(&body, h) {
                Some(s) => (attr(&format!(" section=\"{h}\"")), s),
                None => (attr(&format!(" section=\"{h}\" missing_section=\"true\"")), body),
            },
            None => (attr(""), body),
        };
        if content.chars().count() > MAX_INLINE {
            blocks.push(format!("<note {attrs} too_long=\"true\">Too long to include here; read it with read_note(\"{}\").</note>", f.rel));
        } else {
            blocks.push(format!("<note {attrs}>\n{content}\n</note>"));
        }
    }
    format!(
        "{prompt}\n\n---\nNotes from the user's Marq vault that the message above refers to with [[...]]:\n\n{}",
        blocks.join("\n\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attaches_notes_and_sections() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        std::fs::create_dir_all(v.join("notes")).unwrap();
        std::fs::write(v.join("notes/plan.md"), "---\ntitle: Plan\n---\n# Plan\n\nIntro\n\n## Risks\n\nSlow CI\n\n### Detail\n\nmore\n\n## Next\n\nlater\n").unwrap();
        let out = attach(v, "Check [[Plan#Risks]] and [[notes/plan]] and [[Nope]], again [[Plan#Risks]]");
        assert!(out.starts_with("Check [[Plan#Risks]]"));
        assert!(out.contains("<note path=\"notes/plan.md\" section=\"Risks\">\n## Risks\n\nSlow CI\n\n### Detail\n\nmore\n</note>"));
        assert!(out.contains("<note path=\"notes/plan.md\">\n# Plan"));
        assert!(out.contains("<note missing=\"Nope\">"));
        assert_eq!(out.matches("section=\"Risks\"").count(), 1);
        assert_eq!(attach(v, "no links here"), "no links here");
    }

    #[test]
    fn section_ignores_code_fences() {
        let body = "# A\n\n```\n# not a heading\n```\n\n# B\n\nb";
        assert_eq!(section(body, "a").unwrap(), "# A\n\n```\n# not a heading\n```");
    }
}
