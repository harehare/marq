//! Vault file access and in-place edits of frontmatter and markers.

use std::path::{Path, PathBuf};

use regex::Regex;
use serde::Serialize;

use crate::error::{Error, Result};
use crate::thesaurus::{Query, Thesaurus};

/// A Markdown file in the vault.
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub path: String,
    /// The frontmatter `id`, if any.
    pub id: Option<String>,
    pub rel: String,
    pub title: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    /// From the frontmatter `tags:` (without `#`).
    pub tags: Vec<String>,
    /// Other names for the note, from `aliases:`; the thesaurus treats them like its title.
    pub aliases: Vec<String>,
    /// When the file was last changed, in milliseconds since the epoch; the sidebar can sort by it.
    pub modified: u64,
    /// The frontmatter `project:` as written: a request's, a session's, a workspace's.
    pub project: Option<String>,
    /// The frontmatter `workspace:` as written (a path, id or title); see [`workspace_names`].
    pub workspace: Option<String>,
    /// When it was started or created, from `started:` or `created:`.
    pub created: Option<String>,
    /// What it was made for, from `origin:`: a document's or a session's request or anchor id.
    pub origin: Option<String>,
    /// The frontmatter keys of the user's own (`[organize] keys`) the file sets, with their values.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub fields: std::collections::BTreeMap<String, Vec<String>>,
}

/// Sets a list-valued key to `values` as `key: ["a", "b"]`, or takes the key out when there are
/// none. A list written as a block (`key:` with `- item` lines under it) is replaced whole.
pub fn fm_set_list(text: &str, key: &str, values: &[String]) -> String {
    let line = (!values.is_empty())
        .then(|| format!("{key}: [{}]", values.iter().map(|v| serde_json::to_string(v).unwrap()).collect::<Vec<_>>().join(", ")));
    let (Some(fm), body) = split_frontmatter(text) else {
        return match line {
            Some(l) => format!("---\n{l}\n---\n{text}"),
            None => text.to_string(),
        };
    };
    let (mut lines, mut in_block, mut placed) = (Vec::<String>::new(), false, false);
    for l in fm.lines() {
        if l.strip_prefix(key).is_some_and(|r| r.starts_with(':')) {
            (in_block, placed) = (true, true);
            lines.extend(line.clone());
        } else if !(in_block && (l.starts_with([' ', '\t']) || l.starts_with("- "))) {
            in_block = false;
            lines.push(l.to_string());
        }
    }
    if !placed {
        lines.extend(line);
    }
    format!("---\n{}\n---\n{}", lines.join("\n"), body)
}

/// A change to what a note or session is filed under.
#[derive(Debug, Default)]
pub struct Refile {
    /// Tags to add (a leading `#` is dropped) and to take away, ignoring case.
    pub add_tags: Vec<String>,
    pub remove_tags: Vec<String>,
    /// The user's own keys to set, each to its values; none takes the key out.
    pub fields: std::collections::BTreeMap<String, Vec<String>>,
}

/// The keys `change` touches with their new values, given what is there now. Only `tags` and
/// `keys` (the user's own) can be set; another key is an error that names them.
pub fn refile(
    current: &std::collections::BTreeMap<String, Vec<String>>, change: &Refile, keys: &[String],
) -> Result<std::collections::BTreeMap<String, Vec<String>>> {
    let clean = |v: &str| v.trim().trim_start_matches('#').trim().to_string();
    let mut out = std::collections::BTreeMap::new();
    if !change.add_tags.is_empty() || !change.remove_tags.is_empty() {
        let gone: Vec<String> = change.remove_tags.iter().map(|t| clean(t).to_lowercase()).collect();
        let mut tags: Vec<String> = current.get("tags").cloned().unwrap_or_default();
        tags.retain(|t| !gone.contains(&t.to_lowercase()));
        for t in change.add_tags.iter().map(|t| clean(t)).filter(|t| !t.is_empty()) {
            if !tags.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
                tags.push(t);
            }
        }
        out.insert("tags".to_string(), tags);
    }
    for (k, vs) in &change.fields {
        let k = k.trim().to_lowercase();
        if !keys.contains(&k) {
            let known = if keys.is_empty() { "none are set up; the user adds them under [organize] keys in config.toml".to_string() } else { keys.join(", ") };
            return Err(Error::Other(format!("\"{k}\" is not one of the user's keys ({known}). Use tags for anything else.")));
        }
        out.insert(k, vs.iter().map(|v| clean(v)).filter(|v| !v.is_empty()).collect());
    }
    Ok(out)
}

