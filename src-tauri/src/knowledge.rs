//! Knowledge notes: what sessions learned, merged by topic so it does not pile up session by session.
//!
//! Sessions record learnings in their own `## Learnings`. A gardening run (a schedule) reads the ones
//! no knowledge note has taken in yet with `list_learnings`, and writes topic notes in `knowledge/`
//! with `write_knowledge`:
//!
//! ```markdown
//! ---
//! type: knowledge
//! title: "Worktrees"
//! project: "~/dev/git/marq"
//! status: draft              # reviewed once a person has checked it
//! sources: [<session id>, …]  # the sessions it took learnings from
//! ---
//! …
//! ## Sources
//! - [[sessions/2026-10-29-…|Fix the worktree cleanup]] (2026-10-29)
//! ```
//!
//! An agent's write always leaves the note `draft`; a person marks it `reviewed`. Sessions are told
//! which knowledge notes belong to their project, so they read them before starting.

use crate::vault::PathSlash;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::vault;

pub const FOLDER: &str = "knowledge";

/// `~` expanded, no trailing slash, so the same project compares equal however it was written.
pub(crate) fn norm(project: &str) -> String {
    vault::expand_home(project.trim()).to_string_lossy().trim_end_matches(['/', '\\']).to_string()
}

/// The bullets under `## Learnings`, without the empty placeholder.
pub fn learnings_of(text: &str) -> Vec<String> {
    let mut inside = false;
    let mut out = vec![];
    for line in text.lines() {
        if let Some(h) = line.strip_prefix("## ") {
            inside = h.trim() == "Learnings";
            continue;
        }
        if let Some(b) = line.strip_prefix("- ").map(str::trim).filter(|b| inside && !b.is_empty()) {
            out.push(b.to_string());
        }
    }
    out
}

/// Session ids every knowledge note lists as a source.
fn merged(vault: &Path) -> HashSet<String> {
    vault::list_files(vault)
        .into_iter()
        .filter(|f| f.kind.as_deref() == Some("knowledge"))
        .flat_map(|f| vault::fm_list(&std::fs::read_to_string(&f.path).unwrap_or_default(), "sources"))
        .collect()
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SessionLearnings {
    pub session: String,
    pub title: String,
    /// The session note, vault-relative, for `[[links]]`.
    pub path: String,
    pub project: String,
    pub started: String,
    pub learnings: Vec<String>,
}

/// Sessions with learnings, newest first; only those no knowledge note has taken in unless `all`.
/// `project` keeps the ones that worked on it.
pub fn learnings(vault: &Path, project: Option<&str>, all: bool) -> Vec<SessionLearnings> {
    let done = if all { HashSet::new() } else { merged(vault) };
    let want = project.map(norm).filter(|p| !p.is_empty());
    let mut out: Vec<SessionLearnings> = vault::list_files(vault)
        .into_iter()
        .filter(|f| f.kind.as_deref() == Some("session"))
        .filter_map(|f| {
            let text = std::fs::read_to_string(&f.path).ok()?;
            let id = vault::fm_get(&text, "id")?;
            if done.contains(&id) {
                return None;
            }
            let learnings = learnings_of(&text);
            let proj = vault::fm_get(&text, "project").or_else(|| vault::fm_get(&text, "cwd")).unwrap_or_default();
            if learnings.is_empty() || want.as_ref().is_some_and(|w| norm(&proj) != *w) {
                return None;
            }
            Some(SessionLearnings {
                session: id,
                title: f.title.unwrap_or_default(),
                path: f.rel.trim_end_matches(".md").to_string(),
                project: proj,
                started: vault::fm_get(&text, "started").unwrap_or_default(),
                learnings,
            })
        })
        .collect();
    out.sort_by(|a, b| b.started.cmp(&a.started));
    out
}

/// `knowledge/<topic>.md`: named by topic, not date, since the note is kept up to date rather than added to.
fn topic_path(vault: &Path, topic: &str) -> String {
    let base = format!("{FOLDER}/{}", vault::slug(topic));
    let mut rel = format!("{base}.md");
    let mut n = 2;
    while vault.join(&rel).exists() {
        rel = format!("{base}-{n}.md");
        n += 1;
    }
    rel
}

/// What an agent's write_knowledge call asks for.
pub struct KnowledgeWrite<'a> {
    pub topic: &'a str,
    pub content: &'a str,
    /// Session ids the content draws on; added to the note's earlier ones.
    pub sources: &'a [String],
    pub tags: &'a [String],
    pub project: Option<&'a str>,
}

