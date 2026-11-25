//! Session logs: `sessions/.raw/<id>.jsonl` and the Markdown rendered from it.
//!
//! The raw log holds the agent's session events in marq's own shape, whichever agent ran (`init`, `text`,
//! `thinking`, `tool_call`, `tool_result`, `turn_end`; see `sidecar/protocol.ts`), and marq lines so the
//! Markdown can be rebuilt from it alone: `marq_meta` (first line), `marq_user` (each prompt),
//! `marq_approval` and `marq_exit`. Logs from before the events had their own shape hold Agent SDK
//! messages instead; `read_events` translates those.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::{git, vault};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    /// Request id or anchor id.
    pub origin: String,
    pub origin_path: String,
    pub cwd: String,
    pub started: String,
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// A Claude alias (`sonnet`…) or `ollama:<name>`; None is the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// How much the agent reasons (`low`…`max`); None is the agent's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// The agent backend the session runs on; None is Claude.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Set when the session works in its own git worktree.
    #[serde(default)]
    pub worktree: Option<git::Worktree>,
    /// Set when the session is a member of a crew.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crew: Option<crate::crew::CrewRef>,
    /// `on` or `strict`: Bash runs in Claude Code's OS sandbox (see `workflow::sandbox_of`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    /// How the work is checked after each turn, taken from the request when the session started,
    /// so the session cannot change its own check by editing the note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<crate::workflow::Verify>,
    /// Set on an acceptance check: the session whose work it checks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verifies: Option<String>,
    /// The request's phase this session works on, for a request with `phases:`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    /// Directories beyond `cwd` the agent may read and edit, from a workspace or the request.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dirs: Vec<crate::workspace::ExtraDir>,
    /// The workspace note the session's request or crew named, relative to the vault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

