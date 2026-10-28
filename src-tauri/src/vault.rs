//! Vault file access and in-place edits of frontmatter and markers (SPEC §3, §4).

use std::path::{Path, PathBuf};

use regex::Regex;
use serde::Serialize;

use crate::error::{Error, Result};

/// A Markdown file in the vault.
#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub path: String,
    /// The frontmatter `id`, if any. The sidebar matches crew sessions to crew notes by it.
    pub id: Option<String>,
    pub rel: String,
    pub title: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
}

/// Lists Markdown files under `vault`, skipping dot directories (`.marq`, `.raw`, `.git`).
pub fn list_files(vault: &Path) -> Vec<FileEntry> {
    let mut files: Vec<FileEntry> = walkdir::WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|x| x == "md"))
        .map(|e| {
            let text = std::fs::read_to_string(e.path()).unwrap_or_default();
            FileEntry {
                path: e.path().to_string_lossy().into_owned(),
                rel: e.path().strip_prefix(vault).unwrap_or(e.path()).to_string_lossy().into_owned(),
                id: fm_get(&text, "id").filter(|s| !s.is_empty()),
                title: fm_get(&text, "title").filter(|s| !s.is_empty()),
                kind: fm_get(&text, "type"),
                status: fm_get(&text, "status"),
            }
        })
        .collect();
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    files
}

/// Resolves `path` and rejects anything outside `vault`.
pub fn resolve(vault: &Path, path: &str) -> Result<PathBuf> {
    let p = Path::new(path);
    let p = if p.is_absolute() { p.to_path_buf() } else { vault.join(p) };
    let vault = vault.canonicalize()?;
    let parent = p.parent().ok_or_else(|| Error::OutsideVault(path.to_string()))?;
    let parent = parent.canonicalize()?;
    if !parent.starts_with(&vault) {
        return Err(Error::OutsideVault(path.to_string()));
    }
    Ok(parent.join(p.file_name().unwrap_or_default()))
}

/// Expands a leading `~/`.
pub fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => PathBuf::from(path),
    }
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub fn now() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string()
}

/// Splits a document into its frontmatter body (without `---` lines) and the rest.
pub fn split_frontmatter(text: &str) -> (Option<&str>, &str) {
    let Some(rest) = text.strip_prefix("---\n") else {
        return (None, text);
    };
    match rest.find("\n---\n") {
        Some(end) => (Some(&rest[..end]), &rest[end + 5..]),
        None if rest.ends_with("\n---") => (Some(&rest[..rest.len() - 4]), ""),
        None => (None, text),
    }
}

/// Reads a top-level scalar key. Only `key: value` lines are recognized, which covers marq's own keys.
pub fn fm_get(text: &str, key: &str) -> Option<String> {
    let (fm, _) = split_frontmatter(text);
    fm?.lines().find_map(|l| {
        let v = l.strip_prefix(key)?.strip_prefix(':')?.trim();
        Some(v.trim_matches(['"', '\'']).to_string())
    })
}

/// Sets a top-level key, keeping every other line as written. Adds a frontmatter block if missing.
pub fn fm_set(text: &str, key: &str, value: &str) -> String {
    let line = format!("{key}: {value}");
    match split_frontmatter(text) {
        (Some(fm), body) => {
            let mut found = false;
            let mut lines: Vec<String> = fm
                .lines()
                .map(|l| {
                    if l.strip_prefix(key).is_some_and(|r| r.starts_with(':')) {
                        found = true;
                        line.clone()
                    } else {
                        l.to_string()
                    }
                })
                .collect();
            if !found {
                lines.push(line);
            }
            format!("---\n{}\n---\n{}", lines.join("\n"), body)
        }
        (None, body) => format!("---\n{line}\n---\n{body}"),
    }
}

/// Moves a file to the Trash. On macOS this uses NSFileManager: the crate's default asks Finder
/// through osascript, which is slow and can wait on an automation permission prompt.
pub fn move_to_trash(path: &Path) -> Result<()> {
    let mut ctx = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete(path)
        .map_err(|e| Error::Other(format!("could not move {} to the Trash: {e}", path.display())))
}

