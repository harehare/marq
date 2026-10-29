//! Links between notes: `[[wikilinks]]` and relative Markdown links, and the backlinks they make.
//!
//! `[[Target]]`, `[[Target|label]]` and `[[Target#Heading]]` name a note by its vault-relative path,
//! file name, title or one of its `aliases:`, without `.md` and ignoring case. Relative links such
//! as `[plan](../docs/plan.md)` keep working as before; both count as links for backlinks.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

use crate::vault::FileEntry;

fn wiki_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|[^\[\]]*)?\]\]").unwrap())
}

fn md_link_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\]\(<?([^)<>]+?\.md)(?:#[^)>]*)?>?\)").unwrap())
}

/// The targets of the `[[wikilinks]]` on a line, as written (trimmed).
pub fn wikilinks(line: &str) -> Vec<&str> {
    wiki_re().captures_iter(line).map(|c| c.get(1).unwrap().as_str().trim()).collect()
}

fn stem(rel: &str) -> &str {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.strip_suffix(".md").unwrap_or(name)
}

/// The note a wikilink target names: its path, then file name, title and aliases, ignoring case.
pub fn resolve<'a>(files: &'a [FileEntry], target: &str) -> Option<&'a FileEntry> {
    let t = target.trim().trim_end_matches(".md").to_lowercase();
    if t.is_empty() {
        return None;
    }
    let by = |f: &dyn Fn(&FileEntry) -> bool| files.iter().find(|e| f(e));
    by(&|f| f.rel.trim_end_matches(".md").to_lowercase() == t)
        .or_else(|| by(&|f| stem(&f.rel).to_lowercase() == t))
        .or_else(|| by(&|f| f.title.as_deref().is_some_and(|x| x.to_lowercase() == t)))
        .or_else(|| by(&|f| f.aliases.iter().any(|a| a.to_lowercase() == t)))
}

