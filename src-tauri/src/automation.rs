//! Work marq starts on its own while it runs: scheduled tasks, requests the user queued and
//! follow-ups that fell due.
//!
//! Every 30 seconds it looks at the open vault and queues what is due in the inbox (see `inbox`),
//! where it waits for room and is started. A schedule is a note in `schedules/` (`type: schedule`)
//! whose body is the prompt; it runs `every` so long, or daily `at` a time, as a request note like
//! any other task. With `query:` naming a saved query note, it runs the query first and starts a
//! session only when there are results, giving them to the agent.

use crate::vault::PathSlash;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Local, NaiveTime, TimeZone};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::error::{Error, Result};
use crate::{mq, vault, workflow, NewTask, RunOptions};

const TICK: Duration = Duration::from_secs(30);

/// What a session started here works on.
enum Run {
    Schedule { path: PathBuf },
    Request,
}

#[derive(Default)]
pub struct Automation {
    /// The vault the window has open; nothing runs without one.
    vault: Mutex<Option<PathBuf>>,
    /// Sessions started here, until their first turn ends.
    runs: Mutex<HashMap<String, Run>>,
}

impl Automation {
    /// The vault the window has open, if any.
    pub fn vault(&self) -> Option<PathBuf> {
        self.vault.lock().unwrap().clone()
    }

    pub fn watch(&self, vault: &str) {
        *self.vault.lock().unwrap() = Some(PathBuf::from(vault));
    }

    fn running_schedule(&self, path: &Path) -> bool {
        self.runs.lock().unwrap().values().any(|r| matches!(r, Run::Schedule { path: p } if p == path))
    }

    fn running_schedules(&self) -> usize {
        self.runs.lock().unwrap().values().filter(|r| matches!(r, Run::Schedule { .. } | Run::Request)).count()
    }
}

/// Starts the timer and follows session turns. Called once at startup.
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut timer = tokio::time::interval(TICK);
        loop {
            timer.tick().await;
            let app = handle.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || tick(&app)).await;
        }
    });
    // A turn's work counts as finished once it is checked (see `workflow`), not when the turn ends.
    let handle = app.clone();
    app.listen("workflow://settled", move |e| {
        let Ok(v) = serde_json::from_str::<Value>(e.payload()) else { return };
        let Some(id) = v["session_id"].as_str() else { return };
        on_turn_end(&handle, id);
    });
    let handle = app.clone();
    app.listen("session://exit", move |e| {
        let Ok(v) = serde_json::from_str::<Value>(e.payload()) else { return };
        let Some(id) = v["session_id"].as_str() else { return };
        if v["status"].as_str() == Some("error") {
            on_turn_end(&handle, id);
        }
    });
    // A retry or the next phase in a new session carries on the same run.
    let handle = app.clone();
    app.listen("workflow://handoff", move |e| {
        let Ok(v) = serde_json::from_str::<Value>(e.payload()) else { return };
        let (Some(from), Some(to)) = (v["from"].as_str(), v["to"].as_str()) else { return };
        let runs = &handle.state::<Automation>().runs;
        let mut runs = runs.lock().unwrap();
        if let Some(run) = runs.remove(from) {
            runs.insert(to.to_string(), run);
        }
    });
}

fn tick(app: &AppHandle) {
    let Some(vault) = app.state::<Automation>().vault.lock().unwrap().clone() else { return };
    // A schedule falling due only queues the run; `drain` starts it when there is room.
    for f in vault::list_files(&vault).into_iter().filter(|f| f.kind.as_deref() == Some("schedule")) {
        let path = PathBuf::from(&f.path);
        if let Ok(text) = std::fs::read_to_string(&path)
            && is_due(&text, Local::now())
            && !app.state::<Automation>().running_schedule(&path)
        {
            let title = vault::fm_get(&text, "title").unwrap_or_else(|| f.rel.clone());
            crate::inbox::enqueue(app, "schedule", &path.to_string_lossy(), &title, "", None);
        }
    }
    drain(app, &vault);
}

