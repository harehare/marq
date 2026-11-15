//! The inbox: a durable list of things that want the user's attention.
//!
//! Everything that needs you (an approval request, a session that stopped with an
//! error) is first written here as one event, then shown in the sidebar. The file
//! `<vault>/.marq/inbox.json` is the source of truth, so nothing is lost when the window closes
//! or the app restarts.
//!
//! - An event has a `source` key (`approval:<request>`, `error:<session>`).
//!   Pushing an event whose key is still pending updates it instead of adding another one.
//! - `status` is `pending`, then `done` (handled) or `dismissed` (dropped by the user). Resolved
//!   events are kept for a while as history and trimmed to the newest `KEEP`.
//! - `schedule`, `request` and `followup` events are work to do rather than news: queued `pending`
//!   (a schedule fell due, the user queued a request, a follow-up timer fired), `running` while a
//!   worker has it, then `done` or `failed` (which stays until dismissed). Queued schedules and
//!   follow-ups cannot be dismissed, or they would be queued again at once.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::error::Result;
use crate::vault;

const KEEP: usize = 200;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Event {
    pub id: String,
    /// `approval`, `result`, `error`, `schedule`, `request` or `followup`.
    pub kind: String,
    /// Dedupe key; see the module docs.
    pub source: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub session_id: Option<String>,
    /// `pending`, `running`, `failed`, `done` or `dismissed`.
    pub status: String,
    pub created: String,
    pub updated: String,
}

#[derive(Default)]
pub struct Inbox {
    /// Serializes read-modify-write cycles on the file.
    lock: Mutex<()>,
}

fn file(vault: &Path) -> PathBuf {
    vault.join(".marq/inbox.json")
}

