//! Work marq starts on its own while it runs: board queues and scheduled tasks.
//!
//! Every 30 seconds it looks at the open vault. A board with a queue list (see `boards::Queue`)
//! starts a session for each card put there, up to its limit; the card moves to the queue's doing
//! list and, when the session's turn ends, on to its review list. A schedule is a note in
//! `schedules/` (`type: schedule`) whose body is the prompt; it runs `every` so long, or daily `at`
//! a time, as a request note like any other task. With `query:` naming a saved query note, it runs
//! the query first and starts a session only when there are results, giving them to the agent.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Local, NaiveTime, TimeZone};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::boards::{self, Change, Queue};
use crate::error::{Error, Result};
use crate::{mq, vault, NewTask, RunOptions};

const TICK: Duration = Duration::from_secs(30);

/// What a session started here works on.
enum Run {
    Card { board: PathBuf, card: String, doing: String, review: String },
    Schedule { path: PathBuf },
}

#[derive(Default)]
pub struct Automation {
    /// The vault the window has open; nothing runs without one.
    vault: Mutex<Option<PathBuf>>,
    /// Sessions started here, until their first turn ends.
    runs: Mutex<HashMap<String, Run>>,
}

impl Automation {
    pub fn watch(&self, vault: &str) {
        *self.vault.lock().unwrap() = Some(PathBuf::from(vault));
    }

    fn running_schedule(&self, path: &Path) -> bool {
        self.runs.lock().unwrap().values().any(|r| matches!(r, Run::Schedule { path: p } if p == path))
    }