/// How many scheduled runs and queued requests may be going at once, `[inbox] parallel` in the
/// config (default 1: one after the other); the rest wait in the inbox.
fn parallel() -> usize {
    crate::config::read().ok().and_then(|c| c["inbox"]["parallel"].as_u64()).map_or(1, |n| n.clamp(1, 8) as usize)
}

/// Handles the inbox now instead of at the next tick, for work the user just queued.
pub fn drain_now(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(vault) = app.state::<Automation>().vault() {
            drain(&app, &vault);
        }
    });
}

/// Moves due follow-ups into the inbox, then handles what is queued there: schedules and requests
/// start while there is room, follow-ups resume their session once it is idle.
fn drain(app: &AppHandle, vault: &Path) {
    // One at a time: a drain counts the sessions running before it starts some, so two at once
    // (queuing several cards quickly) would each see room and together start more than the limit.
    static DRAIN: Mutex<()> = Mutex::new(());
    let _one_at_a_time = DRAIN.lock().unwrap_or_else(|e| e.into_inner());
    for t in crate::timers::take_due(vault, Local::now()) {
        let title = crate::session::meta(vault, &t.session_id).map_or_else(|_| "Follow-up".to_string(), |m| m.title);
        crate::inbox::enqueue(app, "followup", &format!("followup:{}", t.id), &title, &t.note, Some(&t.session_id));
    }

    let mut room = parallel().saturating_sub(app.state::<Automation>().running_schedules());
    for e in crate::inbox::claim(app, "schedule", room, |_| true) {
        room = room.saturating_sub(1);
        let path = PathBuf::from(&e.source);
        // Run by hand while it waited, or switched off: nothing left to do.
        if !std::fs::read_to_string(&path).is_ok_and(|t| is_due(&t, Local::now())) {
            crate::inbox::finish(app, &e.id, true, "Not due any more.", None);
            continue;
        }
        match run_schedule(app, vault, &path) {
            Ok(Some(id)) => crate::inbox::finish(app, &e.id, true, "", Some(id)),
            Ok(None) => crate::inbox::finish(app, &e.id, true, "The query found nothing, so no session was started.", None),
            Err(err) => crate::inbox::finish(app, &e.id, false, &err.to_string(), None),
        }
    }
    for e in crate::inbox::claim(app, "request", room, |_| true) {
        match start_request(app, vault, Path::new(&e.source)) {
            Ok(Some(id)) => crate::inbox::finish(app, &e.id, true, "", Some(id)),
            Ok(None) => crate::inbox::finish(app, &e.id, true, "Already started.", None),
            Err(err) => crate::inbox::finish(app, &e.id, false, &err.to_string(), None),
        }
    }

    // A session in the middle of a turn gets its follow-up after the turn, not on top of it.
    let idle = |e: &crate::inbox::Event| e.session_id.as_deref().is_some_and(|id| !app.state::<crate::sidecar::Runner>().is_alive(id));
    for e in crate::inbox::claim(app, "followup", usize::MAX, idle) {
        let id = e.session_id.clone().unwrap_or_default();
        let sent = crate::session::meta(vault, &id).and_then(|meta| {
            let prompt = format!("A follow-up you set for yourself has come due:\n\n{}", e.body);
            app.state::<crate::sidecar::Runner>().start(app.clone(), vault.to_path_buf(), meta, prompt, crate::sidecar::Turn::Resume)
        });
        match sent {
            Ok(()) => crate::inbox::finish(app, &e.id, true, &e.body, None),
            Err(err) => crate::inbox::finish(app, &e.id, false, &err.to_string(), None),
        }
    }
}