impl SessionMeta {
    /// The project the session worked on: its worktree's repository, else the directory it ran in.
    pub fn project(&self) -> &str {
        self.worktree.as_ref().map_or(&self.cwd, |w| &w.repo)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    #[serde(flatten)]
    pub meta: SessionMeta,
    pub status: String,
    pub path: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    /// `done` or `pr` once reviewed, from the latest `marq_review` line.
    pub review: Option<String>,
    pub pr_url: Option<String>,
    /// How full the context was at the end of the latest turn, 0 to 1, when the agent reports it.
    pub context: Option<f64>,
}

/// The latest review state of a session: `open`, `done` or `pr`, and the PR URL if one was made.
pub fn review_of(events: &[Value]) -> (Option<String>, Option<String>) {
    let state = events.iter().rev().find(|e| e["type"] == "marq_review");
    let pr = events.iter().rev().find(|e| e["type"] == "marq_review" && e["url"].is_string());
    (
        state.and_then(|e| e["state"].as_str()).filter(|s| *s != "open").map(str::to_string),
        pr.and_then(|e| e["url"].as_str()).map(str::to_string),
    )
}

/// Records a review state. `done` also closes the origin request; `open` reopens it for review.
/// Returns the origin note's path when it changed.
pub fn set_review(vault: &Path, id: &str, state: &str, url: Option<&str>) -> Result<Option<String>> {
    let mut line = serde_json::json!({"type": "marq_review", "state": state, "at": vault::now()});
    if let Some(u) = url {
        line["url"] = Value::String(u.to_string());
    }
    append(&raw_path(vault, id), &line)?;
    let meta = meta(vault, id)?;
    if meta.crew.is_some() {
        return Ok(None);
    }
    let Some(path) = find_origin(vault, &meta) else { return Ok(None) };
    let text = std::fs::read_to_string(&path)?;
    if vault::fm_get(&text, "id").as_deref() != Some(meta.origin.as_str()) {
        return Ok(None);
    }
    let status = vault::fm_get(&text, "status");
    let next = match (state, status.as_deref()) {
        ("done", Some("running" | "review")) => "done",
        ("open", Some("done")) => "review",
        _ => return Ok(None),
    };
    let t = vault::fm_set(&text, "status", next);
    std::fs::write(&path, vault::fm_set(&t, "updated", &vault::now()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

pub fn raw_path(vault: &Path, id: &str) -> PathBuf {
    vault.join("sessions/.raw").join(format!("{id}.jsonl"))
}

pub fn md_path(vault: &Path, meta: &SessionMeta) -> PathBuf {
    let date = meta.started.get(..10).unwrap_or("0000-00-00");
    let short = meta.id.rsplit('-').next().unwrap_or(&meta.id);
    vault.join("sessions").join(format!("{date}-{}.md", &short[short.len().saturating_sub(8)..]))
}

/// The session's `marq_meta` line.
pub fn meta(vault: &Path, id: &str) -> Result<SessionMeta> {
    meta_of(&read_events(vault, id)?).ok_or_else(|| Error::SessionNotFound(id.to_string()))
}

pub fn read_events(vault: &Path, id: &str) -> Result<Vec<Value>> {
    let text = std::fs::read_to_string(raw_path(vault, id)).map_err(|_| Error::SessionNotFound(id.to_string()))?;
    Ok(text.lines().filter_map(|l| serde_json::from_str(l).ok()).flat_map(upgrade).collect())
}

/// Maps the old `kura_*` / `comb_*` line types to `marq_*`, and Agent SDK messages to session events.
fn upgrade(mut e: Value) -> Vec<Value> {
    if let Some(t) = e["type"].as_str().and_then(|t| t.strip_prefix("kura_").or_else(|| t.strip_prefix("comb_"))) {
        e["type"] = Value::String(format!("marq_{t}"));
    }
    match e["type"].as_str() {
        Some("system" | "assistant" | "user" | "result" | "stream_event") => from_claude_sdk(&e),
        _ => vec![e],
    }
}

/// The session events for an Agent SDK message, as `sidecar/claude.ts` translates them today.
fn from_claude_sdk(m: &Value) -> Vec<Value> {
    use serde_json::json;
    let blocks = || m["message"]["content"].as_array().into_iter().flatten();
    match m["type"].as_str().unwrap_or("") {
        "system" if m["subtype"] == "init" => vec![json!({"type": "init", "agent": "claude", "model": m["model"]})],
        "assistant" => blocks()
            .filter_map(|c| match c["type"].as_str()? {
                "text" => Some(json!({"type": "text", "text": c["text"]})),
                "thinking" => Some(json!({"type": "thinking", "text": c["thinking"]})),
                "tool_use" => {
                    let name = c["name"].as_str().unwrap_or("tool");
                    Some(json!({"type": "tool_call", "id": c["id"], "name": name, "kind": claude_tool_kind(name), "input": c["input"]}))
                }
                _ => None,
            })
            .collect(),
        "user" => blocks()
            .filter(|c| c["type"] == "tool_result")
            .map(|c| json!({"type": "tool_result", "id": c["tool_use_id"], "output": tool_result_text(&c["content"]), "is_error": c["is_error"]}))
            .collect(),
        "result" => vec![json!({
            "type": "turn_end",
            "result": m["result"].as_str().unwrap_or(""),
            "is_error": m["is_error"] == true,
            "cost_usd": m["total_cost_usd"],
            "duration_ms": m["duration_ms"],
            "num_turns": m["num_turns"],
        })],
        _ => vec![],
    }
}

/// The kind of a Claude Code tool, as `TOOL_KINDS` in `sidecar/claude.ts`.
fn claude_tool_kind(name: &str) -> &'static str {
    match name {
        "Read" => "read",
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "edit",
        "Bash" => "execute",
        "Grep" | "Glob" => "search",
        "WebFetch" | "WebSearch" => "fetch",
        _ => "other",
    }
}

/// The first `marq_meta` line, with the latest `marq_worktree`, `marq_model`, `marq_effort`, `marq_mode` and `marq_title` lines applied.
fn meta_of(events: &[Value]) -> Option<SessionMeta> {
    let mut meta: SessionMeta =
        events.first().filter(|e| e["type"] == "marq_meta").and_then(|e| serde_json::from_value(e.clone()).ok())?;
    if let Some(wt) = events.iter().rev().find(|e| e["type"] == "marq_worktree") {
        meta.worktree = serde_json::from_value(wt["worktree"].clone()).ok();
    }
    // A worktree of another directory whose branch changed, latest first.
    for e in events.iter().filter(|e| e["type"] == "marq_dir_worktree") {
        let Ok(wt) = serde_json::from_value::<git::Worktree>(e["worktree"].clone()) else { continue };
        if let Some(d) = meta.dirs.iter_mut().find(|d| d.worktree.as_ref().is_some_and(|w| w.repo == wt.repo)) {
            d.worktree = Some(wt);
        }
    }
    if let Some(m) = events.iter().rev().find(|e| e["type"] == "marq_model") {
        meta.model = m["model"].as_str().map(str::to_string);
    }
    if let Some(m) = events.iter().rev().find(|e| e["type"] == "marq_effort") {
        meta.effort = m["effort"].as_str().map(str::to_string).filter(|e| !e.is_empty());
    }
    if let Some(m) = events.iter().rev().find(|e| e["type"] == "marq_mode") {
        meta.permission_mode = m["mode"].as_str().map(str::to_string).filter(|e| !e.is_empty());
    }
    if let Some(t) = events.iter().rev().find_map(|e| (e["type"] == "marq_title").then(|| e["title"].as_str()).flatten()) {
        meta.title = t.to_string();
    }
    Some(meta)
}

/// `running` while a prompt has no result yet, otherwise how the last turn or process ended.
/// A process that stops after a turn finished cleanly is `done`: only a turn cut off midway is
/// `interrupted`.
pub fn status_of(events: &[Value]) -> String {
    let mut marks = events
        .iter()
        .rev()
        .filter(|e| matches!(e["type"].as_str(), Some("marq_user" | "marq_exit" | "turn_end")));
    match marks.next() {
        Some(e) if e["type"] == "marq_user" => "running".to_string(),
        Some(e) if e["type"] == "turn_end" && e["is_error"] == true => "error".to_string(),
        Some(e) if e["type"] == "marq_exit" => match e["status"].as_str() {
            Some("error") => "error".to_string(),
            Some("stopped" | "interrupted") => {
                let finished = marks.find(|m| m["type"] != "marq_exit").is_some_and(|m| m["type"] == "turn_end" && m["is_error"] != true);
                if finished { "done" } else { "interrupted" }.to_string()
            }
            _ => "done".to_string(),
        },
        _ => "done".to_string(),
    }
}

/// Lists sessions, optionally only those started from `origin`.
/// `list` cache per raw log: the parsed log, plus worktree data refreshed on change or after `GIT_TTL`.
struct Cached {
    log: (SystemTime, u64),
    info: SessionInfo,
    git: Option<GitCache>,
}

struct GitCache {
    log: (SystemTime, u64),
    state: Option<(SystemTime, SystemTime)>,
    at: Instant,
    branch: String,
    stat: Option<(u32, u32)>,
}

const GIT_TTL: Duration = Duration::from_secs(30);

fn list_cache() -> &'static Mutex<HashMap<PathBuf, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Cached>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The session's workspace: the one it recorded, else the one its origin note names now (sessions
/// from before workspaces were recorded).
pub fn workspace_of(vault: &Path, meta: &SessionMeta) -> Option<String> {
    meta.workspace.clone().or_else(|| {
        if meta.origin_path.is_empty() {
            return None;
        }
        let text = std::fs::read_to_string(vault.join(&meta.origin_path)).ok()?;
        let name = vault::fm_get(&text, "workspace").filter(|w| !w.trim().is_empty())?;
        Some(crate::workspace::find(vault, &name).map_or(name, |w| w.rel))
    })
}

/// A list entry without worktree data.
fn info_of(vault: &Path, events: &[Value]) -> Option<SessionInfo> {
    let mut meta = meta_of(events)?;
    meta.workspace = workspace_of(vault, &meta);
    let (review, pr_url) = review_of(events);
    Some(SessionInfo {
        status: status_of(events),
        path: md_path(vault, &meta).to_string_lossy().into_owned(),
        additions: None,
        deletions: None,
        review,
        pr_url,
        context: events.iter().rev().find(|e| e["type"] == "turn_end").and_then(|e| e["context"].as_f64()),
        meta,
    })
}

/// A session whose worktree data needs refreshing: its log path, worktree, log stamp and state stamp.
type Stale = (PathBuf, git::Worktree, (SystemTime, u64), Option<(SystemTime, SystemTime)>);

pub fn list(vault: &Path, origin: Option<&str>) -> Vec<SessionInfo> {
    let Ok(dir) = std::fs::read_dir(vault.join("sessions/.raw")) else {
        return vec![];
    };
    let logs: Vec<(PathBuf, (SystemTime, u64))> = dir
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((e.path(), (m.modified().ok()?, m.len())))
        })
        .collect();

    // Re-parse only changed logs.
    let mut cache = list_cache().lock().unwrap();
    cache.retain(|path, _| logs.iter().any(|(p, _)| p == path));
    for (path, stamp) in &logs {
        if cache.get(path).is_some_and(|c| c.log == *stamp) {
            continue;
        }
        let Some(id) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else { continue };
        let Some(info) = read_events(vault, &id).ok().and_then(|ev| info_of(vault, &ev)) else {
            cache.remove(path);
            continue;
        };
        let git = cache.remove(path).and_then(|c| c.git);
        cache.insert(path.clone(), Cached { log: *stamp, info, git });
    }

    // Refresh stale worktree data, 8 sessions in parallel.
    let stale: Vec<Stale> = cache
        .iter()
        .filter(|(_, c)| origin.is_none_or(|o| o == c.info.meta.origin))
        .filter_map(|(path, c)| {
            let wt = c.info.meta.worktree.clone()?;
            let state = git::state_stamp(&wt);
            let fresh = c.git.as_ref().is_some_and(|g| g.log == c.log && g.state == state && g.at.elapsed() < GIT_TTL);
            (!fresh).then(|| (path.clone(), wt, c.log, state))
        })
        .collect();
    drop(cache);
    let mut computed = Vec::with_capacity(stale.len());
    for chunk in stale.chunks(8) {
        std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|(path, wt, log, state)| {
                    scope.spawn(move || {
                        let branch = git::head_branch(wt).unwrap_or_else(|| wt.branch.clone());
                        let stat = git::diffstat(wt).ok();
                        (path.clone(), GitCache { log: *log, state: *state, at: Instant::now(), branch, stat })
                    })
                })
                .collect();
            computed.extend(handles.into_iter().filter_map(|h| h.join().ok()));
        });
    }

    let mut cache = list_cache().lock().unwrap();
    for (path, g) in computed {
        if let Some(c) = cache.get_mut(&path) {
            c.git = Some(g);
        }
    }
    let mut out: Vec<SessionInfo> = cache
        .values()
        .filter(|c| origin.is_none_or(|o| o == c.info.meta.origin))
        .map(|c| {
            let mut info = c.info.clone();
            if let (Some(wt), Some(g)) = (info.meta.worktree.as_mut(), &c.git) {
                wt.branch = g.branch.clone();
                info.additions = g.stat.map(|s| s.0);
                info.deletions = g.stat.map(|s| s.1);
            }
            info
        })
        .collect();
    out.sort_by(|a, b| b.meta.started.cmp(&a.meta.started));
    out
}

