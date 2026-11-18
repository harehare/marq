//! Comments left in notes: `<!-- comment: text -->` on a line of its own, `<!-- comment (sent): text -->`
//! once an agent was asked. The app reads the same lines (src/comments.ts); this lists them for agents.

use std::path::Path;

use serde::Serialize;

use crate::vault;

#[derive(Debug, PartialEq, Serialize)]
pub struct Comment {
    /// Vault-relative path of the note.
    pub path: String,
    /// 1-based line of the comment.
    pub line: usize,
    pub text: String,
    /// An agent was already asked to act on it.
    pub sent: bool,
    /// The comment mentions @marq.
    pub mention: bool,
    /// The text the comment is under: the block above it (or below, when the comment opens the note).
    pub about: String,
}

fn parse(line: &str) -> Option<(String, bool)> {
    let rest = line.trim().strip_prefix("<!-- comment")?.strip_suffix(" -->")?;
    let (sent, text) = match rest.strip_prefix(" (sent):") {
        Some(t) => (true, t),
        None => (false, rest.strip_prefix(':')?),
    };
    Some((text.trim().to_string(), sent))
}

fn mentions(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.match_indices("@marq").any(|(i, m)| {
        let before = lower[..i].chars().next_back().map_or(true, char::is_whitespace);
        let after = lower[i + m.len()..].chars().next().map_or(true, |c| !(c.is_alphanumeric() || c == '_'));
        before && after
    })
}

fn skippable(l: &str) -> bool {
    l.trim().is_empty() || parse(l).is_some()
}

/// The block of text a comment is about, as the agent would be given it.
fn subject(lines: &[&str], at: usize) -> String {
    let mut i = at;
    let mut found = None;
    while i > 0 {
        i -= 1;
        if !skippable(lines[i]) {
            found = Some(i);
            break;
        }
    }
    let found = found.or_else(|| (at + 1..lines.len()).find(|&j| !skippable(lines[j])));
    let Some(n) = found else { return String::new() };
    let (mut from, mut to) = (n, n);
    while from > 0 && !skippable(lines[from - 1]) {
        from -= 1;
    }
    while to + 1 < lines.len() && !skippable(lines[to + 1]) {
        to += 1;
    }
    let text = lines[from..=to].join("\n");
    if text.chars().count() > 600 { format!("{}…", text.chars().take(600).collect::<String>()) } else { text }
}

/// The comments in one note, outside the frontmatter and fenced code.
pub fn in_note(rel: &str, text: &str) -> Vec<Comment> {
    let lines: Vec<&str> = text.lines().collect();
    let mut start = 0;
    if lines.first() == Some(&"---") {
        if let Some(end) = lines.iter().skip(1).position(|l| *l == "---") {
            start = end + 2;
        }
    }
    let mut out = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for i in start..lines.len() {
        let l = lines[i];
        let t = l.trim_start_matches(' ');
        if l.len() - t.len() <= 3 {
            let ch = t.chars().next().filter(|c| *c == '`' || *c == '~');
            let n = ch.map_or(0, |c| t.chars().take_while(|x| *x == c).count());
            if let (Some(c), true) = (ch, n >= 3) {
                match fence {
                    None => fence = Some((c, n)),
                    Some((fc, fl)) if fc == c && n >= fl => fence = None,
                    _ => {}
                }
                continue;
            }
        }
        if fence.is_some() {
            continue;
        }
        if let Some((text, sent)) = parse(l) {
            let mention = mentions(&text);
            out.push(Comment { path: rel.to_string(), line: i + 1, text, sent, mention, about: subject(&lines, i) });
        }
    }
    out
}

/// Comments across the vault, or in `only`. `status` is `open` (not sent yet, the default), `sent` or `all`;
/// `mention` keeps only the ones that mention @marq.
pub fn list(vault: &Path, only: Option<&Path>, status: &str, mention: bool) -> Vec<Comment> {
    let keep = |c: &Comment| (match status { "sent" => c.sent, "all" => true, _ => !c.sent }) && (!mention || c.mention);
    let mut out = Vec::new();
    for f in vault::list_files(vault) {
        // Session transcripts quote notes, and are not notes themselves.
        if f.kind.as_deref() == Some("file") || !f.rel.ends_with(".md") || f.rel.starts_with("sessions/") {
            continue;
        }
        if only.is_some_and(|o| o != Path::new(&f.path)) {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&f.path) {
            out.extend(in_note(&f.rel, &text).into_iter().filter(keep));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_comments_outside_code_and_frontmatter() {
        let text = "---\ntitle: x\n<!-- comment: not here -->\n---\n# A\n\nfoo\nbar\n\n<!-- comment: @marq fix this -->\n\n<!-- comment (sent): done -->\n\n```\n<!-- comment: in code -->\n```\n";
        let c = in_note("a.md", text);
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].line, c[0].sent, c[0].mention), (10, false, true));
        assert_eq!(c[0].about, "foo\nbar");
        assert!(c[1].sent && !c[1].mention);
    }

    #[test]
    fn mention_needs_a_word_boundary() {
        assert!(mentions("please @marq, look"));
        assert!(!mentions("mail me@marq.dev"));
        assert!(!mentions("@marqs"));
    }
}