/// Creates or replaces `knowledge/<topic>.md`, always as a draft for a person to review.
/// Returns the note's vault-relative path.
pub fn write(vault: &Path, k: KnowledgeWrite) -> Result<String> {
    let topic = k.topic.trim();
    if topic.is_empty() {
        return Err(Error::Other("a knowledge note needs a topic".into()));
    }
    let existing = vault::list_files(vault).into_iter().find(|f| {
        f.kind.as_deref() == Some("knowledge") && f.title.as_deref().is_some_and(|t| t.eq_ignore_ascii_case(topic))
    });
    let (path, old) = match &existing {
        Some(f) => (PathBuf::from(&f.path), std::fs::read_to_string(&f.path)?),
        None => (vault.join(topic_path(vault, topic)), String::new()),
    };
    let mut sources = vault::fm_list(&old, "sources");
    for s in k.sources.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if !sources.iter().any(|x| x == s) {
            sources.push(s.to_string());
        }
    }
    let mut tags = vault::fm_list(&old, "tags");
    for t in k.tags.iter().map(|t| t.trim().trim_start_matches('#')).filter(|t| !t.is_empty()) {
        if !tags.iter().any(|x| x.eq_ignore_ascii_case(t)) {
            tags.push(t.to_string());
        }
    }
    // An existing note keeps its title, however the topic was spelled this time.
    let topic = existing.as_ref().and_then(|f| f.title.clone()).unwrap_or_else(|| topic.to_string());
    let topic = topic.as_str();
    let project = k.project.map(str::to_string).or_else(|| vault::fm_get(&old, "project")).unwrap_or_default();

    // Sources as links to the session notes, newest first, replacing any the content brought along.
    let sessions: Vec<(String, String, String)> = vault::list_files(vault)
        .into_iter()
        .filter(|f| f.kind.as_deref() == Some("session"))
        .filter_map(|f| {
            let text = std::fs::read_to_string(&f.path).ok()?;
            let id = vault::fm_get(&text, "id")?;
            sources.contains(&id).then(|| {
                let started = vault::fm_get(&text, "started").unwrap_or_default();
                (started, f.rel.trim_end_matches(".md").to_string(), f.title.unwrap_or_default())
            })
        })
        .collect();
    let mut sessions = sessions;
    sessions.sort_by(|a, b| b.0.cmp(&a.0));
    let body = vault::split_frontmatter(&format!("{}\n", k.content.trim())).1.to_string();
    let body = body.split("\n## Sources").next().unwrap_or(&body).trim().to_string();
    let links: Vec<String> = sessions
        .iter()
        .map(|(started, rel, title)| format!("- [[{rel}|{}]] ({})", title.replace(['[', ']', '|'], ""), started.get(..10).unwrap_or("")))
        .collect();

    let q = |s: &str| serde_json::to_string(s).unwrap();
    let list = |v: &[String]| format!("[{}]", v.iter().map(|s| q(s)).collect::<Vec<_>>().join(", "));
    let now = vault::now();
    let text = format!(
        "---\nid: {}\ntype: knowledge\ntitle: {}\nproject: {}\ntags: {}\nstatus: draft\ncreated: {}\nupdated: {now}\nsources: {}\n---\n{body}\n\n## Sources\n\n{}\n",
        vault::fm_get(&old, "id").unwrap_or_else(vault::new_id),
        q(topic),
        q(&project),
        list(&tags),
        vault::fm_get(&old, "created").unwrap_or_else(|| now.clone()),
        list(&sources),
        if links.is_empty() { "-".to_string() } else { links.join("\n") },
    );
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, text)?;
    Ok(path.strip_prefix(vault).unwrap_or(&path).to_slash())
}

/// Marks a knowledge note as checked by a person.
pub fn set_reviewed(path: &Path) -> Result<()> {
    let text = std::fs::read_to_string(path)?;
    if vault::fm_get(&text, "type").as_deref() != Some("knowledge") {
        return Err(Error::Other("not a knowledge note".into()));
    }
    let t = vault::fm_set(&text, "status", "reviewed");
    std::fs::write(path, vault::fm_set(&t, "reviewed", &vault::now()))?;
    Ok(())
}

/// A reviewed note this many days old is mentioned as such: the code has likely moved on.
const OLD_AFTER_DAYS: i64 = 90;