/// `text` with each key of `changed` set to its values (see [`fm_set_list`]).
pub fn apply_fields(text: &str, changed: &std::collections::BTreeMap<String, Vec<String>>) -> String {
    changed.iter().fold(text.to_string(), |t, (k, vs)| fm_set_list(&t, k, vs))
}

/// The values a note gives each of `keys` in its frontmatter: a scalar, a list or a comma-separated string.
pub fn fields_of(text: &str, keys: &[String]) -> std::collections::BTreeMap<String, Vec<String>> {
    keys.iter().map(|k| (k.clone(), fm_list(text, k))).filter(|(_, v)| !v.is_empty()).collect()
}

impl FileEntry {
    /// The date `since:` and `before:` compare: when it was started or created, else last changed.
    pub fn date(&self) -> String {
        self.created.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| {
            chrono::DateTime::from_timestamp_millis(self.modified as i64)
                .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
                .unwrap_or_default()
        })
    }
}

/// What the workspace of a note or session goes by, lowercased, for the `workspace:` filter:
/// `value` as written and, when it names a workspace note among `files`, that note's path and
/// title. A workspace note goes by its own.
pub fn workspace_names(files: &[FileEntry], value: Option<&str>, own: Option<&FileEntry>) -> Vec<String> {
    let title_of = |f: &FileEntry| f.title.clone().unwrap_or_default();
    let mut names = vec![];
    if let Some(f) = own.filter(|f| f.kind.as_deref() == Some("workspace")) {
        names.extend([f.rel.clone(), title_of(f)]);
    }
    if let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) {
        names.push(v.to_string());
        let stem = v.trim_end_matches(".md");
        let named = files.iter().filter(|f| f.kind.as_deref() == Some("workspace")).find(|f| {
            f.rel.trim_end_matches(".md").ends_with(stem) || title_of(f).eq_ignore_ascii_case(v) || f.id.as_deref() == Some(v)
        });
        if let Some(f) = named {
            names.extend([f.rel.clone(), title_of(f)]);
        }
    }
    names.iter().map(|n| n.to_lowercase()).filter(|n| !n.is_empty()).collect()
}

/// What a file says about itself, kept until the file changes.
struct Scanned {
    stamp: (std::time::SystemTime, u64),
    entry: FileEntry,
    /// For documents agents wrote: what they were written for, and the sessions that wrote them.
    origin: Option<String>,
    sessions: Vec<String>,
    updated: String,
}