/// A file-name slug: alphanumerics (any script) joined by `-`, at most 8 words, lowercase.
pub fn slug(title: &str) -> String {
    let s = title
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();
    if s.is_empty() { "untitled".into() } else { s }
}

/// `dir/<date>-<slug>.md`, with `-2`, `-3`… added when the name is taken. Relative to `vault`.
pub fn unique_path(vault: &Path, dir: &str, title: &str) -> String {
    let today = &now()[..10];
    let dir = dir.trim_matches('/');
    let base = format!("{dir}/{today}-{}", slug(title));
    let mut rel = format!("{base}.md");
    let mut n = 2;
    while vault.join(&rel).exists() {
        rel = format!("{base}-{n}.md");
        n += 1;
    }
    rel
}

/// Where a document from Claude went.
#[derive(Debug, Serialize)]
pub struct SavedDoc {
    pub rel: String,
    pub title: String,
    pub created: bool,
}

/// Saves a document written by Claude (SPEC §14). A new one goes to `folder` (default `docs`).
/// `path` updates an existing doc, but only one with `type: doc`, so hand-written notes are never
/// overwritten.
pub fn write_doc(
    vault: &Path,
    title: &str,
    content: &str,
    folder: Option<&str>,
    path: Option<&str>,
    session: &str,
    origin: &str,
) -> Result<SavedDoc> {
    let body = content.trim();
    // Drop frontmatter Claude may have added; marq writes its own.
    let body = split_frontmatter(&format!("{body}\n")).1.trim().to_string();
    let now = now();
    if let Some(p) = path.filter(|p| !p.is_empty()) {
        let full = resolve(vault, p)?;
        if full.exists() {
            let old = std::fs::read_to_string(&full)?;
            if fm_get(&old, "type").as_deref() != Some("doc") {
                return Err(Error::Other(format!("{p} is not a document written by Claude, so it is left as is")));
            }
            let fm = split_frontmatter(&old).0.unwrap_or_default();
            let t = fm_set(&format!("---\n{fm}\n---\n{body}\n"), "updated", &now);
            let t = fm_set(&t, "title", &serde_json::to_string(title).unwrap());
            std::fs::write(&full, fm_push(&t, "sessions", session))?;
            let rel = full.strip_prefix(vault.canonicalize()?).unwrap_or(&full).to_string_lossy().into_owned();
            return Ok(SavedDoc { rel, title: title.into(), created: false });
        }
    }
    let folder = folder.map(|f| f.trim_matches('/')).filter(|f| !f.is_empty() && !f.contains("..")).unwrap_or("docs");
    let rel = match path.filter(|p| !p.is_empty()) {
        Some(p) => if p.ends_with(".md") { p.to_string() } else { format!("{p}.md") },
        None => unique_path(vault, folder, title),
    };
    let full = vault.join(&rel);
    std::fs::create_dir_all(full.parent().unwrap())?;
    let full = resolve(vault, &rel)?;
    let text = format!(
        "---\nid: {}\ntype: doc\ntitle: {}\ncreated: {now}\nupdated: {now}\nsessions: [{session}]\norigin: {origin}\n---\n{body}\n",
        new_id(),
        serde_json::to_string(title).unwrap(),
    );
    std::fs::write(&full, text)?;
    Ok(SavedDoc { rel, title: title.into(), created: true })
}

/// Removes `item` from a flow-style list key such as `sessions: [a, b]`.
pub fn fm_remove_item(text: &str, key: &str, item: &str) -> String {
    let Some(v) = fm_get(text, key) else { return text.to_string() };
    let items: Vec<&str> = v
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != item)
        .collect();
    fm_set(text, key, &format!("[{}]", items.join(", ")))
}

/// Returns the note id, assigning one if the note has none.
pub fn ensure_id(text: &str) -> (String, String) {
    match fm_get(text, "id") {
        Some(id) if !id.is_empty() => (id, text.to_string()),
        _ => {
            let id = new_id();
            (id.clone(), fm_set(text, "id", &id))
        }
    }
}