/// Starts a request that was saved for later. `None` when it is no longer waiting (`status: todo`).
fn start_request(app: &AppHandle, vault: &Path, path: &Path) -> Result<Option<String>> {
    let text = std::fs::read_to_string(path)?;
    if vault::fm_get(&text, "status").as_deref() != Some("todo") {
        return Ok(None);
    }
    let started = crate::start_from_note(app.clone(), &vault.to_string_lossy(), &path.to_string_lossy(), 0, RunOptions::default())?;
    app.state::<Automation>().runs.lock().unwrap().insert(started.session_id.clone(), Run::Request);
    let _ = app.emit("vault://changed", json!({"path": path}));
    let _ = app.emit("sessions://changed", &started.session_id);
    Ok(Some(started.session_id))
}

fn rel(vault: &Path, p: &Path) -> String {
    p.strip_prefix(vault).unwrap_or(p).to_slash()
}

/// A link from the note at `from` to the note at `to`, both vault-relative.
pub fn link(from: &str, title: &str, to: &str) -> String {
    let up = from.matches('/').count();
    format!("[{title}]({}{})", "../".repeat(up), to.replace(' ', "%20"))
}

/// A session started here has finished its first turn: it no longer counts against the limit.
fn on_turn_end(app: &AppHandle, session: &str) {
    app.state::<Automation>().runs.lock().unwrap().remove(session);
}

// ---- schedules ----

/// `15m`, `2h`, `1d`, `1w`; at least five minutes.
pub(crate) fn parse_every(s: &str) -> Option<chrono::Duration> {
    let s = s.trim();
    let (n, unit) = s.split_at(s.find(|c: char| !c.is_ascii_digit())?);
    let n: i64 = n.parse().ok()?;
    let d = match unit.trim() {
        "m" | "min" => chrono::Duration::minutes(n),
        "h" => chrono::Duration::hours(n),
        "d" => chrono::Duration::days(n),
        "w" => chrono::Duration::weeks(n),
        _ => return None,
    };
    (d >= chrono::Duration::minutes(5)).then_some(d)
}

fn parse_time(text: &str, key: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(&vault::fm_get(text, key)?).ok().map(|t| t.with_timezone(&Local))
}

/// When the schedule runs next: daily `at` HH:MM, else `every` after the last run (or its creation).
pub fn next_run(text: &str) -> Option<DateTime<Local>> {
    let last = parse_time(text, "last_run").or_else(|| parse_time(text, "created"))?;
    if let Some(at) = vault::fm_get(text, "at").and_then(|a| NaiveTime::parse_from_str(a.trim(), "%H:%M").ok()) {
        let day = last.date_naive();
        let mut next = Local.from_local_datetime(&day.and_time(at)).earliest()?;
        if next <= last {
            next = Local.from_local_datetime(&day.succ_opt()?.and_time(at)).earliest()?;
        }
        return Some(next);
    }
    Some(last + parse_every(&vault::fm_get(text, "every")?)?)
}

fn enabled(text: &str) -> bool {
    vault::fm_get(text, "enabled").as_deref() != Some("false")
}

/// Due now. Runs missed while marq was closed are made up once, not one by one.
fn is_due(text: &str, now: DateTime<Local>) -> bool {
    enabled(text) && next_run(text).is_some_and(|t| t <= now)
}

/// Most sessions one run starts when it gives each file of results its own.
const MAX_SESSIONS: usize = 10;