    fn running_cards(&self, board: &Path) -> usize {
        self.runs.lock().unwrap().values().filter(|r| matches!(r, Run::Card { board: b, .. } if b == board)).count()
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
    for (event, failed) in [("session://turn", false), ("session://exit", true)] {
        let handle = app.clone();
        app.listen(event, move |e| {
            let Ok(v) = serde_json::from_str::<Value>(e.payload()) else { return };
            let Some(id) = v["session_id"].as_str() else { return };
            let failed = failed && v["status"].as_str() == Some("error");
            on_turn_end(&handle, id, failed);
        });
    }
}

fn tick(app: &AppHandle) {
    let Some(vault) = app.state::<Automation>().vault.lock().unwrap().clone() else { return };
    for f in vault::list_files(&vault) {
        let path = PathBuf::from(&f.path);
        let done = match f.kind.as_deref() {
            Some("board") => work_queue(app, &vault, &path),
            Some("schedule") => match std::fs::read_to_string(&path) {
                Ok(text) if is_due(&text, Local::now()) && !app.state::<Automation>().running_schedule(&path) => {
                    run_schedule(app, &vault, &path).map(|_| ())
                }
                _ => Ok(()),
            },
            _ => Ok(()),
        };
        if let Err(e) = done {
            eprintln!("marq: automation for {}: {e}", f.rel);
        }
    }
}

/// Starts sessions for the cards waiting in the board's queue list, up to its limit.
fn work_queue(app: &AppHandle, vault: &Path, board: &Path) -> Result<()> {
    let b = boards::read(board)?;
    let Some(queue) = b.queue else { return Ok(()) };
    let Some(waiting) = b.lists.iter().find(|l| l.name.eq_ignore_ascii_case(&queue.list)) else { return Ok(()) };
    let free = queue.max.saturating_sub(app.state::<Automation>().running_cards(board));
    for card in waiting.cards.iter().filter(|c| !c.done).take(free) {
        start_card(app, vault, board, &queue, card)?;
    }
    Ok(())
}

fn start_card(app: &AppHandle, vault: &Path, board: &Path, queue: &Queue, card: &boards::Card) -> Result<()> {
    // Moved first, so a card that fails to start is not picked up again on the next tick.
    boards::update(board, &card.id, Change { list: Some(queue.doing.clone()), ..Default::default() })?;
    let board_rel = rel(vault, board);
    let prompt = card_prompt(vault, board, card, &queue.doing);
    let task = NewTask {
        title: card.title.clone(),
        prompt,
        project: queue.project.clone(),
        permission_mode: queue.permission_mode.clone(),
        model: queue.model.clone(),
        agent: None,
        carry_changes: false,
        worktree: queue.worktree,
        auto_title: false,
    };
    let v = vault.to_string_lossy();
    let started = crate::write_request(&v, task)
        .and_then(|request| Ok((crate::start_from_note(app.clone(), &v, &request, 0, RunOptions::default())?, request)));
    let note = match &started {
        Ok((_, request)) => link(&board_rel, "Session started by the queue", request),
        Err(e) => format!("⚠ The queue could not start this card: {e}"),
    };
    let to_review = started.is_err().then(|| queue.review.clone());
    boards::update(board, &card.id, Change { note: Some(note), list: to_review, ..Default::default() })?;
    let _ = app.emit("vault://changed", json!({"path": board}));
    let (s, _) = started?;
    app.state::<Automation>().runs.lock().unwrap().insert(
        s.session_id.clone(),
        Run::Card { board: board.to_path_buf(), card: card.id.clone(), doing: queue.doing.clone(), review: queue.review.clone() },
    );
    let _ = app.emit("sessions://changed", &s.session_id);
    let _ = app.emit("automation://started", json!({"session_id": s.session_id, "title": s.title, "from": board_rel}));
    Ok(())
}

/// The card as a prompt, like the board's Start a session, with linked notes as vault paths.
fn card_prompt(vault: &Path, board: &Path, card: &boards::Card, list: &str) -> String {
    let dir = board.parent().unwrap_or(vault);
    let mut lines = vec![card.title.clone()];
    let mut linked = false;
    for n in &card.notes {
        match note_link(n) {
            Some((title, href)) => {
                linked = true;
                lines.push(format!("- {title}: {}", rel(vault, &normalize(&dir.join(href)))));
            }
            None => lines.push(format!("- {n}")),
        }
    }
    lines.push(String::new());
    if linked {
        lines.push("Read the linked notes first; they hold the details for this card.".into());
        lines.push(String::new());
    }
    lines.push(format!(
        "(Card {} on the board {}, list {list}. Keep it up to date with board_update_card as you work, but leave it in this list: marq moves it to review when you finish.)",
        card.id,
        rel(vault, board)
    ));
    lines.join("\n")
}

/// `[Title](relative/path.md)`, the form the board uses to link notes.
fn note_link(item: &str) -> Option<(&str, &str)> {
    let (title, rest) = item.strip_prefix('[')?.split_once("](")?;
    let href = rest.strip_suffix(')')?;
    (!href.contains("://") && href.split('#').next()?.ends_with(".md")).then(|| (title, href.split('#').next().unwrap()))
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

fn rel(vault: &Path, p: &Path) -> String {
    p.strip_prefix(vault).unwrap_or(p).to_string_lossy().into_owned()
}

/// A link from the note at `from` to the note at `to`, both vault-relative.
fn link(from: &str, title: &str, to: &str) -> String {
    let up = from.matches('/').count();
    format!("[{title}]({}{})", "../".repeat(up), to.replace(' ', "%20"))
}

fn on_turn_end(app: &AppHandle, session: &str, failed: bool) {
    let Some(run) = app.state::<Automation>().runs.lock().unwrap().remove(session) else { return };
    let Run::Card { board, card, doing, review } = run else { return };
    // Left alone if the session or the user already moved it.
    let Ok(b) = boards::read(&board) else { return };
    let still_doing = b.lists.iter().any(|l| l.name.eq_ignore_ascii_case(&doing) && l.cards.iter().any(|c| c.id == card));
    if !still_doing {
        return;
    }
    let note = failed.then(|| "⚠ The session ended with an error".to_string());
    if let Err(e) = boards::update(&board, &card, Change { list: Some(review), note, ..Default::default() }) {
        eprintln!("marq: could not move {card} to review: {e}");
    }
    let _ = app.emit("vault://changed", json!({"path": board}));
}

// ---- schedules ----

/// `15m`, `2h`, `1d`, `1w`; at least five minutes.
fn parse_every(s: &str) -> Option<chrono::Duration> {
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
    let stamp = format!("{title} · {}", &now[..16].replace('T', " "));

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
        assert_eq!(note_link("[Spec](../notes/spec.md)"), Some(("Spec", "../notes/spec.md")));
        assert_eq!(note_link("[x](https://a.md)"), None);
        assert_eq!(link("boards/a.md", "S", "requests/b c.md"), "[S](../requests/b%20c.md)");
        assert_eq!(normalize(Path::new("/v/boards/../notes/x.md")), PathBuf::from("/v/notes/x.md"));
    }
}