/// Appends `item` to a flow-style list key such as `sessions: [a, b]`.
pub fn fm_push(text: &str, key: &str, item: &str) -> String {
    let items = fm_get(text, key)
        .map(|v| v.trim_start_matches('[').trim_end_matches(']').to_string())
        .unwrap_or_default();
    let mut items: Vec<&str> = items.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    items.push(item);
    fm_set(text, key, &format!("[{}]", items.join(", ")))
}

/// Removes the result block written for `session`, with the blank line before it.
pub fn remove_result(text: &str, session: &str) -> String {
    let re = Regex::new(&format!(
        r#"(?s)\n*<!-- claude:result session="{}" -->.*?<!-- /claude:result -->"#,
        regex::escape(session)
    ))
    .unwrap();
    re.replace(text, "").into_owned()
}

/// Removes pinned mq output. It is a copy of query results, not content, so queries must not see it
/// (a query over its own note would otherwise find its earlier results again).
pub fn strip_pinned(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pinned = false;
    for line in text.split_inclusive('\n') {
        match line.trim() {
            "<!-- mq:output -->" if !pinned => pinned = true,
            "<!-- /mq:output -->" if pinned => pinned = false,
            _ if !pinned => out.push_str(line),
            _ => {}
        }
    }
    out
}

/// Writes `output` right after the fenced block that opens at `line` (0-based), between
/// `<!-- mq:output -->` markers, replacing an existing pinned output (SPEC §6).
pub fn pin_output(text: &str, line: usize, output: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let open = lines.get(line)?.trim_start();
    let ticks = open.len() - open.trim_start_matches('`').len();
    if ticks < 3 {
        return None;
    }
    let close = (line + 1..lines.len()).find(|&i| {
        let l = lines[i].trim();
        l.len() >= ticks && l.chars().all(|c| c == '`')
    })?;
    let mut after = close + 1;
    while after < lines.len() && lines[after].trim().is_empty() {
        after += 1;
    }
    let end = if lines.get(after).is_some_and(|l| l.trim() == "<!-- mq:output -->") {
        (after..lines.len()).find(|&i| lines[i].trim() == "<!-- /mq:output -->").map(|i| i + 1)?
    } else {
        close + 1
    };
    let mut out: Vec<String> = lines[..=close].iter().map(|s| s.to_string()).collect();
    out.push(String::new());
    out.push("<!-- mq:output -->".into());
    out.push(output.trim_end().to_string());
    out.push("<!-- /mq:output -->".into());
    if end < lines.len() && !lines[end].trim().is_empty() {
        out.push(String::new());
    }
    out.extend(lines[end..].iter().map(|s| s.to_string()));
    Some(out.join("\n") + "\n")
}

/// One `context:` entry of a request (SPEC §3).
#[derive(Debug, PartialEq)]
pub enum ContextItem {
    Note(String),
    Query { query: String, from: String },
}

/// Reads the `context:` list from the frontmatter. Unknown entries are skipped.
pub fn context_items(text: &str) -> Vec<ContextItem> {
    use yaml_rust2::{Yaml, YamlLoader};
    let Some(fm) = split_frontmatter(text).0 else { return vec![] };
    let Ok(docs) = YamlLoader::load_from_str(fm) else { return vec![] };
    let Some(Yaml::Array(items)) = docs.first().map(|d| &d["context"]) else { return vec![] };
    items
        .iter()
        .filter_map(|i| match (i["note"].as_str(), i["query"].as_str(), i["from"].as_str()) {
            (Some(n), _, _) => Some(ContextItem::Note(n.to_string())),
            (None, Some(q), Some(f)) => Some(ContextItem::Query { query: q.to_string(), from: f.to_string() }),
            _ => None,
        })
        .collect()
}

/// Finds a note by its frontmatter id or vault-relative path.
pub fn find_note(vault: &Path, note: &str) -> Option<PathBuf> {
    resolve(vault, note).ok().filter(|p| p.is_file()).or_else(|| {
        list_files(vault)
            .into_iter()
            .map(|f| PathBuf::from(f.path))
            .find(|f| std::fs::read_to_string(f).is_ok_and(|t| fm_get(&t, "id").as_deref() == Some(note)))
    })
}