/// Starts the schedule's prompt as a new request note, or for a schedule with a `query:` one per
/// run of it with results. Returns the first session id, or `None` when the query found nothing.
pub fn run_schedule(app: &AppHandle, vault: &Path, path: &Path) -> Result<Option<String>> {
    let text = std::fs::read_to_string(path)?;
    let now = vault::now();
    // Recorded first, so a run that fails to start is not retried every tick.
    std::fs::write(path, vault::fm_set(&text, "last_run", &now))?;
    let title = vault::fm_get(&text, "title").unwrap_or_else(|| rel(vault, path));
    let get = |k: &str| vault::fm_get(&text, k).filter(|v| !v.is_empty());
    let prompt = vault::split_frontmatter(&text).1.trim().to_string();
    let stamp = format!("{title} · {}", now[..16].replace('T', " "));

    // (title, prompt) of each session to start.
    let mut runs = vec![(stamp.clone(), prompt.clone())];
    if let Some(query) = get("query") {
        let saved = mq::read_saved(&std::fs::read_to_string(vault::resolve(vault, &query)?)?)
            .ok_or_else(|| Error::Other(format!("{query} has no mq block")))?;
        let results = mq::eval(vault, &saved.query, None, Some(&saved.glob), None, saved.aggregate)?;
        if results.is_empty() {
            return Ok(None);
        }
        let instruction = if prompt.is_empty() { saved.agent.clone().unwrap_or_default() } else { prompt };
        if instruction.is_empty() {
            return Err(Error::Other("the schedule has no prompt; write it below the frontmatter or give the query an agent prompt".into()));
        }
        let (all, each) = mq::prompt_context(vault, &saved.query, &saved.glob, &results);
        let split = get("each").map_or(saved.each, |v| v == "true") && results.len() > 1;
        runs = if split {
            results
                .iter()
                .zip(each)
                .take(MAX_SESSIONS)
                .map(|(r, ctx)| {
                    let file = r.file.as_deref().map_or_else(String::new, |f| rel(vault, Path::new(f)));
                    (format!("{stamp} · {file}"), format!("{instruction}\n\n{ctx}"))
                })
                .collect()
        } else {
            vec![(stamp, format!("{instruction}\n\n{all}"))]
        };
    } else if prompt.is_empty() {
        return Err(Error::Other("the schedule has no prompt; write it below the frontmatter".into()));
    }

    let v = vault.to_string_lossy();
    let mut first = None;
    for (title, prompt) in runs {
        let task = NewTask {
            title,
            prompt,
            project: get("project").unwrap_or_default(),
            permission_mode: get("permission_mode"),
            model: get("model"),
            agent: get("agent"),
            carry_changes: false,
            worktree: get("worktree").as_deref() == Some("true"),
            auto_title: false,
            verify: get("verify"),
            verify_retry: get("verify_retry"),
            verify_retries: get("verify_retries").and_then(|v| v.parse().ok()),
            sandbox: get("sandbox").or_else(workflow::unattended_sandbox),
            phases: vault::fm_list(&text, "phases"),
            playbook: get("playbook"),
            extra: ["verify_timeout", "verify_model", "phase_gate"].iter().filter_map(|k| Some((k.to_string(), get(k)?))).collect(),
            workspace: get("workspace"),
            directories: crate::workspace::dirs_of(&text),
            ..Default::default()
        };
        let request = crate::write_request(&v, task)?;
        let started = crate::start_from_note(app.clone(), &v, &request, 0, RunOptions::default())?;
        let text = std::fs::read_to_string(path)?;
        std::fs::write(path, vault::fm_set(&text, "last_session", &started.session_id))?;
        app.state::<Automation>().runs.lock().unwrap().insert(started.session_id.clone(), Run::Schedule { path: path.to_path_buf() });
        let _ = app.emit("vault://changed", json!({"path": path}));
        let _ = app.emit("sessions://changed", &started.session_id);
        let _ = app.emit("automation://started", json!({"session_id": started.session_id, "title": started.title, "from": rel(vault, path)}));
        first.get_or_insert(started.session_id);
    }
    Ok(first)
}

/// Every schedule with when it runs next.
pub fn list(app: &AppHandle, vault: &Path) -> Vec<Value> {
    vault::list_files(vault)
        .into_iter()
        .filter(|f| f.kind.as_deref() == Some("schedule"))
        .map(|f| {
            let text = std::fs::read_to_string(&f.path).unwrap_or_default();
            let get = |k: &str| vault::fm_get(&text, k).filter(|v| !v.is_empty());
            json!({
                "path": f.path,
                "rel": f.rel,
                "title": f.title,
                "query": get("query"),
                "every": get("every"),
                "at": get("at"),
                "enabled": enabled(&text),
                "last_run": get("last_run"),
                "next_run": next_run(&text).map(|t| t.to_rfc3339()),
                "running": app.state::<Automation>().running_schedule(Path::new(&f.path)),
            })
        })
        .collect()
}