/// File paths the note names in backticks (`src/lib.rs`, `docs/a.md:12`), outside its `## Sources`.
fn mentioned_paths(text: &str) -> Vec<String> {
    const EXTS: [&str; 14] = ["rs", "ts", "tsx", "js", "jsx", "md", "toml", "json", "py", "go", "yml", "yaml", "sh", "css"];
    let body = vault::split_frontmatter(text).1;
    let body = body.split("\n## Sources").next().unwrap_or(body);
    let mut out: Vec<String> = vec![];
    for (i, span) in body.split('`').enumerate() {
        // Every second piece is inside a pair of backticks.
        if i % 2 == 0 {
            continue;
        }
        let path = span.trim();
        // `file:12` names a line.
        let path = match path.rsplit_once(':') {
            Some((p, n)) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => p,
            _ => path,
        };
        let plain = !path.is_empty()
            && !path.contains(|c: char| c.is_whitespace() || "*?<>{}()[]$~=|,;\"'".contains(c))
            && !path.contains("://")
            && !path.contains("::")
            && !path.starts_with(['/', '.', '-'])
            && !path.contains("..");
        let ext_ok = path.rsplit_once('.').is_some_and(|(stem, e)| !stem.is_empty() && EXTS.contains(&e));
        if plain && ext_ok && !out.iter().any(|o| o == path) {
            out.push(path.to_string());
        }
    }
    out
}

/// What may be out of date in a knowledge note for `project`: files it names that the project no
/// longer has, and a review that is old. Empty when there is nothing to say.
fn staleness(text: &str, project: &str) -> String {
    let root = vault::expand_home(project.trim());
    let missing: Vec<String> = if project.trim().is_empty() || !root.is_dir() {
        vec![]
    } else {
        mentioned_paths(text).into_iter().filter(|p| !root.join(p).exists()).collect()
    };
    let mut notes = vec![];
    if !missing.is_empty() {
        let shown: Vec<String> = missing.iter().take(3).map(|p| format!("`{p}`")).collect();
        let more = if missing.len() > 3 { format!(" and {} more", missing.len() - 3) } else { String::new() };
        notes.push(format!("names files that no longer exist: {}{more}", shown.join(", ")));
    }
    let age = vault::fm_get(text, "reviewed")
        .and_then(|r| chrono::DateTime::parse_from_rfc3339(r.trim()).ok())
        .map(|r| (chrono::Local::now().fixed_offset() - r).num_days())
        .filter(|d| *d > OLD_AFTER_DAYS);
    if let Some(d) = age {
        notes.push(format!("reviewed {d} days ago"));
    }
    if notes.is_empty() { String::new() } else { format!(", check against the code first: {}", notes.join("; ")) }
}

/// Knowledge notes for a session in `project` (and those for no project), for its system prompt.
pub fn for_project(vault: &Path, project: &str) -> String {
    let p = norm(project);
    let notes: Vec<String> = vault::list_files(vault)
        .into_iter()
        .filter(|f| f.kind.as_deref() == Some("knowledge"))
        .filter_map(|f| {
            let text = std::fs::read_to_string(&f.path).ok()?;
            let np = vault::fm_get(&text, "project").unwrap_or_default();
            (np.is_empty() || norm(&np) == p).then(|| {
                let draft = if vault::fm_get(&text, "status").as_deref() == Some("reviewed") { "" } else { ", draft: not checked by the user yet" };
                format!("- [[{}]] ({}{draft}{})", f.title.unwrap_or_default(), f.rel, staleness(&text, project))
            })
        })
        .take(30)
        .collect();
    if notes.is_empty() {
        return String::new();
    }
    format!(
        "\n\nKnowledge notes for this project, merged from earlier sessions' learnings. Read the ones that bear on the task \
with read_note before you start, and trust reviewed ones over drafts. A note marked to check may be out of date: \
verify what it says in the code before you rely on it, and record the correction with append_learning:\n{}",
        notes.join("\n")
    )
}

/// The prompt of the gardening schedule.
pub const GARDENING_PROMPT: &str = "Merge what earlier sessions learned into knowledge notes.