fn heading_level(line: &str) -> Option<usize> {
    let n = line.bytes().take_while(|&b| b == b'#').count();
    (1..=6).contains(&n).then(|| line.as_bytes().get(n)).flatten().filter(|&&b| b == b' ').map(|_| n)
}

/// A heading section: the heading line up to the next heading at the same or higher level.
#[derive(Debug, Clone, Serialize)]
pub struct Section {
    /// 0-based line of the heading, or of the first body line when the section has no heading.
    pub start: usize,
    /// Exclusive end line.
    pub end: usize,
    pub title: String,
    pub text: String,
}

/// Finds the section that contains `line` (0-based). Code fences are skipped when looking for headings.
pub fn section_at(text: &str, line: usize) -> Section {
    let lines: Vec<&str> = text.lines().collect();
    let body_start = text.len() - split_frontmatter(text).1.len();
    let first = text[..body_start].lines().count();
    let mut in_fence = false;
    let headings: Vec<(usize, usize)> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| {
            if l.trim_start().starts_with("```") {
                in_fence = !in_fence;
            }
            (i >= first && !in_fence).then(|| heading_level(l).map(|lv| (i, lv))).flatten()
        })
        .collect();
    let (start, level) = headings.iter().rev().find(|(i, _)| *i <= line).copied().unwrap_or((first, 7));
    let end = headings
        .iter()
        .find(|(i, lv)| *i > start && *lv <= level)
        .map(|(i, _)| *i)
        .unwrap_or(lines.len());
    let title = if level <= 6 {
        lines[start].trim_start_matches('#').trim().to_string()
    } else {
        fm_get(text, "title").unwrap_or_default()
    };
    Section { start, end, title, text: lines[start..end].join("\n") }
}

fn anchor_re() -> Regex {
    Regex::new(r#"<!-- claude:anchor id="([^"]+)" -->"#).unwrap()
}

/// Anchor markers in a note, with their 0-based line.
#[derive(Debug, Serialize)]
pub struct Anchor {
    pub id: String,
    pub line: usize,
}

pub fn anchors(text: &str) -> Vec<Anchor> {
    let re = anchor_re();
    text.lines()
        .enumerate()
        .filter_map(|(i, l)| re.captures(l).map(|c| Anchor { id: c[1].to_string(), line: i }))
        .collect()
}

/// Returns the anchor id of the section at `line`, inserting a marker after the heading if there is none.
pub fn ensure_anchor(text: &str, section: &Section) -> (String, String) {
    let re = anchor_re();
    let lines: Vec<&str> = text.lines().collect();
    if let Some(c) = lines[section.start..section.end].iter().find_map(|l| re.captures(l)) {
        return (c[1].to_string(), text.to_string());
    }
    let id = new_id();
    let mut out: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
    // Under the heading, or at the top of the body when the section has none.
    let has_heading = lines.get(section.start).is_some_and(|l| heading_level(l).is_some());
    let at = (section.start + usize::from(has_heading)).min(out.len());
    out.insert(at, format!("<!-- claude:anchor id=\"{id}\" -->"));
    (id, out.join("\n") + "\n")
}

/// Replaces the result block for `session`, or adds one: under `## Result` for requests,
/// otherwise at the end of the section that holds `anchor`.
pub fn write_result(text: &str, anchor: Option<&str>, session: &str, body: &str) -> String {
    let block = format!("<!-- claude:result session=\"{session}\" -->\n{}\n<!-- /claude:result -->", body.trim());
    let re = Regex::new(&format!(
        r#"(?s)<!-- claude:result session="{}" -->.*?<!-- /claude:result -->"#,
        regex::escape(session)
    ))
    .unwrap();
    if re.is_match(text) {
        return re.replace(text, regex::NoExpand(&block)).into_owned();
    }
    let lines: Vec<&str> = text.lines().collect();
    let insert_at = match anchor.and_then(|a| anchors(text).into_iter().find(|x| x.id == a)) {
        Some(a) => section_at(text, a.line).end,
        None => {
            if !lines.iter().any(|l| l.trim() == "## Result") {
                return format!("{}\n\n## Result\n\n{block}\n", text.trim_end());
            }
            section_at(text, lines.iter().position(|l| l.trim() == "## Result").unwrap()).end
        }
    };
    let mut out: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
    // Replace the blank lines before the next heading so spacing stays at one blank line.
    let mut at = insert_at;
    while at > 0 && out[at - 1].trim().is_empty() {
        at -= 1;
    }
    let mut block = vec!["".to_string(), block];
    if insert_at < out.len() {
        block.push("".to_string());
    }
    out.splice(at..insert_at, block);
    out.join("\n").trim_end().to_string() + "\n"
}

/// One file's lines that contain every word of a search, case-insensitively.
#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub rel: String,
    pub title: Option<String>,
    /// (1-based line, text).
    pub lines: Vec<(usize, String)>,
    /// More lines matched than are listed.
    pub more: usize,
}