pub fn append(path: &Path, value: &Value) -> Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(f, "{value}")?;
    Ok(())
}

/// Writes the last successful result into the origin note and moves a request to `review`.
/// Called at the end of each turn. Returns the changed path.
pub fn write_back(vault: &Path, id: &str) -> Result<Option<String>> {
    let events = read_events(vault, id)?;
    let Some(meta) = meta_of(&events) else { return Ok(None) };
    // A crew member's results go to the crew's timeline, not into the crew note, and an acceptance
    // check's verdict goes to the session it checks.
    if meta.crew.is_some() || meta.verifies.is_some() {
        return Ok(None);
    }
    let Some(result) = last_result(&events) else {
        return Ok(None);
    };
    let Some(path) = find_origin(vault, &meta) else { return Ok(None) };
    let text = std::fs::read_to_string(&path)?;
    let is_request = vault::fm_get(&text, "id").as_deref() == Some(meta.origin.as_str());
    let text = if is_request {
        let t = vault::write_result(&text, None, id, result);
        let t = vault::fm_set(&t, "status", "review");
        vault::fm_set(&t, "updated", &vault::now())
    } else {
        vault::write_result(&text, Some(&meta.origin), id, result)
    };
    std::fs::write(&path, text)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// The reply of the last turn, unless it failed.
pub fn last_result(events: &[Value]) -> Option<&str> {
    events.iter().rev().find(|e| e["type"] == "turn_end").filter(|e| e["is_error"] != true).and_then(|e| e["result"].as_str())
}

/// The origin note: `origin_path` if it still holds the id, otherwise a vault scan, so renames are fine.
pub fn find_origin(vault: &Path, meta: &SessionMeta) -> Option<PathBuf> {
    let holds = |p: &Path| {
        std::fs::read_to_string(p).is_ok_and(|t| {
            vault::fm_get(&t, "id").as_deref() == Some(meta.origin.as_str())
                || vault::anchors(&t).iter().any(|a| a.id == meta.origin)
        })
    };
    let hint = vault.join(&meta.origin_path);
    if holds(&hint) {
        return Some(hint);
    }
    vault::list_files(vault).into_iter().map(|f| PathBuf::from(f.path)).find(|p| holds(p))
}

/// Renames a session. Appended like a worktree change, so it is safe while the session runs.
pub fn set_title(vault: &Path, id: &str, title: &str) -> Result<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(Error::Other("the title is empty".into()));
    }
    append(&raw_path(vault, id), &serde_json::json!({"type": "marq_title", "title": title}))?;
    rerender(vault, id)
}