/// Writes `schedules/<title>.md`. `when` is an interval (`1h`) or a daily time (`09:00`).
/// `query` is a saved query note (`queries/x.md`) whose results go to the agent, or empty.
pub fn create(vault: &Path, title: &str, when: &str, prompt: &str, project: &str, query: &str) -> Result<PathBuf> {
    let title = title.trim();
    if title.is_empty() {
        return Err(Error::Other("a schedule needs a name".into()));
    }
    let when = when.trim();
    let timing = if NaiveTime::parse_from_str(when, "%H:%M").is_ok() {
        format!("at: \"{when}\"")
    } else if parse_every(when).is_some() {
        format!("every: {when}")
    } else {
        return Err(Error::Other(format!("\"{when}\" is neither an interval like 30m, 2h or 1d (5m or more) nor a time like 09:00")));
    };
    let rel = vault::unique_path(vault, "schedules", title);
    std::fs::create_dir_all(vault.join("schedules"))?;
    let q = |s: &str| serde_json::to_string(s).unwrap();
    let query = query.trim();
    let query_fm = if query.is_empty() { String::new() } else { format!("query: {}\n", q(query)) };
    let content = format!(
        "---\nid: {}\ntype: schedule\ntitle: {}\ncreated: {}\n{timing}\n{query_fm}enabled: true\nproject: {}\nworktree: false\n---\n{}\n",
        vault::new_id(),
        q(title),
        vault::now(),
        project.trim(),
        prompt.trim()
    );
    let path = vault.join(&rel);
    std::fs::write(&path, content)?;
    Ok(path)
}

pub fn set_enabled(path: &Path, on: bool) -> Result<()> {
    let text = std::fs::read_to_string(path)?;
    let mut text = vault::fm_set(&text, "enabled", &on.to_string());
    // Turned back on: the next run counts from now, not from a run long ago.
    if on {
        text = vault::fm_set(&text, "last_run", &vault::now());
    }
    std::fs::write(path, text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intervals() {
        assert_eq!(parse_every("30m"), Some(chrono::Duration::minutes(30)));
        assert_eq!(parse_every("2h"), Some(chrono::Duration::hours(2)));
        assert_eq!(parse_every("1d"), Some(chrono::Duration::days(1)));
        assert_eq!(parse_every("1m"), None);
        assert_eq!(parse_every("h"), None);
    }

    #[test]
    fn next_runs() {
        let last = Local::now() - chrono::Duration::hours(2);
        let text = format!("---\nevery: 1h\nlast_run: {}\n---\nhi\n", last.to_rfc3339());
        assert!(is_due(&text, Local::now()));
        let text = format!("---\nevery: 3h\nlast_run: {}\n---\nhi\n", last.to_rfc3339());
        assert!(!is_due(&text, Local::now()));
        assert!(!is_due(&format!("---\nevery: 1h\nenabled: false\nlast_run: {}\n---\n", last.to_rfc3339()), Local::now()));

        let last = Local.with_ymd_and_hms(2026, 10, 29, 10, 0, 0).unwrap();
        let text = format!("---\nat: \"09:00\"\nlast_run: {}\n---\n", last.to_rfc3339());
        assert_eq!(next_run(&text), Some(Local.with_ymd_and_hms(2026, 10, 30, 9, 0, 0).unwrap()));
        let text = format!("---\nat: \"11:30\"\nlast_run: {}\n---\n", last.to_rfc3339());
        assert_eq!(next_run(&text), Some(Local.with_ymd_and_hms(2026, 10, 29, 11, 30, 0).unwrap()));
    }

    #[test]
    fn links() {
        assert_eq!(link("boards/a.md", "S", "requests/b c.md"), "[S](../requests/b%20c.md)");
    }
}