1. Call list_learnings to get the learnings no knowledge note has taken in yet.
2. Look at the knowledge notes that exist (list_notes with folder \"knowledge\") and at glossary.md, and read the ones these learnings touch.
3. Check the notes you read against the repository: a file, command or function a note names must still exist, so fix or drop what no longer does. Then group the learnings by topic. For each topic, call write_knowledge with the whole note: merge the new learnings into what is there, drop duplicates, the obvious and what no longer holds, and keep each point short and specific (what, why, where in the code). Use the glossary's terms and link related notes with [[Title]]. Pass every session you drew on as sources, including ones whose learnings you dropped, so they are not offered again.
4. When a learning contradicts a note the user has reviewed (status: reviewed), do not overwrite it: keep both under \"## Open questions\".
5. Reply with a short list of the notes you created or changed and why.";

/// The prompt of the hardening schedule: failures turned into rules, checks and playbooks.
pub const HARDENING_PROMPT: &str = "Turn what keeps going wrong in this vault's sessions into rules, so it stops happening.

1. Look at recent sessions with search_sessions and read_session: failed checks (marq_verify with passed false, including `stage: \"review\"` and the `reviews/` notes they link, or `verified: failed` on a request), approvals that were denied, errors, and learnings that say a mistake was made. Ignore one-off slips.
2. Group them by cause. Keep only the causes that happened more than once, or that cost a lot.
3. For each, choose the smallest guard that stops it, and say which:
   - a command that must not run, or must be asked about: an `ask` or `deny` entry in the project's environment note;
   - a missing setup step, file or variable: `setup:`, `copy:` or `vars:` there;
   - work that was wrong in a way a command can catch: a better `verify:` command;
   - a way of working: a line in the playbook or in a knowledge note.
4. Write the proposals as one document with write_doc: for each, the evidence (the sessions), the cause, the change and the file it goes in. Do not edit environment notes, playbooks or the repository yourself; the user decides.
5. Reply with the document's path and a one-line summary of each proposal. If nothing repeats, say so and write nothing.";

/// The hardening schedule, created on first use. Returns its path.
pub fn ensure_hardening(vault: &Path) -> Result<PathBuf> {
    let existing = vault::list_files(vault).into_iter().find(|f| {
        f.kind.as_deref() == Some("schedule")
            && std::fs::read_to_string(&f.path).is_ok_and(|t| t.contains("Turn what keeps going wrong"))
    });
    match existing {
        Some(f) => Ok(PathBuf::from(f.path)),
        None => crate::automation::create(vault, "Harden from failures", "1w", HARDENING_PROMPT, "", ""),
    }
}

/// The gardening schedule, created on first use. Returns its path.
pub fn ensure_gardening(vault: &Path) -> Result<PathBuf> {
    let existing = vault::list_files(vault).into_iter().find(|f| {
        f.kind.as_deref() == Some("schedule")
            && std::fs::read_to_string(&f.path).is_ok_and(|t| t.contains("Call list_learnings"))
    });
    match existing {
        Some(f) => Ok(PathBuf::from(f.path)),
        None => crate::automation::create(vault, "Knowledge gardening", "1d", GARDENING_PROMPT, "", ""),
    }
}

/// The prompt of the promotion schedule: reviewed knowledge goes back into the repository, where every
/// agent reads it, not only sessions started from marq.
pub const PROMOTION_PROMPT: &str = "Write what this project's knowledge notes say back into the repository, so every coding agent working on it starts from it.

1. List the knowledge notes (list_notes with folder \"knowledge\") and read the ones for this project whose status is reviewed. Leave drafts out: nobody has checked them yet.
2. Read the repository's agent instructions: CLAUDE.md, AGENTS.md and .claude/skills/*/SKILL.md, whichever exist.
3. Fold in what is missing or out of date. Short, specific rules belong in CLAUDE.md (or AGENTS.md if that is what the project uses); a procedure with several steps that only matters for one kind of task belongs in a skill (.claude/skills/<name>/SKILL.md with name and description frontmatter). Keep the files short: drop what the code already makes obvious, and do not copy the notes wholesale.
4. If nothing needs to change, say so and stop. Otherwise commit on this branch and open a pull request with gh, listing the knowledge notes each change came from.";

/// The promotion schedule, created on first use, turned off until its project is set. Returns its path.
pub fn ensure_promotion(vault: &Path) -> Result<PathBuf> {
    let existing = vault::list_files(vault).into_iter().find(|f| {
        f.kind.as_deref() == Some("schedule") && std::fs::read_to_string(&f.path).is_ok_and(|t| t.contains("Fold in what is missing"))
    });
    if let Some(f) = existing {
        return Ok(PathBuf::from(f.path));
    }
    let path = crate::automation::create(vault, "Promote knowledge", "1w", PROMOTION_PROMPT, "", "")?;
    let text = std::fs::read_to_string(&path)?;
    let text = vault::fm_set(&vault::fm_set(&text, "worktree", "true"), "enabled", "false");
    std::fs::write(&path, vault::fm_set(&text, "permission_mode", "acceptEdits"))?;
    Ok(path)
}

pub fn list_json(items: Vec<SessionLearnings>) -> Value {
    json!({ "sessions": items, "note": "Pass these session ids as write_knowledge sources once their learnings are merged (or dropped)." })
}

#[cfg(test)]
mod tests {

    #[test]
    fn finds_paths_a_note_names_and_what_is_gone() {
        let note = "---\nreviewed: 2020-01-01T00:00:00+00:00\n---\nSee `src/a.rs:12` and `src/gone.rs`, run `cargo test`, `foo::bar`, `https://x.dev/a.md`.\n\n## Sources\n- `src/ignored.rs`\n";
        assert_eq!(mentioned_paths(note), ["src/a.rs", "src/gone.rs"]);
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.rs"), "").unwrap();
        let s = staleness(note, &dir.path().to_string_lossy());
        assert!(s.contains("`src/gone.rs`") && !s.contains("src/a.rs") && s.contains("days ago"), "{s}");
        assert_eq!(staleness("---\n---\nNothing named.", &dir.path().to_string_lossy()), "");
        // Without a project directory there is nothing to compare with.
        assert!(!staleness(note, "").contains("no longer exist"));
    }
    use super::*;

    fn session(v: &Path, name: &str, id: &str, project: &str, learnings: &str) {
        std::fs::create_dir_all(v.join("sessions")).unwrap();
        std::fs::write(
            v.join(format!("sessions/{name}.md")),
            format!("---\nid: {id}\ntype: session\ntitle: \"{name}\"\nproject: \"{project}\"\nstarted: 2026-10-2{}T10:00:00+09:00\n---\n## Summary\n\nok\n\n## Learnings\n\n{learnings}\n\n## Transcript\n- not a learning\n", id.len()),
        )
        .unwrap();
    }

    #[test]
    fn collects_and_merges_learnings() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        session(v, "a", "s1", "/p/one", "- worktrees live in .marq\n- second");
        session(v, "b", "s22", "/p/two/", "- other project");
        session(v, "c", "s333", "/p/one", "-");

        let all = learnings(v, None, false);
        assert_eq!(all.iter().map(|s| s.session.as_str()).collect::<Vec<_>>(), vec!["s22", "s1"]);
        assert_eq!(all[1].learnings, vec!["worktrees live in .marq", "second"]);
        assert_eq!(learnings(v, Some("/p/two"), false).len(), 1);

        let rel = write(v, KnowledgeWrite { topic: "Worktrees", content: "Live in .marq.", sources: &["s1".into()], tags: &["git".into()], project: Some("/p/one") }).unwrap();
        assert_eq!(rel, "knowledge/worktrees.md");
        let text = std::fs::read_to_string(v.join(&rel)).unwrap();
        assert_eq!(vault::fm_get(&text, "status").as_deref(), Some("draft"));
        assert!(text.contains("## Sources\n\n- [[sessions/a|a]] (2026-10-22)"));
        // Taken in: no longer offered.
        assert_eq!(learnings(v, None, false).len(), 1);
        assert_eq!(learnings(v, None, true).len(), 2);

        // Writing again keeps the note, its sources and tags, and makes it a draft again.
        set_reviewed(&v.join(&rel)).unwrap();
        let again = write(v, KnowledgeWrite { topic: "worktrees", content: "Updated.\n\n## Sources\n- stale", sources: &["s22".into()], tags: &[], project: None }).unwrap();
        assert_eq!(again, rel);
        let text = std::fs::read_to_string(v.join(&rel)).unwrap();
        assert_eq!(vault::fm_list(&text, "sources"), vec!["s1", "s22"]);
        assert_eq!(vault::fm_list(&text, "tags"), vec!["git"]);
        assert_eq!(vault::fm_get(&text, "status").as_deref(), Some("draft"));
        assert!(!text.contains("stale"));

        assert!(for_project(v, "/p/one/").contains("[[Worktrees]] (knowledge/worktrees.md, draft"));
        assert!(for_project(v, "/elsewhere").is_empty());
    }
}