/// Records a changed worktree, e.g. after the branch was renamed. The log is only appended to,
/// so this is safe while the session is running and writing to it.
pub fn update_worktree(vault: &Path, id: &str, wt: &git::Worktree) -> Result<()> {
    append(&raw_path(vault, id), &serde_json::json!({"type": "marq_worktree", "worktree": wt}))?;
    rerender(vault, id)
}

/// The worktree of `repo` (the session's own, or one of its other directories') with its current
/// branch, recording the branch when it changed. `None` for the session's own.
pub fn worktree_for(vault: &Path, id: &str, repo: Option<&str>) -> Result<Option<git::Worktree>> {
    let meta = meta(vault, id)?;
    let Some(repo) = repo.filter(|r| meta.worktree.as_ref().is_none_or(|w| w.repo != *r)) else { return current_worktree(vault, id) };
    let Some(wt) = meta.dirs.into_iter().find_map(|d| d.worktree.filter(|w| w.repo == repo)) else { return Ok(None) };
    let synced = git::sync_branch(&wt)?;
    if synced.branch != wt.branch {
        update_dir_worktree(vault, id, &synced)?;
    }
    Ok(Some(synced))
}

/// Records a changed worktree of one of the session's other directories.
pub fn update_dir_worktree(vault: &Path, id: &str, wt: &git::Worktree) -> Result<()> {
    append(&raw_path(vault, id), &serde_json::json!({"type": "marq_dir_worktree", "worktree": wt}))?;
    rerender(vault, id)
}