fn load(vault: &Path) -> Vec<Event> {
    std::fs::read_to_string(file(vault)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(vault: &Path, events: &[Event]) -> Result<()> {
    let path = file(vault);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Written beside the file and renamed, so a crash never leaves half an inbox.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(events).map_err(|e| crate::error::Error::Other(e.to_string()))?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

/// Adds the event, or refreshes the pending one with the same `source`.
fn upsert(events: &mut Vec<Event>, mut new: Event) {
    if let Some(old) = events.iter_mut().find(|e| e.source == new.source && (e.status == "pending" || e.status == "running")) {
        old.title = new.title;
        old.body = new.body;
        old.updated = new.updated;
        return;
    }
    new.status = "pending".into();
    events.push(new);
}

/// Marks pending events matching `pred` as `status`; true when any changed.
fn resolve(events: &mut [Event], status: &str, pred: impl Fn(&Event) -> bool) -> bool {
    let now = vault::now();
    let mut changed = false;
    // Queued schedules and running work are not the user's to resolve; see the module docs.
    let open = |e: &Event| (e.status == "pending" && !pinned(&e.kind)) || e.status == "failed";
    for e in events.iter_mut().filter(|e| open(e) && pred(e)) {
        e.status = status.into();
        e.updated = now.clone();
        changed = true;
    }
    changed
}

/// Kinds whose queued events the user cannot dismiss: the source would queue them again.
fn pinned(kind: &str) -> bool {
    kind == "schedule" || kind == "followup"
}

fn resolved(e: &Event) -> bool {
    e.status == "done" || e.status == "dismissed"
}

fn trim(events: &mut Vec<Event>) {
    let pending = events.iter().filter(|e| !resolved(e)).count();
    let mut room = KEEP.saturating_sub(pending);
    // Events are oldest first. Pending ones are never dropped; of the resolved, the newest stay.
    let mut keep: Vec<bool> = events
        .iter()
        .rev()
        .map(|e| {
            if !resolved(e) {
                return true;
            }
            let ok = room > 0;
            room = room.saturating_sub(1);
            ok
        })
        .collect();
    keep.reverse();
    let mut i = 0;
    events.retain(|_| {
        i += 1;
        keep[i - 1]
    });
}

impl Inbox {
    fn edit(&self, app: &AppHandle, f: impl FnOnce(&mut Vec<Event>) -> bool) {
        let Some(vault) = app.state::<crate::automation::Automation>().vault() else { return };
        let _guard = self.lock.lock().unwrap();
        let mut events = load(&vault);
        if f(&mut events) {
            trim(&mut events);
            if let Err(e) = save(&vault, &events) {
                eprintln!("marq: could not save the inbox: {e}");
                return;
            }
            let _ = app.emit("inbox://changed", ());
        }
    }
}

fn push(app: &AppHandle, kind: &str, source: String, title: String, body: String, session_id: &str) {
    let now = vault::now();
    let event = Event {
        id: vault::new_id(),
        kind: kind.into(),
        source,
        title,
        body,
        session_id: Some(session_id.to_string()),
        status: "pending".into(),
        created: now.clone(),
        updated: now,
    };
    app.state::<Inbox>().edit(app, |events| {
        upsert(events, event);
        true
    });
}

fn resolve_where(app: &AppHandle, status: &'static str, pred: impl Fn(&Event) -> bool) {
    app.state::<Inbox>().edit(app, |events| resolve(events, status, pred));
}

/// Closes what the inbox still holds for a session the user has marked done.
pub fn resolve_session(app: &AppHandle, session: &str) {
    resolve_where(app, "done", |e| e.session_id.as_deref() == Some(session));
}

/// Queues `kind` work (see the module docs) unless the same `source` is already queued or running.
/// True when it was added.
pub fn enqueue(app: &AppHandle, kind: &str, source: &str, title: &str, body: &str, session_id: Option<&str>) -> bool {
    let now = vault::now();
    let event = Event {
        id: vault::new_id(),
        kind: kind.into(),
        source: source.into(),
        title: title.into(),
        body: body.chars().take(2000).collect(),
        session_id: session_id.map(str::to_string),
        status: "pending".into(),
        created: now.clone(),
        updated: now,
    };
    let mut added = false;
    app.state::<Inbox>().edit(app, |events| {
        if events.iter().any(|e| e.source == event.source && (e.status == "pending" || e.status == "running")) {
            return false;
        }
        events.push(event);
        added = true;
        true
    });
    added
}

/// Hands out the oldest queued `kind` events that are `ready`, at most `n`, marking them `running`. The first call
/// after startup puts events a dead process left `running` back in the queue.
pub fn claim(app: &AppHandle, kind: &str, n: usize, ready: impl Fn(&Event) -> bool) -> Vec<Event> {
    static FIRST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
    let reset = FIRST.swap(false, std::sync::atomic::Ordering::SeqCst);
    let mut claimed = vec![];
    app.state::<Inbox>().edit(app, |events| {
        let now = vault::now();
        let mut changed = false;
        if reset {
            for e in events.iter_mut().filter(|e| e.kind == kind && e.status == "running") {
                e.status = "pending".into();
                changed = true;
            }
        }
        for e in events.iter_mut().filter(|e| e.kind == kind && e.status == "pending" && ready(e)).take(n) {
            e.status = "running".into();
            e.updated = now.clone();
            claimed.push(e.clone());
            changed = true;
        }
        changed
    });
    claimed
}

/// Ends a claimed event as `done`, or as `failed` with the reason in `body`.
pub fn finish(app: &AppHandle, id: &str, ok: bool, body: &str, session_id: Option<String>) {
    app.state::<Inbox>().edit(app, |events| {
        let Some(e) = events.iter_mut().find(|e| e.id == id) else { return false };
        e.status = if ok { "done" } else { "failed" }.into();
        e.body = body.chars().take(500).collect();
        e.session_id = session_id.or_else(|| e.session_id.clone());
        e.updated = vault::now();
        true
    });
}

/// Follows the sessions' events and records the ones that need the user. Called once at startup.
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    app.listen("session://approval", move |e| {
        let Ok(v) = serde_json::from_str::<Value>(e.payload()) else { return };
        let (Some(session), Some(request)) = (v["session_id"].as_str(), v["request_id"].as_str()) else { return };
        let source = format!("approval:{request}");
        if v["answered"].as_bool() == Some(true) {
            resolve_where(&handle, "done", |e| e.source == source);
            return;
        }
        let tool = v["tool_name"].as_str().unwrap_or("");
        let what = v["title"]
            .as_str()
            .or_else(|| ["command", "file_path", "url"].iter().find_map(|k| v["input"][k].as_str()))
            .unwrap_or("");
        let title = if tool.is_empty() { "Needs your approval".to_string() } else { format!("Needs your approval · {tool}") };
        push(&handle, "approval", source, title, what.chars().take(300).collect(), session);
    });
    let handle = app.clone();
    app.listen("session://exit", move |e| {
        let Ok(v) = serde_json::from_str::<Value>(e.payload()) else { return };
        let Some(session) = v["session_id"].as_str() else { return };
        // An approval no longer waits once the session has ended.
        resolve_where(&handle, "dismissed", |e| e.kind == "approval" && e.session_id.as_deref() == Some(session));
        if v["status"].as_str() == Some("error") {
            let why = v["stderr"].as_str().unwrap_or("").trim().lines().last().unwrap_or("").to_string();
            push(&handle, "error", format!("error:{session}"), "Stopped with an error".into(), why, session);
        }
    });
}

#[tauri::command]
pub fn inbox_list(app: AppHandle, vault: String) -> Vec<Event> {
    let inbox = app.state::<Inbox>();
    let _guard = inbox.lock.lock().unwrap();
    let mut events = load(Path::new(&vault));
    events.reverse();
    events
}

/// Marks one event, or with no `id` every pending event of `session_id`, as `done` or `dismissed`.
#[tauri::command]
pub fn inbox_resolve(app: AppHandle, id: Option<String>, session_id: Option<String>, status: String) {
    let status: &'static str = if status == "dismissed" { "dismissed" } else { "done" };
    resolve_where(&app, status, |e| {
        id.as_deref().is_some_and(|i| i == e.id) || (id.is_none() && session_id.is_some() && e.session_id == session_id)
    });
}

/// Puts a request note in the work queue; it starts when there is room. False when it already waits.
#[tauri::command]
pub fn inbox_queue_request(app: AppHandle, path: String, title: String) -> bool {
    let added = enqueue(&app, "request", &path, &title, "", None);
    if added {
        // Started now if there is room, rather than at the next 30-second tick.
        crate::automation::drain_now(&app);
    }
    added
}

/// Dismisses everything pending.
#[tauri::command]
pub fn inbox_clear(app: AppHandle) {
    resolve_where(&app, "dismissed", |_| true);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(source: &str, body: &str) -> Event {
        Event {
            id: vault::new_id(),
            kind: "result".into(),
            source: source.into(),
            title: "t".into(),
            body: body.into(),
            session_id: Some("s".into()),
            status: "pending".into(),
            created: "c".into(),
            updated: "u".into(),
        }
    }

    #[test]
    fn same_source_updates_the_pending_event() {
        let mut events = vec![];
        upsert(&mut events, ev("turn:s", "one"));
        upsert(&mut events, ev("turn:s", "two"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].body, "two");
    }

    #[test]
    fn a_resolved_source_starts_a_new_event() {
        let mut events = vec![];
        upsert(&mut events, ev("turn:s", "one"));
        resolve(&mut events, "done", |_| true);
        upsert(&mut events, ev("turn:s", "two"));
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].status, "pending");
    }

    #[test]
    fn trim_keeps_pending_and_newest_resolved() {
        let mut events: Vec<Event> = (0..KEEP + 20).map(|i| ev(&format!("a:{i}"), "")).collect();
        resolve(&mut events, "done", |_| true);
        events.push(ev("keep", ""));
        trim(&mut events);
        assert_eq!(events.len(), KEEP);
        assert!(events.iter().any(|e| e.source == "keep" && e.status == "pending"));
        assert!(events.iter().any(|e| e.source == format!("a:{}", KEEP + 19)));
        assert!(!events.iter().any(|e| e.source == "a:0"));
    }

    #[test]
    fn queued_schedules_cannot_be_dismissed_but_failed_ones_can() {
        let mut events = vec![ev("schedule:a", "")];
        events[0].kind = "schedule".into();
        assert!(!resolve(&mut events, "dismissed", |_| true));
        events[0].kind = "request".into();
        assert!(resolve(&mut events, "dismissed", |_| true), "a queued request can be taken back");
        events[0].status = "pending".into();
        events[0].kind = "schedule".into();
        events[0].status = "failed".into();
        assert!(resolve(&mut events, "dismissed", |_| true));
    }

    #[test]
    fn file_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let events = vec![ev("x", "body")];
        save(dir.path(), &events).unwrap();
        assert_eq!(load(dir.path()), events);
    }
}