/// `dir` + `href`, normalized and vault-relative; None for URLs or a path climbing out of the vault.
fn join(dir: &str, href: &str) -> Option<String> {
    if href.contains("://") {
        return None;
    }
    let href = href.replace("%20", " ");
    let mut parts: Vec<&str> = if href.starts_with('/') { vec![] } else { dir.split('/').filter(|p| !p.is_empty()).collect() };
    for p in href.split('/') {
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

/// Vault-relative paths of the notes a line links to.
fn targets(files: &[FileEntry], from_rel: &str, line: &str) -> Vec<String> {
    let dir = from_rel.rfind('/').map_or("", |i| &from_rel[..i]);
    let wiki = wikilinks(line).into_iter().filter_map(|t| resolve(files, t)).map(|f| f.rel.clone());
    let md = md_link_re().captures_iter(line).filter_map(|c| join(dir, &c[1]));
    wiki.chain(md).collect()
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Ref {
    pub path: String,
    pub rel: String,
    pub title: Option<String>,
    /// 1-based.
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Default, Serialize)]
pub struct Backlinks {
    /// Lines that link to the note.
    pub linked: Vec<Ref>,
    /// Lines that name it (title or an alias) without linking: links waiting to be made.
    pub mentions: Vec<Ref>,
    /// Notes this one links to that exist.
    pub outgoing: Vec<String>,
    /// `[[targets]]` in this note that name no note yet.
    pub missing: Vec<String>,
}

/// Is `name` at `at` in `line` a whole word? CJK names have no spaces around them, so they always count.
fn whole_word(line: &str, at: usize, name: &str) -> bool {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let before = line[..at].chars().next_back().is_none_or(|c| !word(c));
    let after = line[at + name.len()..].chars().next().is_none_or(|c| !word(c));
    !name.is_ascii() || (before && after)
}

/// Links into and out of the note at `rel`. Session logs are left out: they quote everything.
pub fn backlinks(files: &[FileEntry], rel: &str) -> Backlinks {
    let Some(me) = files.iter().find(|f| f.rel == rel) else { return Backlinks::default() };
    let mut names: Vec<String> = me.title.iter().chain(&me.aliases).cloned().collect();
    names.push(stem(rel).to_string());
    let names: Vec<String> = names
        .into_iter()
        .map(|n| n.to_lowercase())
        // Short names would match everywhere.
        .filter(|n| n.chars().count() >= if n.is_ascii() { 4 } else { 2 })
        .collect();
    let mut out = Backlinks::default();
    for f in files.iter().filter(|f| !f.rel.starts_with("sessions/")) {
        let Ok(text) = std::fs::read_to_string(&f.path) else { continue };
        let mut fence = false;
        for (i, line) in crate::vault::split_frontmatter(&text).1.lines().enumerate() {
            if line.trim_start().starts_with("```") {
                fence = !fence;
            }
            if fence {
                continue;
            }
            let to = targets(files, &f.rel, line);
            if f.rel == rel {
                for t in wikilinks(line) {
                    if resolve(files, t).is_none() && !out.missing.iter().any(|m| m.eq_ignore_ascii_case(t)) {
                        out.missing.push(t.to_string());
                    }
                }
                for t in to {
                    if t != rel && !out.outgoing.contains(&t) {
                        out.outgoing.push(t);
                    }
                }
                continue;
            }
            let r = || Ref {
                path: f.path.clone(),
                rel: f.rel.clone(),
                title: f.title.clone(),
                line: i + 1,
                text: line.trim().chars().take(240).collect(),
            };
            if to.iter().any(|t| t == rel) {
                out.linked.push(r());
            } else if out.mentions.len() < 50 {
                let l = line.to_lowercase();
                if names.iter().any(|n| l.match_indices(n.as_str()).any(|(at, _)| whole_word(&l, at, n))) {
                    out.mentions.push(r());
                }
            }
        }
    }
    // Line numbers count from the end of the frontmatter above; make them the file's.
    for r in out.linked.iter_mut().chain(out.mentions.iter_mut()) {
        let text = std::fs::read_to_string(&r.path).unwrap_or_default();
        let fm = text.len() - crate::vault::split_frontmatter(&text).1.len();
        r.line += text[..fm].lines().count();
    }
    out
}

/// Rewrites `[[old]]` to `[[new]]` after a note moved from `old_rel` to `new_rel`, for links that
/// named it by its path or file name. Labels and `#headings` are kept.
pub fn rename_wikilinks(text: &str, old_rel: &str, new_rel: &str) -> String {
    let (old_path, new_path) = (old_rel.trim_end_matches(".md"), new_rel.trim_end_matches(".md"));
    let (old_stem, new_stem) = (stem(old_rel), stem(new_rel));
    let re = Regex::new(r"\[\[([^\[\]|#]+)([^\[\]]*)\]\]").unwrap();
    re.replace_all(text, |c: &regex::Captures| {
        let t = c[1].trim();
        let new = if t.eq_ignore_ascii_case(old_path) && old_path.contains('/') {
            new_path
        } else if t.eq_ignore_ascii_case(old_stem) && old_stem != new_stem {
            new_stem
        } else {
            return c[0].to_string();
        };
        format!("[[{new}{}]]", &c[2])
    })
    .into_owned()
}

/// A new note for a `[[target]]` that names none yet: `notes/<target>.md` with the target as title.
pub fn create_for(vault: &Path, target: &str) -> std::io::Result<std::path::PathBuf> {
    let name = target.trim().trim_end_matches(".md").replace(['\\', ':', '*', '?', '"', '<', '>', '|'], "-");
    let rel = if name.contains('/') { format!("{name}.md") } else { format!("notes/{name}.md") };
    let path = vault.join(&rel);
    if !path.exists() {
        std::fs::create_dir_all(path.parent().unwrap())?;
        let title = name.rsplit('/').next().unwrap_or(&name);
        std::fs::write(
            &path,
            format!("---\nid: {}\ntitle: {}\ncreated: {}\n---\n# {title}\n\n", crate::vault::new_id(), serde_json::to_string(title).unwrap(), crate::vault::now()),
        )?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::list_files;

    #[test]
    fn parses_wikilinks() {
        assert_eq!(wikilinks("see [[Auth]] and [[docs/plan#Steps|the plan]]"), vec!["Auth", "docs/plan"]);
        assert!(wikilinks("[not] [a link]").is_empty());
    }

    #[test]
    fn resolves_and_finds_backlinks() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        std::fs::create_dir_all(v.join("notes")).unwrap();
        std::fs::write(v.join("notes/auth.md"), "---\ntitle: 認証\naliases: [login]\n---\n# 認証\n[[Missing note]] and [[db]]\n").unwrap();
        std::fs::write(v.join("notes/db.md"), "# DB\n").unwrap();
        std::fs::write(v.join("a.md"), "x\nuses [[認証]]\n").unwrap();
        std::fs::write(v.join("b.md"), "[auth](notes/auth.md)\n").unwrap();
        std::fs::write(v.join("c.md"), "the login flow\nlogins are not words\n認証まわり\n```\n[[login]]\n```\n").unwrap();
        let files = list_files(v);
        assert_eq!(resolve(&files, "LOGIN").unwrap().rel, "notes/auth.md");
        assert_eq!(resolve(&files, "notes/auth").unwrap().rel, "notes/auth.md");
        assert!(resolve(&files, "nothing").is_none());

        let b = backlinks(&files, "notes/auth.md");
        assert_eq!(b.linked.iter().map(|r| (r.rel.as_str(), r.line)).collect::<Vec<_>>(), vec![("a.md", 2), ("b.md", 1)]);
        assert_eq!(b.mentions.iter().map(|r| r.line).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(b.outgoing, vec!["notes/db.md"]);
        assert_eq!(b.missing, vec!["Missing note"]);
    }

    #[test]
    fn renames_links() {
        let t = "[[old]] [[Old#H|label]] [[notes/old]] [[other]]";
        assert_eq!(rename_wikilinks(t, "notes/old.md", "notes/new.md"), "[[new]] [[new#H|label]] [[notes/new]] [[other]]");
        assert_eq!(rename_wikilinks(t, "notes/old.md", "archive/old.md"), "[[old]] [[Old#H|label]] [[archive/old]] [[other]]");
    }
}