/// The session's worktree with its current branch, recording the branch when it changed.
pub fn current_worktree(vault: &Path, id: &str) -> Result<Option<git::Worktree>> {
    let Some(wt) = meta(vault, id)?.worktree else { return Ok(None) };
    let synced = git::sync_branch(&wt)?;
    if synced.branch != wt.branch {
        update_worktree(vault, id, &synced)?;
    }
    Ok(Some(synced))
}

/// Whether the agent ever started the session's conversation, so it can be resumed.
pub fn has_conversation(events: &[Value]) -> bool {
    events.iter().any(|e| matches!(e["type"].as_str(), Some("init" | "text" | "thinking" | "tool_call")))
}

/// The first prompt of a session.
pub fn first_prompt(events: &[Value]) -> Option<String> {
    events.iter().find(|e| e["type"] == "marq_user").and_then(|e| e["text"].as_str()).map(str::to_string)
}

/// Records that a session's process is gone without a result, e.g. after the app crashed.
pub fn mark_interrupted(vault: &Path, id: &str) -> Result<()> {
    append(&raw_path(vault, id), &serde_json::json!({"type": "marq_exit", "status": "interrupted", "ended": vault::now()}))?;
    rerender(vault, id)
}

/// Moves the session's log and note to the Trash and removes it from its origin note:
/// the result block, the id in `sessions:`, and a `running` status goes back to `todo`.
/// Returns the origin note's path if it changed.
pub fn delete(vault: &Path, id: &str) -> Result<Option<String>> {
    let meta = meta(vault, id)?;
    let mut changed = None;
    if let Some(path) = find_origin(vault, &meta) {
        let text = std::fs::read_to_string(&path)?;
        let mut t = vault::remove_result(&text, id);
        if vault::fm_get(&t, "id").as_deref() == Some(meta.origin.as_str()) {
            t = vault::fm_remove_item(&t, "sessions", id);
            if vault::fm_get(&t, "status").as_deref() == Some("running") {
                t = vault::fm_set(&t, "status", "todo");
            }
        }
        if t != text {
            std::fs::write(&path, t)?;
            changed = Some(path.to_string_lossy().into_owned());
        }
    }
    for p in [md_path(vault, &meta), raw_path(vault, id)] {
        if p.exists() {
            vault::move_to_trash(&p)?;
        }
    }
    Ok(changed)
}

/// The hand-editable part of a session file: from `## Summary` up to `## Transcript`.
fn notes_range(body: &str) -> Option<(usize, usize)> {
    let start = body.find("## Summary")?;
    let end = body.find("\n## Transcript").unwrap_or(body.len());
    Some((start, end))
}

/// Adds a bullet to `## Learnings`. Rendering keeps it because that part of the file is hand-editable.
pub fn append_learning(vault: &Path, id: &str, text: &str) -> Result<()> {
    let path = md_path(vault, &meta(vault, id)?);
    let file = std::fs::read_to_string(&path)?;
    let (_, end) = notes_range(&file).ok_or_else(|| Error::Other("no ## Summary in the session file".into()))?;
    let (head, tail) = file.split_at(end);
    let head = head.trim_end().trim_end_matches("\n-").trim_end();
    let mut head = if head.contains("## Learnings") { head.to_string() } else { format!("{head}\n\n## Learnings") };
    if head.ends_with("## Learnings") {
        head.push('\n');
    }
    let bullet = text.trim().replace('\n', " ");
    std::fs::write(&path, format!("{head}\n- {bullet}\n{tail}"))?;
    Ok(())
}

/// Rewrites the session Markdown from the raw log, keeping hand-edited Summary and Learnings.
pub fn rerender(vault: &Path, id: &str) -> Result<()> {
    let events = read_events(vault, id)?;
    let mut meta = meta_of(&events).ok_or_else(|| Error::SessionNotFound(id.to_string()))?;
    meta.workspace = workspace_of(vault, &meta);
    let path = md_path(vault, &meta);
    let kept = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| {
            let (_, body) = vault::split_frontmatter(&t);
            let (start, end) = notes_range(body)?;
            Some(body[start..end].trim().to_string())
        })
        .filter(|k| k.lines().any(|l| !l.trim().is_empty() && !l.starts_with("## ") && l.trim() != "-"));
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, render(&meta, &events, kept.as_deref()))?;
    Ok(())
}

fn tool_arg(input: &Value) -> String {
    ["file_path", "command", "pattern", "path", "url", "query", "description"]
        .iter()
        .find_map(|k| input[k].as_str())
        .map(str::to_string)
        .unwrap_or_else(|| serde_json::to_string_pretty(input).unwrap_or_default())
}

fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().filter_map(|i| i["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// A fence longer than any backtick run in `s`, so tool output cannot close it early.
fn fence(s: &str) -> String {
    let longest = s.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    "`".repeat(longest.max(2) + 1)
}

pub fn render(meta: &SessionMeta, events: &[Value], kept: Option<&str>) -> String {
    let mut model = String::new();
    let mut cost = 0.0;
    let mut files: Vec<String> = vec![];
    let mut docs: Vec<String> = vec![];
    let mut last_result = None;
    let mut transcript = String::new();
    let mut last_role = "";
    let mut role = |t: &mut String, r: &'static str| {
        if last_role != r {
            t.push_str(if r == "user" { "\n### 👤 User\n\n" } else { "\n### 🤖 Assistant\n\n" });
            last_role = r;
        }
    };
    for e in events {
        match e["type"].as_str().unwrap_or("") {
            "init" => model = e["model"].as_str().unwrap_or("").to_string(),
            "marq_user" => {
                role(&mut transcript, "user");
                transcript.push_str(e["text"].as_str().unwrap_or("").trim());
                transcript.push('\n');
            }
            "text" => {
                role(&mut transcript, "assistant");
                transcript.push_str(e["text"].as_str().unwrap_or("").trim());
                transcript.push_str("\n\n");
            }
            "tool_call" => {
                role(&mut transcript, "assistant");
                let name = e["name"].as_str().unwrap_or("tool");
                let arg = tool_arg(&e["input"]);
                if e["kind"] == "edit" && !files.contains(&arg) {
                    files.push(arg.clone());
                }
                let f = fence(&arg);
                transcript.push_str(&format!("{f}tool:{name}\n{}\n{f}\n\n", arg.trim_end()));
            }
            "tool_result" => {
                let out = e["output"].as_str().unwrap_or("");
                if out.trim().is_empty() {
                    continue;
                }
                let f = fence(out);
                let block = format!("{f}text\n{}\n{f}", out.trim_end());
                if out.lines().count() > 20 {
                    transcript.push_str(&format!("<details><summary>result</summary>\n\n{block}\n\n</details>\n\n"));
                } else {
                    transcript.push_str(&format!("{block}\n\n"));
                }
            }
            "marq_verify" if e["passed"].is_boolean() => {
                role(&mut transcript, "assistant");
                let what = match e["command"].as_str() {
                    Some(c) => format!("Check `{c}`"),
                    None => "Acceptance check".to_string(),
                };
                let (mark, verdict) = if e["passed"] == true { ("✅", "passed") } else { ("❌", "failed") };
                let attempt = match (e["attempt"].as_u64(), e["of"].as_u64()) {
                    (Some(a), Some(n)) if e["passed"] == false => format!(" (attempt {a} of {n})"),
                    _ => String::new(),
                };
                transcript.push_str(&format!("{mark} {what} {verdict}{attempt}\n\n"));
                let out = e["output"].as_str().unwrap_or("").trim_end();
                if !out.is_empty() {
                    let f = fence(out);
                    transcript.push_str(&format!("<details><summary>output</summary>\n\n{f}text\n{out}\n{f}\n\n</details>\n\n"));
                }
            }
            "marq_phase" => {
                role(&mut transcript, "assistant");
                transcript.push_str(&format!(
                    "⏭ Phase {} done. Next: {}\n\n",
                    e["done"].as_str().unwrap_or(""),
                    e["next"].as_str().unwrap_or("")
                ));
            }
            "marq_doc" => {
                role(&mut transcript, "assistant");
                let path = e["path"].as_str().unwrap_or("");
                let verb = if e["created"] == false { "Updated" } else { "Saved" };
                // Session files live in sessions/, so links go up one level to the vault root.
                transcript.push_str(&format!(
                    "📄 {verb} [{}](../{})\n\n",
                    e["title"].as_str().unwrap_or(path),
                    path.replace(' ', "%20")
                ));
                if !docs.contains(&path.to_string()) {
                    docs.push(path.to_string());
                }
            }
            "turn_end" => {
                cost += e["cost_usd"].as_f64().unwrap_or(0.0);
                last_result = e["result"].as_str();
            }
            _ => {}
        }
    }
    let status = status_of(events);
    let ended = events
        .iter()
        .rev()
        .find(|e| e["type"] == "marq_exit")
        .and_then(|e| e["ended"].as_str())
        .filter(|_| status != "running")
        .unwrap_or("");
    let summary = match kept {
        Some(k) => k.to_string(),
        None => format!("## Summary\n\n{}\n\n## Learnings\n\n-", last_result.unwrap_or("").trim()),
    };
    let q = |s: &str| serde_json::to_string(s).unwrap();
    format!(
        "---\nid: {}\ntype: session\ntitle: {}\norigin: {}\norigin_path: {}\ncwd: {}\nproject: {}\n{}branch: {}\nmodel: {}\nstatus: {}\nstarted: {}\nended: {}\ncost_usd: {:.4}\nfiles_changed: [{}]\ndocs: [{}]\n---\n{}\n\n## Transcript\n{}",
        meta.id,
        q(&meta.title),
        meta.origin,
        q(&meta.origin_path),
        q(&meta.cwd),
        q(meta.project()),
        meta.workspace.as_ref().map(|w| format!("workspace: {}\n", q(w))).unwrap_or_default(),
        meta.worktree.as_ref().map(|w| w.branch.as_str()).unwrap_or(""),
        model,
        status,
        meta.started,
        ended,
        cost,
        files.iter().map(|f| q(f)).collect::<Vec<_>>().join(", "),
        docs.iter().map(|f| q(f)).collect::<Vec<_>>().join(", "),
        summary,
        transcript.trim_end().to_string() + "\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta() -> SessionMeta {
        SessionMeta {
            id: "0192f0c5-0000-7000-8000-00000000abcd".into(),
            title: "t".into(),
            origin: "o1".into(),
            origin_path: "requests/r.md".into(),
            cwd: "~/dev".into(),
            started: "2026-10-27T10:00:00+09:00".into(),
            permission_mode: None,
            model: None,
            agent: None,
            worktree: None,
            crew: None,
            ..Default::default()
        }
    }

    #[test]
    fn renders_transcript() {
        let mut m = serde_json::to_value(meta()).unwrap();
        m["type"] = json!("marq_meta");
        let events = vec![
            m,
            json!({"type": "marq_user", "text": "read a.txt"}),
            json!({"type": "init", "agent": "claude", "model": "claude-haiku-5-5"}),
            json!({"type": "tool_call", "id": "t1", "name": "Read", "kind": "read", "input": {"file_path": "a.txt"}}),
            json!({"type": "tool_result", "id": "t1", "output": "1\tline ```one"}),
            json!({"type": "tool_call", "id": "t2", "name": "write_file", "kind": "edit", "input": {"path": "b.txt"}}),
            json!({"type": "thinking", "text": "x"}),
            json!({"type": "text", "text": "line one"}),
            json!({"type": "marq_doc", "path": "docs/2026-10-27-plan.md", "title": "Plan", "created": true}),
            json!({"type": "turn_end", "result": "line one", "is_error": false, "cost_usd": 0.01}),
            json!({"type": "marq_exit", "status": "done", "ended": "2026-10-27T10:01:00+09:00"}),
        ];
        let md = render(&meta(), &events, None);
        assert!(md.contains("status: done\n"));
        assert!(md.contains("cost_usd: 0.0100\n"));
        assert!(md.contains("files_changed: [\"b.txt\"]"));
        assert!(md.contains("model: claude-haiku-5-5\n"));
        assert!(md.contains("## Summary\n\nline one\n"));
        assert!(md.contains("```tool:Read\na.txt\n```"));
        assert!(md.contains("📄 Saved [Plan](../docs/2026-10-27-plan.md)"));
        assert!(md.contains("docs: [\"docs/2026-10-27-plan.md\"]"));
        assert!(md.contains("````text\n1\tline ```one\n````"));
        assert!(!md.contains("\nx\n"));
        assert_eq!(md_path(Path::new("/v"), &meta()), Path::new("/v/sessions/2026-10-27-0000abcd.md"));
    }

    #[test]
    fn learnings_survive_rerender() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        let mut m = serde_json::to_value(meta()).unwrap();
        m["type"] = json!("marq_meta");
        std::fs::create_dir_all(v.join("sessions/.raw")).unwrap();
        let raw = raw_path(v, &meta().id);
        append(&raw, &m).unwrap();
        append(&raw, &json!({"type": "marq_user", "text": "hi"})).unwrap();
        rerender(v, &meta().id).unwrap();
        append_learning(v, &meta().id, "mq select yields None").unwrap();
        append_learning(v, &meta().id, "second").unwrap();
        append(&raw, &json!({"type": "turn_end", "result": "ok", "is_error": false})).unwrap();
        rerender(v, &meta().id).unwrap();
        let md = std::fs::read_to_string(md_path(v, &meta())).unwrap();
        assert!(md.contains("## Learnings\n\n- mq select yields None\n- second\n"), "{md}");
    }

    #[test]
    fn reads_logs_from_before_the_rename() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        std::fs::create_dir_all(v.join("sessions/.raw")).unwrap();
        let mut m = serde_json::to_value(meta()).unwrap();
        m["type"] = json!("kura_meta");
        append(&raw_path(v, &meta().id), &m).unwrap();
        append(&raw_path(v, &meta().id), &json!({"type": "kura_user", "text": "hi"})).unwrap();
        append(&raw_path(v, &meta().id), &json!({"type": "comb_user", "text": "again"})).unwrap();
        let events = read_events(v, &meta().id).unwrap();
        assert_eq!(events[0]["type"], "marq_meta");
        assert_eq!(events[2]["type"], "marq_user");
        assert_eq!(status_of(&events), "running");
        assert!(super::meta(v, &meta().id).is_ok());
    }

    #[test]
    fn knows_whether_a_conversation_started() {
        let failed = vec![json!({"type": "marq_meta"}), json!({"type": "marq_user", "text": "do it"}), json!({"type": "marq_exit", "status": "error"})];
        assert!(!has_conversation(&failed));
        assert_eq!(first_prompt(&failed).as_deref(), Some("do it"));
        let mut started = failed.clone();
        started.insert(2, json!({"type": "init", "agent": "claude"}));
        assert!(has_conversation(&started));
    }

    #[test]
    fn reads_agent_sdk_messages_as_session_events() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        std::fs::create_dir_all(v.join("sessions/.raw")).unwrap();
        let mut m = serde_json::to_value(meta()).unwrap();
        m["type"] = json!("marq_meta");
        let raw = raw_path(v, &meta().id);
        for line in [
            m,
            json!({"type": "marq_user", "text": "edit a.txt"}),
            json!({"type": "system", "subtype": "init", "model": "claude-haiku-5-5"}),
            json!({"type": "stream_event", "event": {}}),
            json!({"type": "assistant", "message": {"content": [
                {"type": "thinking", "thinking": "x"},
                {"type": "text", "text": "ok"},
                {"type": "tool_use", "id": "t1", "name": "Edit", "input": {"file_path": "a.txt"}},
            ]}}),
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "done"}]}]}}),
            json!({"type": "result", "subtype": "error_during_execution", "is_error": true, "total_cost_usd": 0.02, "num_turns": 2}),
        ] {
            append(&raw, &line).unwrap();
        }
        let events = read_events(v, &meta().id).unwrap();
        let types: Vec<&str> = events.iter().filter_map(|e| e["type"].as_str()).collect();
        assert_eq!(types, ["marq_meta", "marq_user", "init", "thinking", "text", "tool_call", "tool_result", "turn_end"]);
        assert_eq!(events[2]["model"], "claude-haiku-5-5");
        assert_eq!((&events[5]["kind"], &events[5]["name"]), (&json!("edit"), &json!("Edit")));
        assert_eq!((&events[6]["id"], &events[6]["output"]), (&json!("t1"), &json!("done")));
        assert_eq!((&events[7]["result"], &events[7]["cost_usd"]), (&json!(""), &json!(0.02)));
        assert_eq!(status_of(&events), "error");
        assert!(has_conversation(&events));
        assert_eq!(last_result(&events), None);
    }

    #[test]
    fn latest_worktree_line_wins() {
        let wt = |b: &str| json!({"repo": "/r", "path": "/w", "branch": b, "base": "x", "base_branch": "main"});
        let mut m = serde_json::to_value(meta()).unwrap();
        m["type"] = json!("marq_meta");
        m["worktree"] = wt("marq/a");
        let events = vec![m, json!({"type": "marq_worktree", "worktree": wt("marq/b")}), json!({"type": "marq_worktree", "worktree": wt("feature/c")})];
        assert_eq!(meta_of(&events).unwrap().worktree.unwrap().branch, "feature/c");
    }

    #[test]
    fn a_stop_after_a_finished_turn_is_done() {
        let ev = |t: &str, extra: Value| {
            let mut v = serde_json::json!({"type": t});
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        let user = ev("marq_user", serde_json::json!({}));
        let end = ev("turn_end", serde_json::json!({"is_error": false}));
        let stop = ev("marq_exit", serde_json::json!({"status": "stopped"}));
        assert_eq!(status_of(&[user.clone(), end, stop.clone()]), "done");
        assert_eq!(status_of(&[user, stop]), "interrupted");
    }

    #[test]
    fn review_state() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        std::fs::create_dir_all(v.join("requests")).unwrap();
        std::fs::write(v.join("requests/r.md"), "---\nid: o1\ntype: request\nstatus: review\n---\n## Request\n").unwrap();
        let mut m = serde_json::to_value(meta()).unwrap();
        m["type"] = json!("marq_meta");
        std::fs::create_dir_all(v.join("sessions/.raw")).unwrap();
        append(&raw_path(v, &meta().id), &m).unwrap();
        append(&raw_path(v, &meta().id), &json!({"type": "marq_user", "text": "x"})).unwrap();

        assert_eq!(review_of(&read_events(v, &meta().id).unwrap()), (None, None));
        set_review(v, &meta().id, "pr", Some("https://example.com/pr/1")).unwrap();
        assert_eq!(review_of(&read_events(v, &meta().id).unwrap()), (Some("pr".into()), Some("https://example.com/pr/1".into())));
        assert!(set_review(v, &meta().id, "done", None).unwrap().is_some());
        let note = std::fs::read_to_string(v.join("requests/r.md")).unwrap();
        assert_eq!(vault::fm_get(&note, "status").as_deref(), Some("done"));
        set_review(v, &meta().id, "open", None).unwrap();
        let (state, url) = review_of(&read_events(v, &meta().id).unwrap());
        assert_eq!((state, url.as_deref()), (None, Some("https://example.com/pr/1")));
        let note = std::fs::read_to_string(v.join("requests/r.md")).unwrap();
        assert_eq!(vault::fm_get(&note, "status").as_deref(), Some("review"));
    }

    #[test]
    fn running_until_exit() {
        let events = vec![json!({"type": "marq_exit", "status": "done"}), json!({"type": "marq_user", "text": "more"})];
        assert_eq!(status_of(&events), "running");
    }
}