fn scan_cache() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, Scanned>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<PathBuf, Scanned>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn scan(vault: &Path, path: &Path, stamp: (std::time::SystemTime, u64), keys: &[String]) -> Scanned {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let entry = FileEntry {
        path: path.to_string_lossy().into_owned(),
        rel: path.strip_prefix(vault).unwrap_or(path).to_slash(),
        id: fm_get(&text, "id").filter(|s| !s.is_empty()),
        // Untitled notes and scratch memos are named by what they say.
        title: fm_get(&text, "title").filter(|s| !s.is_empty()).or_else(|| {
            (fm_get(&text, "untitled").as_deref() == Some("true")).then(|| crate::scratch::title_from_body(&text)).flatten()
        }),
        kind: fm_get(&text, "type"),
        status: fm_get(&text, "status"),
        tags: fm_list(&text, "tags"),
        aliases: fm_list(&text, "aliases"),
        modified: stamp.0.duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
        project: fm_get(&text, "project").filter(|s| !s.is_empty()),
        workspace: fm_get(&text, "workspace").filter(|s| !s.is_empty()),
        created: fm_get(&text, "started").or_else(|| fm_get(&text, "created")).filter(|s| !s.is_empty()),
        origin: fm_get(&text, "origin").filter(|s| !s.is_empty()),
        fields: fields_of(&text, keys),
    };
    let doc = entry.kind.as_deref() == Some("doc");
    Scanned {
        stamp,
        origin: if doc { fm_get(&text, "origin").filter(|s| !s.is_empty()) } else { None },
        updated: if doc { fm_get(&text, "updated").unwrap_or_default() } else { String::new() },
        sessions: if doc {
            fm_get(&text, "sessions")
                .map(|v| v.trim_matches(['[', ']']).split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
                .unwrap_or_default()
        } else {
            vec![]
        },
        entry,
    }
}

/// Walks the vault and calls `f` with each Markdown file's scan. Only files whose modified time or
/// size changed since the last walk are read again, so listing a large vault stays cheap.
fn each_scanned(vault: &Path, mut f: impl FnMut(&Scanned)) {
    let found: Vec<(PathBuf, (std::time::SystemTime, u64))> = walkdir::WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|x| x == "md"))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((e.path().to_path_buf(), (m.modified().ok()?, m.len())))
        })
        .collect();
    let keys = crate::config::organize_keys();
    let mut cache = scan_cache().lock().unwrap();
    // Other keys to read: every file is scanned again.
    static SCANNED_FOR: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let mut scanned_for = SCANNED_FOR.lock().unwrap();
    if *scanned_for != keys {
        cache.clear();
        *scanned_for = keys.clone();
    }
    drop(scanned_for);
    for (path, stamp) in &found {
        if cache.get(path).is_none_or(|c| c.stamp != *stamp) {
            let s = scan(vault, path, *stamp, &keys);
            cache.insert(path.clone(), s);
        }
    }
    // Files gone from this vault are forgotten; other vaults' entries stay.
    let seen: std::collections::HashSet<&PathBuf> = found.iter().map(|(p, _)| p).collect();
    cache.retain(|p, _| !p.starts_with(vault) || seen.contains(p));
    for (path, _) in &found {
        f(&cache[path]);
    }
}

/// Extensions of non-Markdown text files the sidebar lists, so they can be opened in the editor.
const TEXT_EXTENSIONS: &[&str] = &[
    "mq", "txt", "json", "yaml", "yml", "toml", "csv", "html", "css", "js", "ts", "tsx", "jsx", "py", "rs", "go", "sh", "sql", "xml",
];

/// Non-Markdown text files: no frontmatter is read, so they have only a path and a time.
fn other_files(vault: &Path) -> Vec<FileEntry> {
    walkdir::WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            e.depth() == 0 || !(n.starts_with('.') || n == "node_modules" || n == "target")
        })
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path().extension().and_then(|x| x.to_str()).is_some_and(|x| TEXT_EXTENSIONS.contains(&x.to_lowercase().as_str()))
        })
        .map(|e| {
            let modified = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok());
            FileEntry {
                path: e.path().to_string_lossy().into_owned(),
                rel: e.path().strip_prefix(vault).unwrap_or(e.path()).to_slash(),
                id: None,
                title: None,
                kind: Some("file".into()),
                status: None,
                tags: vec![],
                aliases: vec![],
                modified: modified.map_or(0, |d| d.as_millis() as u64),
                project: None,
                workspace: None,
                created: None,
                origin: None,
                fields: Default::default(),
            }
        })
        .collect()
}