/// Full-text search over the vault's notes. `sessions/` only when asked, since logs are large.
pub fn grep(vault: &Path, query: &str, include_sessions: bool, max_files: usize, per_file: usize) -> Vec<SearchHit> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return vec![];
    }
    let mut out = vec![];
    for f in list_files(vault) {
        if !include_sessions && f.rel.starts_with("sessions/") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&f.path) else { continue };
        let (mut lines, mut more) = (vec![], 0);
        for (i, line) in content.lines().enumerate() {
            let l = line.to_lowercase();
            if words.iter().all(|w| l.contains(w.as_str())) {
                if lines.len() < per_file {
                    lines.push((i + 1, line.trim().chars().take(240).collect()));
                } else {
                    more += 1;
                }
            }
        }
        if !lines.is_empty() {
            out.push(SearchHit { path: f.path, rel: f.rel, title: f.title, lines, more });
            if out.len() >= max_files {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn grep_matches_every_word_and_skips_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        std::fs::create_dir_all(v.join("sessions")).unwrap();
        std::fs::write(v.join("a.md"), "# A\nhover types in LSP\nhover only\n").unwrap();
        std::fs::write(v.join("sessions/s.md"), "hover types\n").unwrap();
        let hits = grep(v, "Types hover", false, 10, 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].lines, vec![(2, "hover types in LSP".to_string())]);
        assert_eq!(grep(v, "hover types", true, 10, 10).len(), 2);
    }

    use super::*;

    const NOTE: &str = "---\nid: n1\ntitle: t\n---\n# A\n\nintro\n\n## B\n\nbody b\n\n```\n# not heading\n```\n\n## C\n\nbody c\n";

    #[test]
    fn frontmatter_roundtrip() {
        assert_eq!(fm_get(NOTE, "id").as_deref(), Some("n1"));
        let s = fm_set(NOTE, "status", "running");
        assert_eq!(fm_get(&s, "status").as_deref(), Some("running"));
        assert!(s.ends_with("body c\n"));
        let s = fm_push(&fm_push(&s, "sessions", "a"), "sessions", "b");
        assert_eq!(fm_get(&s, "sessions").as_deref(), Some("[a, b]"));
        assert_eq!(fm_get(&fm_remove_item(&s, "sessions", "a"), "sessions").as_deref(), Some("[b]"));
        assert_eq!(fm_get(&fm_set("# x\n", "id", "z"), "id").as_deref(), Some("z"));
    }

    #[test]
    fn anchor_without_heading_or_body() {
        let only_fm = "---\nid: n\n---\n";
        let (id, t) = ensure_anchor(only_fm, &section_at(only_fm, 0));
        assert!(t.ends_with(&format!("---\n<!-- claude:anchor id=\"{id}\" -->\n")));
        let no_heading = "---\nid: n\n---\nplain text\nmore\n";
        let (id, t) = ensure_anchor(no_heading, &section_at(no_heading, 0));
        assert!(t.contains(&format!("---\n<!-- claude:anchor id=\"{id}\" -->\nplain text")));
        assert!(section_at("", 0).text.is_empty());
    }

    #[test]
    fn docs_go_to_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        let d = write_doc(v, "API 設計メモ", "---\nfoo: 1\n---\n# Plan\n\nbody", None, None, "s1", "o1").unwrap();
        assert!(d.created && d.rel.starts_with("docs/") && d.rel.ends_with("-api-設計メモ.md"), "{}", d.rel);
        let t = std::fs::read_to_string(v.join(&d.rel)).unwrap();
        assert_eq!(fm_get(&t, "type").as_deref(), Some("doc"));
        assert!(t.contains("# Plan\n\nbody") && !t.contains("foo: 1"));

        let again = write_doc(v, "API 設計メモ", "# Plan v2", None, Some(&d.rel), "s2", "o1").unwrap();
        assert!(!again.created && again.rel == d.rel);
        let t = std::fs::read_to_string(v.join(&d.rel)).unwrap();
        assert!(t.contains("# Plan v2") && t.contains("sessions: [s1, s2]"));

        std::fs::write(v.join("mine.md"), "---\ntype: note\n---\nhand written\n").unwrap();
        assert!(write_doc(v, "x", "y", None, Some("mine.md"), "s", "o").is_err());
        assert!(write_doc(v, "x", "y", None, Some("../outside.md"), "s", "o").is_err());
        let other = write_doc(v, "Weekly", "z", Some("reports"), None, "s", "o").unwrap();
        assert!(other.rel.starts_with("reports/"));
    }

    #[test]
    fn strips_pinned_output() {
        let t = "# a\n\n```mq\n.h1\n```\n\n<!-- mq:output -->\n# a\n<!-- /mq:output -->\n\nafter\n";
        assert_eq!(strip_pinned(t), "# a\n\n```mq\n.h1\n```\n\n\nafter\n");
        assert_eq!(strip_pinned("plain\n"), "plain\n");
    }

    #[test]
    fn pins_mq_output() {
        let t = "# a\n\n```mq\n.h1\n```\n\nafter\n";
        let once = pin_output(t, 2, "# a").unwrap();
        assert_eq!(once, "# a\n\n```mq\n.h1\n```\n\n<!-- mq:output -->\n# a\n<!-- /mq:output -->\n\nafter\n");
        let twice = pin_output(&once, 2, "# b").unwrap();
        assert_eq!(twice, once.replace("<!-- mq:output -->\n# a", "<!-- mq:output -->\n# b"));
        assert!(pin_output(t, 0, "x").is_none());
    }

    #[test]
    fn reads_context_items() {
        let t = "---\nid: r\ncontext:\n  - note: abc\n  - query: 'section::find(\"Design\")'\n    from: notes/a.md\n  - bogus: 1\n---\nbody\n";
        assert_eq!(
            context_items(t),
            vec![
                ContextItem::Note("abc".into()),
                ContextItem::Query { query: r#"section::find("Design")"#.into(), from: "notes/a.md".into() },
            ]
        );
        assert!(context_items("# no fm\n").is_empty());
    }

    #[test]
    fn sections_skip_fences() {
        let s = section_at(NOTE, 13);
        assert_eq!(s.title, "B");
        assert!(s.text.contains("# not heading"));
        assert!(!s.text.contains("## C"));
        assert_eq!(section_at(NOTE, 6).title, "A");
        assert!(section_at(NOTE, 6).text.contains("## C"));
    }

    #[test]
    fn anchor_and_result() {
        let sec = section_at(NOTE, 10);
        let (id, text) = ensure_anchor(NOTE, &sec);
        assert_eq!(anchors(&text)[0].id, id);
        let (id2, _) = ensure_anchor(&text, &section_at(&text, 11));
        assert_eq!(id, id2);
        let text = write_result(&text, Some(&id), "s1", "done");
        let c = text.find("## C").unwrap();
        assert!(text.find("claude:result").unwrap() < c);
        let text = write_result(&text, Some(&id), "s1", "again");
        assert!(text.contains("again") && !text.contains("done\n"));
        let removed = remove_result(&text, "s1");
        assert!(!removed.contains("claude:result") && removed.contains("```\n\n## C"));
        let req = write_result("---\nid: r\n---\n## Request\nx\n", None, "s2", "ok");
        assert!(req.contains("## Result\n\n<!-- claude:result session=\"s2\" -->\nok"));
    }
}