/// Lists Markdown files under `vault`, skipping dot directories (`.marq`, `.raw`, `.git`), and
/// the text files beside them (kind `file`).
pub fn list_files(vault: &Path) -> Vec<FileEntry> {
    let mut files = Vec::new();
    each_scanned(vault, |s| files.push(s.entry.clone()));
    files.extend(other_files(vault));
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

/// A path as the text marq stores in notes and compares with note paths: `/` separators on every OS.
pub trait PathSlash {
    fn to_slash(&self) -> String;
}

impl PathSlash for Path {
    fn to_slash(&self) -> String {
        let s = self.to_string_lossy().into_owned();
        if cfg!(windows) { s.replace('\\', "/") } else { s }
    }
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

/// A list-valued key: `[a, b]`, a YAML block list, or a comma-separated string. `#` is dropped from tags.
pub fn fm_list(text: &str, key: &str) -> Vec<String> {
    use yaml_rust2::{Yaml, YamlLoader};
    let Some(fm) = split_frontmatter(text).0 else { return vec![] };
    // Cheap check first: most notes have neither key.
    if !fm.lines().any(|l| l.strip_prefix(key).is_some_and(|r| r.starts_with(':'))) {
        return vec![];
    }
    let Ok(docs) = YamlLoader::load_from_str(fm) else { return vec![] };
    let items: Vec<String> = match docs.first().map(|d| &d[key]) {
        Some(Yaml::Array(a)) => a.iter().filter_map(|y| y.as_str().map(str::to_string).or_else(|| y.as_i64().map(|n| n.to_string()))).collect(),
        Some(Yaml::String(s)) => s.split(',').map(str::to_string).collect(),
        _ => vec![],
    };
    items.iter().map(|t| t.trim().trim_start_matches('#').to_string()).filter(|t| !t.is_empty()).collect()
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

/// Where a document from an agent went.
#[derive(Debug, Serialize)]
pub struct SavedDoc {
    pub rel: String,
    pub title: String,
    pub created: bool,
}

/// Saves a document written by an agent. A new one goes to `folder` (default `docs`).
/// `path` updates an existing doc, but only one with `type: doc`, so hand-written notes are never
/// overwritten.
/// What an agent's write_doc call asks for.
pub struct DocWrite<'a> {
    pub title: &'a str,
    pub content: &'a str,
    pub folder: Option<&'a str>,
    pub path: Option<&'a str>,
    pub tags: &'a [String],
}

pub fn write_doc(vault: &Path, doc: DocWrite, session: &str, origin: &str) -> Result<SavedDoc> {
    let DocWrite { title, content, folder, path, tags } = doc;
    let tags: Vec<String> = tags.iter().map(|t| t.trim().trim_start_matches('#').to_string()).filter(|t| !t.is_empty()).collect();
    let tag_list = format!("[{}]", tags.iter().map(|t| serde_json::to_string(t).unwrap()).collect::<Vec<_>>().join(", "));
    let body = content.trim();
    // Drop frontmatter the agent may have added; marq writes its own.
    let body = split_frontmatter(&format!("{body}\n")).1.trim().to_string();
    let now = now();
    if let Some(p) = path.filter(|p| !p.is_empty()) {
        let full = resolve(vault, p)?;
        if full.exists() {
            let old = std::fs::read_to_string(&full)?;
            if fm_get(&old, "type").as_deref() != Some("doc") {
                return Err(Error::Other(format!("{p} is not a document written by an agent, so it is left as is")));
            }
            let fm = split_frontmatter(&old).0.unwrap_or_default();
            let t = fm_set(&format!("---\n{fm}\n---\n{body}\n"), "updated", &now);
            let mut t = fm_set(&t, "title", &serde_json::to_string(title).unwrap());
            if !tags.is_empty() {
                t = fm_set(&t, "tags", &tag_list);
            }
            std::fs::write(&full, fm_push(&t, "sessions", session))?;
            let rel = full.strip_prefix(vault.canonicalize()?).unwrap_or(&full).to_slash();
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
        "---\nid: {}\ntype: doc\ntitle: {}\n{}created: {now}\nupdated: {now}\nsessions: [{session}]\norigin: {origin}\n---\n{body}\n",
        new_id(),
        serde_json::to_string(title).unwrap(),
        if tags.is_empty() { String::new() } else { format!("tags: {tag_list}\n") },
    );
    std::fs::write(&full, text)?;
    Ok(SavedDoc { rel, title: title.into(), created: true })
}

/// Documents agents wrote (`type: doc`) for `origin` (a request or note anchor), plus those
/// `session` wrote or revised, newest first. A session's Docs tab lists them.
pub fn docs_from(vault: &Path, origin: &str, session: Option<&str>) -> Vec<serde_json::Value> {
    let mut docs: Vec<(String, serde_json::Value)> = Vec::new();
    each_scanned(vault, |s| {
        if s.entry.kind.as_deref() != Some("doc") {
            return;
        }
        let by_origin = !origin.is_empty() && s.origin.as_deref() == Some(origin);
        let by_session = session.is_some_and(|id| s.sessions.iter().any(|x| x == id));
        if by_origin || by_session {
            let d = serde_json::json!({"path": s.entry.path, "rel": s.entry.rel, "title": s.entry.title, "updated": s.updated});
            docs.push((s.updated.clone(), d));
        }
    });
    docs.sort_by(|a, b| b.0.cmp(&a.0));
    docs.into_iter().map(|(_, d)| d).collect()
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

/// The result block written for `session`. Blocks are `marq:result`; notes from before the rename
/// still have `claude:result`, which are read and replaced the same way.
fn result_re(session: &str) -> Regex {
    Regex::new(&format!(
        r#"(?s)<!-- (?:marq|claude):result session="{}" -->.*?<!-- /(?:marq|claude):result -->"#,
        regex::escape(session)
    ))
    .unwrap()
}

/// Removes the result block written for `session`, with the blank line before it.
pub fn remove_result(text: &str, session: &str) -> String {
    let re = Regex::new(&format!(r"\n*{}", result_re(session).as_str())).unwrap();
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
/// `<!-- mq:output -->` markers, replacing an existing pinned output.
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

/// One `context:` entry of a request.
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
    // `claude:anchor` in notes from before the rename.
    Regex::new(r#"<!-- (?:marq|claude):anchor id="([^"]+)" -->"#).unwrap()
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
    out.insert(at, format!("<!-- marq:anchor id=\"{id}\" -->"));
    (id, out.join("\n") + "\n")
}

/// Replaces the result block for `session`, or adds one: under `## Result` for requests,
/// otherwise at the end of the section that holds `anchor`.
pub fn write_result(text: &str, anchor: Option<&str>, session: &str, body: &str) -> String {
    let block = format!("<!-- marq:result session=\"{session}\" -->\n{}\n<!-- /marq:result -->", body.trim());
    let re = result_re(session);
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
    search(vault, query, include_sessions, max_files, per_file).0
}

/// Lines with every word of `query` (or a synonym from the thesaurus), in notes with its `tag:`s
/// that pass its filters (`type:`, `status:`, `project:`, `workspace:`, `since:`, `before:`).
/// A query of tags and filters alone lists the notes, with one line each.
/// Also returns the parsed query, to show what the words were expanded to.
pub fn search(vault: &Path, query: &str, include_sessions: bool, max_files: usize, per_file: usize) -> (Vec<SearchHit>, Query) {
    let files = list_files(vault);
    let q = Query::parse(query, &Thesaurus::load(&files));
    if q.is_empty() {
        return (vec![], q);
    }
    let fl = &q.filters;
    // Asking for sessions by type includes them.
    let include_sessions = include_sessions || fl.kinds.iter().any(|k| k == "session");
    let mut out = vec![];
    for f in &files {
        if !include_sessions && f.rel.starts_with("sessions/") {
            continue;
        }
        // Text files beside the notes have no frontmatter to filter by.
        let kind = f.kind.as_deref().filter(|k| *k != "file");
        if !q.matches_tags(&f.tags)
            || !fl.matches_kind(kind)
            || !fl.matches_status(f.status.as_deref())
            || !fl.matches_project(f.project.as_deref())
            || !((fl.since.is_none() && fl.before.is_none()) || fl.matches_date(&f.date()))
            || !fl.matches_fields(&f.fields)
            || !(fl.workspaces.is_empty() || fl.matches_workspace(&workspace_names(&files, f.workspace.as_deref(), Some(f))))
        {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&f.path) else { continue };
        let (mut lines, mut more) = (vec![], 0);
        // No words: the note matches as a whole. Show its tags line, or where its text starts.
        if q.words.is_empty() {
            let at = if q.tags.is_empty() {
                let body = split_frontmatter(&content).1;
                let skipped = content[..content.len() - body.len()].lines().count();
                body.lines().position(|l| !l.trim().is_empty()).map_or(0, |i| skipped + i)
            } else {
                content.lines().position(|l| l.starts_with("tags:")).unwrap_or(0)
            };
            lines.push((at + 1, content.lines().nth(at).unwrap_or_default().trim().chars().take(240).collect()));
        }
        for (i, line) in content.lines().enumerate().filter(|_| !q.words.is_empty()) {
            if q.matches_line(line) {
                if lines.len() < per_file {
                    lines.push((i + 1, line.trim().chars().take(240).collect()));
                } else {
                    more += 1;
                }
            }
        }
        if !lines.is_empty() {
            out.push(SearchHit { path: f.path.clone(), rel: f.rel.clone(), title: f.title.clone(), lines, more });
            if out.len() >= max_files {
                break;
            }
        }
    }
    (out, q)
}

#[cfg(test)]
mod tests {
    #[test]
    fn docs_from_finds_a_tasks_documents() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        let w = |title: &str, session: &str, origin: &str| {
            write_doc(v, DocWrite { title, content: "x", folder: None, path: None, tags: &[] }, session, origin).unwrap()
        };
        w("Plan", "s1", "req1");
        w("Other run", "s2", "req1");
        w("Unrelated", "s3", "req2");
        let revised = w("Revised", "s3", "req2");
        write_doc(v, DocWrite { title: "Revised", content: "y", folder: None, path: Some(&revised.rel), tags: &[] }, "s1", "req1").unwrap();
        let titles = |d: Vec<serde_json::Value>| {
            let mut t: Vec<String> = d.iter().map(|x| x["title"].as_str().unwrap().to_string()).collect();
            t.sort();
            t
        };
        assert_eq!(titles(docs_from(v, "req1", Some("s1"))), ["Other run", "Plan", "Revised"]);
        assert_eq!(titles(docs_from(v, "req1", None)), ["Other run", "Plan"]);
        assert!(docs_from(v, "", None).is_empty());
    }

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
        assert!(t.ends_with(&format!("---\n<!-- marq:anchor id=\"{id}\" -->\n")));
        let no_heading = "---\nid: n\n---\nplain text\nmore\n";
        let (id, t) = ensure_anchor(no_heading, &section_at(no_heading, 0));
        assert!(t.contains(&format!("---\n<!-- marq:anchor id=\"{id}\" -->\nplain text")));
        assert!(section_at("", 0).text.is_empty());
    }

    #[test]
    fn docs_go_to_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        let d = write_doc(v, DocWrite { title: "API 設計メモ", content: "---\nfoo: 1\n---\n# Plan\n\nbody", folder: None, path: None, tags: &["#api".into()] }, "s1", "o1").unwrap();
        assert!(d.created && d.rel.starts_with("docs/") && d.rel.ends_with("-api-設計メモ.md"), "{}", d.rel);
        let t = std::fs::read_to_string(v.join(&d.rel)).unwrap();
        assert_eq!(fm_get(&t, "type").as_deref(), Some("doc"));
        assert!(t.contains("# Plan\n\nbody") && !t.contains("foo: 1"));
        assert_eq!(fm_list(&t, "tags"), vec!["api"]);

        let again = write_doc(v, DocWrite { title: "API 設計メモ", content: "# Plan v2", folder: None, path: Some(&d.rel), tags: &[] }, "s2", "o1").unwrap();
        assert!(!again.created && again.rel == d.rel);
        let t = std::fs::read_to_string(v.join(&d.rel)).unwrap();
        assert!(t.contains("# Plan v2") && t.contains("sessions: [s1, s2]"));

        std::fs::write(v.join("mine.md"), "---\ntype: note\n---\nhand written\n").unwrap();
        assert!(write_doc(v, DocWrite { title: "x", content: "y", folder: None, path: Some("mine.md"), tags: &[] }, "s", "o").is_err());
        assert!(write_doc(v, DocWrite { title: "x", content: "y", folder: None, path: Some("../outside.md"), tags: &[] }, "s", "o").is_err());
        let other = write_doc(v, DocWrite { title: "Weekly", content: "z", folder: Some("reports"), path: None, tags: &[] }, "s", "o").unwrap();
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
        assert!(text.find("marq:result").unwrap() < c);
        let text = write_result(&text, Some(&id), "s1", "again");
        assert!(text.contains("again") && !text.contains("done\n"));
        let removed = remove_result(&text, "s1");
        assert!(!removed.contains("marq:result") && removed.contains("```\n\n## C"));
        let req = write_result("---\nid: r\n---\n## Request\nx\n", None, "s2", "ok");
        assert!(req.contains("## Result\n\n<!-- marq:result session=\"s2\" -->\nok"));
    }

    #[test]
    fn reads_markers_from_before_the_rename() {
        let old = "# A\n<!-- claude:anchor id=\"a1\" -->\ntext\n\n<!-- claude:result session=\"s1\" -->\nold\n<!-- /claude:result -->\n";
        assert_eq!(anchors(old)[0].id, "a1");
        let new = write_result(old, Some("a1"), "s1", "new");
        assert!(new.contains("<!-- marq:result session=\"s1\" -->\nnew\n<!-- /marq:result -->"));
        assert!(!new.contains("claude:result"));
        assert!(!remove_result(old, "s1").contains("result"));
    }

    #[test]
    fn reads_list_keys_in_any_form() {
        assert_eq!(fm_list("---\ntags: [a, \"#b\"]\n---\n", "tags"), vec!["a", "b"]);
        assert_eq!(fm_list("---\ntags:\n  - a\n  - b\n---\n", "tags"), vec!["a", "b"]);
        assert_eq!(fm_list("---\naliases: x, y\n---\n", "aliases"), vec!["x", "y"]);
        assert!(fm_list("---\ntitle: t\n---\n", "tags").is_empty());
    }

    #[test]
    fn search_uses_the_glossary_and_tags() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        std::fs::write(v.join("glossary.md"), "---\ntype: glossary\n---\n## 認証\n- aliases: auth\n").unwrap();
        std::fs::write(v.join("a.md"), "---\ntags: [security]\n---\n認証のバグを直す\n").unwrap();
        std::fs::write(v.join("b.md"), "---\naliases: [db]\ntitle: Database\n---\nauth table in the database\n").unwrap();
        let (hits, q) = search(v, "Auth", false, 10, 10);
        // The glossary's own entry is a hit too, which shows what the term means.
        assert_eq!(hits.iter().map(|h| h.rel.as_str()).collect::<Vec<_>>(), vec!["a.md", "b.md", "glossary.md"]);
        assert_eq!(q.expanded(), vec![vec!["auth".to_string(), "認証".into()]]);
        // A note's aliases work like a glossary entry.
        assert_eq!(search(v, "db table", false, 10, 10).0.len(), 1);
        let (hits, _) = search(v, "tag:security", false, 10, 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].lines[0].1, "tags: [security]");
    }

    #[test]
    fn refiles_notes() {
        use std::collections::BTreeMap;
        let keys = ["area".to_string()];
        let current = BTreeMap::from([("tags".to_string(), vec!["Bug".to_string(), "ui".to_string()])]);
        let change = Refile {
            add_tags: vec!["#bug".into(), " auth ".into()],
            remove_tags: vec!["UI".into()],
            fields: BTreeMap::from([("Area".to_string(), vec!["billing".to_string(), "".to_string()])]),
        };
        let changed = refile(&current, &change, &keys).unwrap();
        assert_eq!(changed["tags"], ["Bug", "auth"]);
        assert_eq!(changed["area"], ["billing"]);
        // Only tags and the user's keys.
        let bad = Refile { fields: BTreeMap::from([("status".to_string(), vec!["done".to_string()])]), ..Default::default() };
        assert!(refile(&current, &bad, &keys).unwrap_err().to_string().contains("area"));

        // Written back: an inline list, in place of a block list, and other lines as they were.
        let note = "---\ntitle: t\ntags:\n  - Bug\n  - ui\nstatus: todo\n---\nbody\n";
        let text = apply_fields(note, &changed);
        assert_eq!(text, "---\ntitle: t\ntags: [\"Bug\", \"auth\"]\nstatus: todo\narea: [\"billing\"]\n---\nbody\n");
        // No values takes the key out; a note without frontmatter gets one.
        assert_eq!(fm_set_list(&text, "area", &[]), "---\ntitle: t\ntags: [\"Bug\", \"auth\"]\nstatus: todo\n---\nbody\n");
        assert_eq!(fm_set_list("body\n", "tags", &["a".to_string()]), "---\ntags: [\"a\"]\n---\nbody\n");
        assert_eq!(fm_set_list("body\n", "tags", &[]), "body\n");
    }

    #[test]
    fn reads_the_users_own_keys() {
        let keys = ["area".to_string(), "epic".to_string(), "owner".to_string()];
        let f = fields_of("---\narea: [billing, auth/oauth]\nepic: checkout\ntitle: t\n---\n", &keys);
        assert_eq!(f["area"], ["billing", "auth/oauth"]);
        assert_eq!(f["epic"], ["checkout"]);
        assert!(!f.contains_key("owner") && !f.contains_key("title"));
    }

    #[test]
    fn search_filters_by_frontmatter() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        for d in ["requests", "workspaces", "sessions", "notes"] {
            std::fs::create_dir_all(v.join(d)).unwrap();
        }
        std::fs::write(v.join("workspaces/mq-docs.md"), "---\ntype: workspace\ntitle: \"mq + docs\"\nproject: ~/dev/mq\n---\n# mq + docs\n").unwrap();
        std::fs::write(v.join("requests/a.md"), "---\ntype: request\nstatus: todo\ncreated: 2026-11-10T10:00:00+09:00\nproject: ~/dev/mq\nworkspace: mq + docs\n---\n# Hover\n\nShow types on hover\n").unwrap();
        std::fs::write(v.join("requests/b.md"), "---\ntype: request\nstatus: done\ncreated: 2026-10-01T10:00:00+09:00\nproject: ~/dev/other\n---\n# Other\n\nhover elsewhere\n").unwrap();
        std::fs::write(v.join("sessions/s.md"), "---\ntype: session\nstatus: done\nstarted: 2026-11-11T10:00:00+09:00\nproject: \"/home/u/dev/mq\"\nworkspace: \"workspaces/mq-docs.md\"\n---\nhover in a session\n").unwrap();
        std::fs::write(v.join("notes/n.md"), "plain hover note\n").unwrap();
        let rels = |query: &str| search(v, query, false, 10, 10).0.into_iter().map(|h| h.rel).collect::<Vec<_>>();
        assert_eq!(rels("hover type:request"), ["requests/a.md", "requests/b.md"]);
        assert_eq!(rels("hover type:note"), ["notes/n.md"]);
        assert_eq!(rels("hover status:todo"), ["requests/a.md"]);
        assert_eq!(rels("hover project:other"), ["requests/b.md"]);
        assert_eq!(rels("hover type:request since:2026-11"), ["requests/a.md"]);
        assert_eq!(rels("hover type:request before:2026-11"), ["requests/b.md"]);
        // Sessions are left out unless asked for by type; a workspace goes by its title and its path.
        assert_eq!(rels("hover project:dev/mq"), ["requests/a.md"]);
        assert_eq!(rels("hover type:session"), ["sessions/s.md"]);
        assert_eq!(rels(r#"workspace:"mq + docs" type:request type:session type:workspace"#), ["requests/a.md", "sessions/s.md", "workspaces/mq-docs.md"]);
        assert_eq!(rels("workspace:mq-docs type:session"), ["sessions/s.md"]);
        // Filters alone list the notes, at the first line of their text.
        let (hits, _) = search(v, "status:todo", false, 10, 10);
        assert_eq!((hits.len(), &hits[0].lines[0]), (1, &(8, "# Hover".to_string())));
    }
}
