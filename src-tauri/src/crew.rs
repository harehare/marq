//! Crews: several sessions working on one project together, addressed by role (SPEC §21).
//!
//! A crew is a note with `type: crew`. Its members are ordinary sessions, and they talk through
//! mailboxes kept in `sessions/.crews/<crew id>.jsonl`
//! (under `sessions/`, which Marq manages, so moving crew notes never moves their logs). A message is delivered when its recipient is
//! between turns, and everything waiting for it arrives as one turn, so a member handles its
//! mail the way an actor does: one batch at a time, never interrupted mid-turn.
//!
//! Log lines: `crew_msg` (a message), `crew_member` (a role got a session), `crew_deliver`
//! (messages handed to a session as a turn) and `crew_release` (the user let a held message through).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::claude::{self, SessionMeta};
use crate::error::{Error, Result};
use crate::sidecar::{Runner, Turn};
use crate::tasks::{self, Task, TaskList};
use crate::{git, vault};

/// The user's address in a crew.
pub const USER: &str = "user";
/// Sends to every member but the sender.
pub const ALL: &str = "all";
const DEFAULT_MAX_HOPS: u64 = 20;
const KINDS: [&str; 4] = ["tell", "ask", "reply", "decision"];

/// Which crew a session belongs to, and as what.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrewRef {
    pub id: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Member {
    pub role: String,
    pub permission_mode: Option<String>,
    /// Whether the member gets its own worktree when the project is a git repository.
    pub worktree: bool,
    /// The `### <role>` section under `## Roles`.
    pub instructions: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Crew {
    pub id: String,
    pub title: String,
    pub path: String,
    pub rel: String,
    pub project: Option<String>,
    /// How many member-to-member messages may follow one message from the user before the
    /// next one is held for the user.
    pub max_hops: u64,
    pub members: Vec<Member>,
    pub goal: String,
}

/// Reads a crew note. `None` when it is not one.
pub fn parse(text: &str, path: &Path, vault: &Path) -> Option<Crew> {
    use yaml_rust2::YamlLoader;
    if vault::fm_get(text, "type").as_deref() != Some("crew") {
        return None;
    }
    let fm = vault::split_frontmatter(text).0?;
    let doc = YamlLoader::load_from_str(fm).ok()?.into_iter().next()?;
    let sections = sections(vault::split_frontmatter(text).1);
    let section = |h2: &str, h3: Option<&str>| {
        sections
            .iter()
            .find(|s| s.h2.eq_ignore_ascii_case(h2) && s.h3.as_deref().map(str::to_lowercase) == h3.map(str::to_lowercase))
            .map(|s| s.body.trim().to_string())
            .unwrap_or_default()
    };
    let members = doc["members"]
        .as_vec()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let role = m["role"].as_str()?.trim().to_string();
            (!role.is_empty() && role != USER).then(|| Member {
                permission_mode: m["permission_mode"].as_str().map(str::to_string).filter(|s| !s.is_empty()),
                worktree: m["worktree"].as_bool().unwrap_or(true),
                instructions: section("Roles", Some(&role)),
                role,
            })
        })
        .collect();
    Some(Crew {
        id: doc["id"].as_str().map(str::to_string).unwrap_or_default(),
        title: doc["title"].as_str().map(str::to_string).unwrap_or_else(|| {
            path.file_stem().unwrap_or_default().to_string_lossy().into_owned()
        }),
        path: path.to_string_lossy().into_owned(),
        rel: path.strip_prefix(vault).unwrap_or(path).to_string_lossy().into_owned(),
        // Read like a request's `project:`, as the raw text.
        project: vault::fm_get(text, "project").filter(|s| !s.is_empty()),
        max_hops: doc["max_hops"].as_i64().map(|n| n.max(1) as u64).unwrap_or(DEFAULT_MAX_HOPS),
        members,
        goal: section("Goal", None),
    })
}

struct Section {
    h2: String,
    h3: Option<String>,
    body: String,
}

/// `##` and `###` sections of a body, each with only its own text (up to the next heading).
fn sections(body: &str) -> Vec<Section> {
    let mut out: Vec<Section> = vec![];
    let mut in_fence = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
        }
        let heading = (!in_fence).then(|| line.strip_prefix("### ").map(|h| (3, h)).or(line.strip_prefix("## ").map(|h| (2, h)))).flatten();
        match heading {
            Some((2, h)) => out.push(Section { h2: h.trim().into(), h3: None, body: String::new() }),
            Some((_, h)) => {
                let h2 = out.last().map(|s| s.h2.clone()).unwrap_or_default();
                out.push(Section { h2, h3: Some(h.trim().into()), body: String::new() });
            }
            None => {
                if let Some(s) = out.last_mut() {
                    s.body.push_str(line);
                    s.body.push('\n');
                }
            }
        }
    }
    out
}

/// Finds a crew note by id, or by vault-relative path.
pub fn find(vault: &Path, id: &str) -> Result<Crew> {
    vault::list_files(vault)
        .into_iter()
        .filter(|f| f.kind.as_deref() == Some("crew"))
        .filter_map(|f| {
            let p = PathBuf::from(&f.path);
            parse(&std::fs::read_to_string(&p).ok()?, &p, vault)
        })
        .find(|c| c.id == id || c.rel == id)
        .ok_or_else(|| Error::Other(format!("crew not found: {id}")))
}

pub fn raw_path(vault: &Path, id: &str) -> PathBuf {
    vault.join("sessions/.crews").join(format!("{id}.jsonl"))
}

fn events(vault: &Path, id: &str) -> Vec<Value> {
    std::fs::read_to_string(raw_path(vault, id))
        .map(|t| t.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
        .unwrap_or_default()
}

fn log(app: &AppHandle, vault: &Path, crew: &str, line: Value) -> Result<()> {
    let path = raw_path(vault, crew);
    std::fs::create_dir_all(path.parent().unwrap())?;
    claude::append(&path, &line)?;
    let _ = app.emit("crew://changed", json!({"crew_id": crew}));
    Ok(())
}

/// The session that plays `role`, from the latest `crew_member` line.
fn member_session(events: &[Value], role: &str) -> Option<String> {
    events
        .iter()
        .rev()
        .find(|e| e["type"] == "crew_member" && e["role"] == role)
        .and_then(|e| e["session"].as_str())
        .map(str::to_string)
}

fn ids_of(events: &[Value], kind: &str, key: &str) -> HashSet<String> {
    events
        .iter()
        .filter(|e| e["type"] == kind)
        .flat_map(|e| match &e[key] {
            Value::Array(a) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
            Value::String(s) => vec![s.clone()],
            _ => vec![],
        })
        .collect()
}

/// The hop count of the last batch `role` received. Whatever it sends next is one more.
fn last_hop(events: &[Value], role: &str) -> u64 {
    events
        .iter()
        .rev()
        .find(|e| e["type"] == "crew_deliver" && e["to"] == role)
        .and_then(|e| e["hop"].as_u64())
        .unwrap_or(0)
}

/// A message's recipients. `to` is one role, or a list for a message to several.
fn recipients(msg: &Value) -> Vec<&str> {
    match &msg["to"] {
        Value::String(s) => vec![s.as_str()],
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    }
}

/// Ids of the messages handed to `role`.
fn delivered_to(events: &[Value], role: &str) -> HashSet<String> {
    let mine: Vec<Value> = events.iter().filter(|e| e["type"] == "crew_deliver" && e["to"] == role).cloned().collect();
    ids_of(&mine, "crew_deliver", "msgs")
}

/// Messages to `role` that have not been delivered to it, leaving out held ones nobody released.
fn pending<'a>(events: &'a [Value], role: &str) -> Vec<&'a Value> {
    let delivered = delivered_to(events, role);
    let released = ids_of(events, "crew_release", "msg");
    events
        .iter()
        .filter(|e| e["type"] == "crew_msg" && recipients(e).contains(&role))
        .filter(|e| e["id"].as_str().is_some_and(|id| !delivered.contains(id)))
        .filter(|e| e["held"] != true || e["id"].as_str().is_some_and(|id| released.contains(id)))
        .collect()
}

/// Everyone in the thread `msg_id` belongs to: the senders and recipients of every message up
/// its reply chain. A reply without `to` goes to all of them, which is how a discussion works.
fn thread_members<'a>(events: &'a [Value], msg_id: &str) -> Vec<&'a str> {
    let mut out: Vec<&str> = vec![];
    let mut next = Some(msg_id.to_string());
    let mut seen = HashSet::new();
    while let Some(id) = next.take() {
        if !seen.insert(id.clone()) {
            break;
        }
        let Some(m) = events.iter().find(|e| e["type"] == "crew_msg" && e["id"] == id.as_str()) else { break };
        for r in std::iter::once(m["from"].as_str().unwrap_or("")).chain(recipients(m)) {
            if !r.is_empty() && !out.contains(&r) {
                out.push(r);
            }
        }
        next = m["reply_to"].as_str().map(str::to_string);
    }
    out
}

// Sends, releases, deliveries and edits of the crew note run one at a time, so a message is
// never delivered twice and the note is never written by two members at once.
static MAIL: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
pub struct Sent {
    pub id: String,
    pub to: Vec<String>,
    /// The crew reached its hop limit, so the message waits for the user to release it.
    pub held: bool,
}

// ---- tasks and documents ----

/// The crew's own folder, `crews/<name>/` next to `crews/<name>.md`, for its task list and documents.
fn crew_dir(crew: &Crew) -> PathBuf {
    Path::new(&crew.path).with_extension("")
}

/// The crew's task list, found by its `crew:` id so it can be moved. Created on first use.
pub fn tasks_path(vault: &Path, crew: &Crew) -> Result<PathBuf> {
    let found = vault::list_files(vault).into_iter().filter(|f| f.kind.as_deref() == Some("crew-tasks")).find(|f| {
        std::fs::read_to_string(&f.path).is_ok_and(|t| vault::fm_get(&t, "crew").as_deref() == Some(crew.id.as_str()))
    });
    if let Some(f) = found {
        return Ok(PathBuf::from(f.path));
    }
    let path = crew_dir(crew).join("tasks.md");
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, tasks::new_file(&crew.id, &crew.title))?;
    Ok(path)
}

/// Where members' documents go by default: the folder that holds the task list, relative to the vault.
pub fn docs_folder(vault: &Path, crew_id: &str) -> Result<String> {
    let crew = find(vault, crew_id)?;
    let path = tasks_path(vault, &crew)?;
    let dir = path.parent().unwrap();
    Ok(dir.strip_prefix(vault).unwrap_or(dir).to_string_lossy().into_owned())
}

fn read_tasks(vault: &Path, crew: &Crew) -> Result<(PathBuf, TaskList)> {
    let path = tasks_path(vault, crew)?;
    let text = std::fs::read_to_string(&path)?;
    Ok((path, tasks::parse(&text)))
}

fn write_tasks(app: &AppHandle, path: &Path, list: &TaskList) -> Result<()> {
    std::fs::write(path, tasks::render(list))?;
    let _ = app.emit("vault://changed", json!({"path": path}));
    Ok(())
}

fn check_owner(crew: &Crew, owner: &str) -> Result<()> {
    if crew.members.iter().any(|m| m.role == owner) {
        Ok(())
    } else {
        Err(Error::Other(format!("no member \"{owner}\" to own the task")))
    }
}

/// Tells a member about a task someone else gave it.
fn notify_owner(app: &AppHandle, vault: &Path, crew: &Crew, by: &str, task: &Task) -> Result<()> {
    match &task.owner {
        Some(o) if o != by => {
            let text = format!("{by} assigned you {} ({}): {}", task.id, task.status, task.title);
            post(app, vault, crew, Outgoing { from: by, to: o, kind: "tell", text: &text, reply_to: None }).map(|_| ())
        }
        _ => Ok(()),
    }
}

/// Adds a task. With an owner, the owner is told.
pub fn task_add(app: &AppHandle, vault: &Path, crew_id: &str, by: &str, title: &str, owner: Option<&str>, note: Option<&str>) -> Result<Task> {
    let _lock = MAIL.lock().unwrap();
    let crew = find(vault, crew_id)?;
    let owner = owner.map(str::trim).filter(|o| !o.is_empty());
    if let Some(o) = owner {
        check_owner(&crew, o)?;
    }
    if title.trim().is_empty() {
        return Err(Error::Other("the task needs a title".into()));
    }
    let (path, mut list) = read_tasks(vault, &crew)?;
    let task = Task {
        id: list.next_id(),
        title: title.trim().replace('\n', " "),
        status: "todo".into(),
        owner: owner.map(str::to_string),
        notes: note.map(str::trim).filter(|n| !n.is_empty()).map(|n| vec![n.to_string()]).unwrap_or_default(),
    };
    list.tasks.push(task.clone());
    write_tasks(app, &path, &list)?;
    log(app, vault, &crew.id, json!({"type": "crew_event", "text": format!("{by} added {} {}", task.id, task.title), "at": vault::now()}))?;
    notify_owner(app, vault, &crew, by, &task)?;
    Ok(task)
}

/// What to change on a task. `owner: Some("")` unassigns it.
#[derive(Default)]
pub struct TaskChange<'a> {
    pub status: Option<&'a str>,
    pub owner: Option<&'a str>,
    pub note: Option<&'a str>,
}

/// Changes a task's status or owner, or adds a note. Taking a task someone else is doing fails,
/// so members working in parallel never pick up the same task.
pub fn task_update(app: &AppHandle, vault: &Path, crew_id: &str, by: &str, id: &str, change: TaskChange) -> Result<Task> {
    let TaskChange { status, owner, note } = change;
    let _lock = MAIL.lock().unwrap();
    let crew = find(vault, crew_id)?;
    let (path, mut list) = read_tasks(vault, &crew)?;
    let task = list.get_mut(id).ok_or_else(|| Error::Other(format!("no task {id}; use task_list to see them")))?;
    let before = task.clone();
    if let Some(st) = status.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()) {
        if !tasks::STATUSES.contains(&st.as_str()) {
            return Err(Error::Other(format!("status is one of {}", tasks::STATUSES.join(", "))));
        }
        // Starting a task makes you its owner, unless someone else is already on it.
        if st == "doing" && owner.is_none() && by != USER {
            if let Some(o) = task.owner.as_deref().filter(|o| *o != by && task.status == "doing") {
                return Err(Error::Other(format!("{} is already being done by {o}", task.id)));
            }
            task.owner = Some(by.to_string());
        }
        task.status = st;
    }
    if let Some(o) = owner.map(str::trim) {
        if o.is_empty() {
            task.owner = None;
        } else {
            check_owner(&crew, o)?;
            task.owner = Some(o.to_string());
        }
    }
    if let Some(n) = note.map(str::trim).filter(|n| !n.is_empty()) {
        task.notes.push(format!("{by}: {}", n.replace('\n', " ")));
    }
    let task = task.clone();
    write_tasks(app, &path, &list)?;
    let mut changes = vec![];
    if task.status != before.status {
        changes.push(format!("→ {}", task.status));
    }
    if task.owner != before.owner {
        changes.push(format!("@{}", task.owner.as_deref().unwrap_or("nobody")));
    }
    if !changes.is_empty() {
        let text = format!("{by}: {} {} {}", task.id, task.title, changes.join(" "));
        log(app, vault, &crew.id, json!({"type": "crew_event", "text": text, "at": vault::now()}))?;
    }
    if task.owner != before.owner {
        notify_owner(app, vault, &crew, by, &task)?;
    }
    Ok(task)
}

/// The task list for a member's task_list tool.
pub fn task_list(vault: &Path, crew_id: &str) -> Result<Value> {
    let crew = find(vault, crew_id)?;
    let (path, list) = read_tasks(vault, &crew)?;
    Ok(json!({"path": path.strip_prefix(vault).unwrap_or(&path), "tasks": list.tasks}))
}

/// Links a new document from the crew note's `## Documents` and notes it in the timeline.
pub fn doc_saved(app: &AppHandle, vault: &Path, crew_id: &str, by: &str, rel: &str, title: &str) -> Result<()> {
    let _lock = MAIL.lock().unwrap();
    let crew = find(vault, crew_id)?;
    let from = Path::new(&crew.rel).parent().unwrap_or(Path::new(""));
    let link = relative(from, Path::new(rel)).replace(' ', "%20");
    let text = std::fs::read_to_string(&crew.path)?;
    let text = append_to_section(&text, "Documents", &format!("- [{}]({link}) — {by}", title.replace(['[', ']'], "")));
    std::fs::write(&crew.path, vault::fm_set(&text, "updated", &vault::now()))?;
    let _ = app.emit("vault://changed", json!({"path": crew.path}));
    log(app, vault, &crew.id, json!({"type": "crew_event", "text": format!("{by} wrote {title}"), "doc": rel, "at": vault::now()}))
}

/// `to` relative to the folder `from`, both relative to the vault.
fn relative(from: &Path, to: &Path) -> String {
    let a: Vec<_> = from.components().collect();
    let b: Vec<_> = to.components().collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut parts: Vec<String> = vec!["..".into(); a.len() - common];
    parts.extend(b[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    parts.join("/")
}

/// Documents members wrote for the crew: `type: doc` notes whose origin is the crew.
fn crew_docs(vault: &Path, crew_id: &str) -> Vec<Value> {
    vault::list_files(vault)
        .into_iter()
        .filter(|f| f.kind.as_deref() == Some("doc"))
        .filter(|f| std::fs::read_to_string(&f.path).is_ok_and(|t| vault::fm_get(&t, "origin").as_deref() == Some(crew_id)))
        .map(|f| json!({"path": f.path, "rel": f.rel, "title": f.title}))
        .collect()
}

/// A message to post. `from` is a role or `user`.
pub struct Outgoing<'a> {
    pub from: &'a str,
    /// A role, `user`, `all`, or several separated by commas. Empty with `reply_to` answers
    /// everyone in that thread.
    pub to: &'a str,
    /// `tell`, `ask`, `reply` or `decision`; anything else is sent as `tell`.
    pub kind: &'a str,
    pub text: &'a str,
    pub reply_to: Option<&'a str>,
}

/// Resolves `to` into roles, without the sender.
fn resolve_to(crew: &Crew, events: &[Value], from: &str, to: &str, reply_to: Option<&str>) -> Result<Vec<String>> {
    let names: Vec<String> = match (to.trim(), reply_to) {
        ("", Some(r)) => thread_members(events, r).into_iter().map(str::to_string).collect(),
        ("", None) => return Err(Error::Other("say who the message is for: a role, \"all\" or \"user\"".into())),
        (ALL, _) => crew.members.iter().map(|m| m.role.clone()).collect(),
        (t, _) => t.split(',').map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).collect(),
    };
    let mut out: Vec<String> = vec![];
    for n in names {
        if n != USER && !crew.members.iter().any(|m| m.role == n) {
            let roles: Vec<&str> = crew.members.iter().map(|m| m.role.as_str()).collect();
            return Err(Error::Other(format!("no member \"{n}\" in this crew; members are {}, and user", roles.join(", "))));
        }
        if n != from && !out.contains(&n) {
            out.push(n);
        }
    }
    if out.is_empty() {
        return Err(Error::Other("nobody to send to (a member cannot send to itself)".into()));
    }
    Ok(out)
}

/// Posts a message, and delivers it to each recipient that is between turns.
pub fn send(app: &AppHandle, vault: &Path, crew_id: &str, msg: Outgoing) -> Result<Sent> {
    let _lock = MAIL.lock().unwrap();
    post(app, vault, &find(vault, crew_id)?, msg)
}

fn post(app: &AppHandle, vault: &Path, crew: &Crew, msg: Outgoing) -> Result<Sent> {
    let Outgoing { from, to, kind, text, reply_to } = msg;
    let reply_to = reply_to.filter(|r| !r.is_empty());
    let kind = if KINDS.contains(&kind) { kind } else { "tell" };
    if text.trim().is_empty() {
        return Err(Error::Other("the message is empty".into()));
    }
    let events = events(vault, &crew.id);
    let to = resolve_to(crew, &events, from, to, reply_to)?;
    let hop = if from == USER { 0 } else { last_hop(&events, from) + 1 };
    let held = to.iter().any(|r| r != USER) && hop > crew.max_hops;
    let id = vault::new_id();
    let mut line = json!({"type": "crew_msg", "id": id, "from": from, "kind": kind, "text": text.trim(), "hop": hop, "at": vault::now()});
    line["to"] = if to.len() == 1 { json!(to[0]) } else { json!(to) };
    if let Some(r) = reply_to {
        line["reply_to"] = json!(r);
    }
    if held {
        line["held"] = json!(true);
    }
    log(app, vault, &crew.id, line)?;
    if !held {
        for r in to.iter().filter(|r| *r != USER) {
            deliver(app, vault, crew, r)?;
        }
    }
    Ok(Sent { id, to, held })
}

/// Lets a held message through. It counts as coming from the user, so hops start again from 0.
pub fn release(app: &AppHandle, vault: &Path, crew_id: &str, msg_id: &str) -> Result<()> {
    let _lock = MAIL.lock().unwrap();
    let crew = find(vault, crew_id)?;
    let events = events(vault, &crew.id);
    let msg = events
        .iter()
        .find(|e| e["type"] == "crew_msg" && e["id"] == msg_id && e["held"] == true)
        .ok_or_else(|| Error::Other("no held message with that id".into()))?;
    let to: Vec<String> = recipients(msg).into_iter().filter(|r| *r != USER).map(str::to_string).collect();
    log(app, vault, &crew.id, json!({"type": "crew_release", "msg": msg_id, "at": vault::now()}))?;
    for r in to {
        deliver(app, vault, &crew, &r)?;
    }
    Ok(())
}

/// Called when a member's turn ends: hands it whatever arrived while it was busy.
pub fn on_turn_end(app: &AppHandle, vault: &Path, session_id: &str) -> Result<()> {
    let Some(c) = claude::meta(vault, session_id)?.crew else { return Ok(()) };
    let _lock = MAIL.lock().unwrap();
    let crew = find(vault, &c.id)?;
    let _ = app.emit("crew://changed", json!({"crew_id": crew.id}));
    // A member replaced since (its session was deleted) no longer gets the role's mail.
    if member_session(&events(vault, &crew.id), &c.role).as_deref() != Some(session_id) {
        return Ok(());
    }
    deliver(app, vault, &crew, &c.role)
}

/// Starts a turn for `role` with all its pending mail, unless it is in a turn already.
/// The role's session is created on its first message. Callers hold `MAIL`.
fn deliver(app: &AppHandle, vault: &Path, crew: &Crew, role: &str) -> Result<()> {
    let runner = app.state::<Runner>();
    let events = events(vault, &crew.id);
    let session = member_session(&events, role).and_then(|s| claude::meta(vault, &s).ok());
    if session.as_ref().is_some_and(|m| runner.is_busy(&m.id)) {
        return Ok(());
    }
    let msgs = pending(&events, role);
    if msgs.is_empty() {
        return Ok(());
    }
    let released = ids_of(&events, "crew_release", "msg");
    let hop = msgs
        .iter()
        .map(|m| if m["id"].as_str().is_some_and(|id| released.contains(id)) { 0 } else { m["hop"].as_u64().unwrap_or(0) })
        .max()
        .unwrap_or(0);
    let ids: Vec<&str> = msgs.iter().filter_map(|m| m["id"].as_str()).collect();
    let prompt = msgs.iter().map(|m| render_message(m)).collect::<Vec<_>>().join("\n\n");
    let (meta, turn) = match session {
        Some(meta) => (meta, Turn::Resume),
        None => {
            let member = crew.members.iter().find(|m| m.role == role).ok_or_else(|| Error::Other(format!("no member {role}")))?;
            (new_member(app, crew, member)?, Turn::New)
        }
    };
    let session_id = meta.id.clone();
    runner.start(app.clone(), vault.to_path_buf(), meta, prompt, turn)?;
    if turn == Turn::New {
        log(app, vault, &crew.id, json!({"type": "crew_member", "role": role, "session": session_id, "at": vault::now()}))?;
    }
    log(app, vault, &crew.id, json!({"type": "crew_deliver", "to": role, "session": session_id, "msgs": ids, "hop": hop, "at": vault::now()}))
}

/// A new member, added by a member (after the user approves) or by the user.
pub struct NewMember<'a> {
    pub role: &'a str,
    pub instructions: &'a str,
    pub worktree: bool,
    pub permission_mode: Option<&'a str>,
}

/// Adds a member to the crew note: an entry under `members:` and its `### <role>` section under
/// `## Roles`. Its session starts when the first message reaches it.
pub fn add_member(app: &AppHandle, vault: &Path, crew_id: &str, by: &str, m: NewMember) -> Result<()> {
    let _lock = MAIL.lock().unwrap();
    let crew = find(vault, crew_id)?;
    let role = m.role.trim();
    if role.is_empty() || !role.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(Error::Other("a role is one word of letters, digits, - and _ (e.g. tester, ui-designer)".into()));
    }
    if [USER, ALL].contains(&role) || crew.members.iter().any(|x| x.role == role) {
        return Err(Error::Other(format!("the crew already has \"{role}\", or the name is reserved")));
    }
    if let Some(mode) = m.permission_mode.filter(|p| !["auto", "default", "acceptEdits", "plan"].contains(p)) {
        return Err(Error::Other(format!("unknown permission_mode: {mode}")));
    }
    let text = std::fs::read_to_string(&crew.path)?;
    let text = with_member(&text, role, m.worktree, m.permission_mode)?;
    let text = append_to_section(&text, "Roles", &format!("### {role}\n\n{}", m.instructions.trim()));
    std::fs::write(&crew.path, vault::fm_set(&text, "updated", &vault::now()))?;
    let _ = app.emit("vault://changed", json!({"path": crew.path}));
    log(app, vault, &crew.id, json!({"type": "crew_event", "text": format!("{by} added {role}"), "at": vault::now()}))
}

/// Records a decision under `## Decisions` in the crew note and tells every member.
pub fn decide(app: &AppHandle, vault: &Path, crew_id: &str, by: &str, decision: &str) -> Result<Sent> {
    let _lock = MAIL.lock().unwrap();
    let crew = find(vault, crew_id)?;
    let decision = decision.trim();
    if decision.is_empty() {
        return Err(Error::Other("the decision is empty".into()));
    }
    let text = std::fs::read_to_string(&crew.path)?;
    let item = format!("- {} ({by}): {}", &vault::now()[..10], decision.replace('\n', "\n  "));
    let text = append_to_section(&text, "Decisions", &item);
    std::fs::write(&crew.path, vault::fm_set(&text, "updated", &vault::now()))?;
    let _ = app.emit("vault://changed", json!({"path": crew.path}));
    let crew = find(vault, crew_id)?;
    let to = if crew.members.iter().any(|m| m.role != by) { ALL } else { USER };
    post(app, vault, &crew, Outgoing { from: by, to, kind: "decision", text: decision, reply_to: None })
}

/// Adds an entry to the frontmatter's block-style `members:` list, matching its indentation.
fn with_member(text: &str, role: &str, worktree: bool, mode: Option<&str>) -> Result<String> {
    let (Some(fm), body) = vault::split_frontmatter(text) else {
        return Err(Error::Other("the crew note has no frontmatter".into()));
    };
    let mut lines: Vec<String> = fm.lines().map(str::to_string).collect();
    let at = lines.iter().position(|l| l.starts_with("members:"));
    // Where the list ends, and the indentation of its items.
    let (insert, indent) = match at {
        Some(i) if lines[i].trim_end() == "members:" => {
            let mut j = i + 1;
            while j < lines.len() && (lines[j].starts_with(' ') || lines[j].starts_with('-')) {
                j += 1;
            }
            let indent = lines[i + 1..j]
                .iter()
                .find_map(|l| l.trim_start().starts_with("- ").then(|| l.len() - l.trim_start().len()))
                .unwrap_or(2);
            (j, indent)
        }
        Some(i) if lines[i].trim_end() == "members: []" => {
            lines[i] = "members:".into();
            (i + 1, 2)
        }
        Some(_) => return Err(Error::Other("members: in the crew note must be a block list".into())),
        None => {
            lines.push("members:".into());
            (lines.len(), 2)
        }
    };
    let pad = " ".repeat(indent);
    let mut entry = vec![format!("{pad}- role: {role}")];
    if !worktree {
        entry.push(format!("{pad}  worktree: false"));
    }
    if let Some(m) = mode.filter(|m| !m.is_empty()) {
        entry.push(format!("{pad}  permission_mode: {m}"));
    }
    lines.splice(insert..insert, entry);
    Ok(format!("---\n{}\n---\n{body}", lines.join("\n")))
}

/// Appends `content` at the end of the `## <h2>` section, adding the section at the end if missing.
/// Consecutive list items stay together; anything else gets a blank line before it.
fn append_to_section(text: &str, h2: &str, content: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut in_fence = false;
    let mut start = None;
    let mut end = lines.len();
    for (i, l) in lines.iter().enumerate() {
        if l.trim_start().starts_with("```") {
            in_fence = !in_fence;
        }
        if in_fence {
            continue;
        }
        let is_top = l.starts_with("## ") || l.starts_with("# ");
        match start {
            None if l.strip_prefix("## ").is_some_and(|h| h.trim().eq_ignore_ascii_case(h2)) => start = Some(i),
            Some(_) if is_top => {
                end = i;
                break;
            }
            _ => {}
        }
    }
    let Some(start) = start else {
        return format!("{}\n\n## {h2}\n\n{}\n", text.trim_end(), content.trim_end());
    };
    let mut last = end;
    while last > start + 1 && lines[last - 1].trim().is_empty() {
        last -= 1;
    }
    let prev = lines[last - 1].trim_start();
    let tight = last > start + 1 && prev.starts_with("- ") && content.starts_with("- ");
    let mut out: Vec<String> = lines[..last].iter().map(|s| s.to_string()).collect();
    if !tight {
        out.push(String::new());
    }
    out.extend(content.trim_end().lines().map(str::to_string));
    if end < lines.len() {
        out.push(String::new());
        out.extend(lines[end..].iter().map(|s| s.to_string()));
    }
    out.join("\n") + "\n"
}

fn render_message(m: &Value) -> String {
    let s = |k: &str| m[k].as_str().unwrap_or("");
    let reply = m["reply_to"].as_str().map(|r| format!(" reply_to=\"{r}\"")).unwrap_or_default();
    let to = recipients(m).join(",");
    format!("<crew-message id=\"{}\" from=\"{}\" to=\"{to}\" kind=\"{}\"{reply}>\n{}\n</crew-message>", s("id"), s("from"), s("kind"), s("text"))
}

/// A session for a member: in its own worktree when the project is a git repo and the member
/// wants one, otherwise in the project directory.
fn new_member(app: &AppHandle, crew: &Crew, member: &Member) -> Result<SessionMeta> {
    let session_id = vault::new_id();
    let worktree = match (&crew.project, member.worktree) {
        (Some(proj), true) => match git::repo_root(&vault::expand_home(proj)) {
            Some(repo) => {
                let short = &session_id[session_id.len().saturating_sub(6)..];
                let wanted = format!("marq/{}-{short}", vault::slug(&member.role));
                let branch = git::branch_name(&repo, Some(&wanted), &session_id)?;
                let _ = app.emit("task://progress", format!("Creating a worktree for {}…", member.role));
                Some(git::create(&repo, &session_id, &branch, false)?)
            }
            None => None,
        },
        _ => None,
    };
    let cwd = match &worktree {
        Some(wt) => wt.path.clone(),
        None => crew.project.clone().unwrap_or_else(|| Path::new(&crew.path).parent().unwrap().to_string_lossy().into_owned()),
    };
    Ok(SessionMeta {
        id: session_id,
        title: format!("{} · {}", crew.title, member.role),
        origin: crew.id.clone(),
        origin_path: crew.rel.clone(),
        cwd,
        started: vault::now(),
        permission_mode: member.permission_mode.clone(),
        model: None,
        worktree,
        crew: Some(CrewRef { id: crew.id.clone(), role: member.role.clone() }),
    })
}

/// Where other members work, so a member can read their files.
pub fn other_dirs(vault: &Path, crew_ref: &CrewRef) -> Vec<String> {
    let events = events(vault, &crew_ref.id);
    let Ok(crew) = find(vault, &crew_ref.id) else { return vec![] };
    crew.members
        .iter()
        .filter(|m| m.role != crew_ref.role)
        .filter_map(|m| member_session(&events, &m.role))
        .filter_map(|s| claude::meta(vault, &s).ok())
        .map(|m| vault::expand_home(&m.cwd).to_string_lossy().into_owned())
        .collect()
}

/// The part of a member's system prompt that tells it about its crew.
/// Creates a crew note in `crews/` for `goal` and sends the goal to its lead.
pub fn start(app: &AppHandle, vault: &Path, title: &str, goal: &str, project: &str) -> Result<Crew> {
    let rel = vault::unique_path(vault, "crews", title);
    std::fs::create_dir_all(vault.join("crews"))?;
    let path = vault.join(&rel);
    std::fs::write(&path, template(&vault::new_id(), title, &vault::now(), project, goal))?;
    let _ = app.emit("vault://changed", json!({"path": path}));
    let crew = find(vault, &rel)?;
    kick_off(app, vault, &crew.id)?;
    Ok(crew)
}

/// Sends the Goal to the first member, who forms the team and starts the work.
pub fn kick_off(app: &AppHandle, vault: &Path, crew_id: &str) -> Result<Sent> {
    let crew = find(vault, crew_id)?;
    let lead = crew.members.first().ok_or_else(|| Error::Other("the crew has no members".into()))?;
    if crew.goal.is_empty() || crew.goal == GOAL_PLACEHOLDER {
        return Err(Error::Other("write the crew's Goal in its note first".into()));
    }
    let text = format!(
        "Here is the crew's goal. Form the team if it is not complete, hold a kickoff discussion, record what you decide, \
and get the work started.\n\n{}",
        crew.goal
    );
    send(app, vault, &crew.id, Outgoing { from: USER, to: &lead.role, kind: "tell", text: &text, reply_to: None })
}

pub fn system_prompt(vault: &Path, crew_ref: &CrewRef) -> String {
    let Ok(crew) = find(vault, &crew_ref.id) else { return String::new() };
    let roster = crew
        .members
        .iter()
        .map(|m| format!("- {}{}", m.role, if m.role == crew_ref.role { " (you)" } else { "" }))
        .collect::<Vec<_>>()
        .join("\n");
    let own = crew.members.iter().find(|m| m.role == crew_ref.role).map(|m| m.instructions.trim()).unwrap_or("");
    format!(
        "\n\nYou are the \"{role}\" member of the crew \"{title}\", a team of Claude sessions working on one goal together.\n\n\
Members:\n{roster}\n- user (the human who runs the crew)\n\n\
Goal:\n{goal}\n\n\
Your role:\n{own}\n\n\
How the crew works:\n\
- Messages from others arrive as <crew-message id=\"…\" from=\"…\" to=\"…\" kind=\"…\"> blocks. Several may arrive in one turn.\n\
- Talk to members and the user only with the marq crew_send tool. to is a role, \"user\", \"all\" (every other member) \
or several roles separated by commas. Use kind \"ask\" when you need an answer, \"reply\" with reply_to set to the \
message id when you answer one, and \"tell\" otherwise.\n\
- Never wait or poll for an answer. Send, finish your turn, and the reply will arrive as a new message.\n\
- Discussions: a message to several members starts one. Answer it with reply_to and no to, and your reply reaches \
everyone in the thread. Say what you think once per round, briefly, and only when you add something new: agree, \
object with a reason, or propose an alternative. Whoever started the discussion (usually lead) closes it after one or \
two rounds with crew_decide.\n\
- crew_decide records a decision in the crew note's Decisions section and tells everyone. Follow recorded decisions; \
to change one, discuss it and record a new decision.\n\
- The crew's task list is shared: task_list shows it, task_add adds a task (with an owner, who is told), and \
task_update changes a task's status (todo, doing, review, blocked, done), owner or notes. Before starting work, take \
the task with status doing; if someone else already has it, pick another. Keep your tasks' status current, so members \
can work in parallel without overlapping, and note branches and commits on the task.\n\
- Save designs, plans, specs, investigations and reports with write_doc. They go to the crew's folder in the vault \
and are linked from the crew note, so every member and the user can read them with read_note.\n\
- crew_add_member adds a role to the crew (the user approves it). Add one only when the work needs a skill nobody has.\n\
- The roster can change. Use crew_members to see who is in the crew, where each member works (directory and branch) \
and who is busy.\n\
- Send the user only what needs a human: decisions you cannot make, blockers and finished results.\n\
- Keep messages self-contained: say which branch, files or commits you mean.",
        role = crew_ref.role,
        title = crew.title,
        goal = if crew.goal.is_empty() { "(not written yet)" } else { crew.goal.trim() },
        own = if own.is_empty() { "(no instructions; ask the user if unsure)" } else { own },
    )
}

#[derive(Debug, Serialize)]
pub struct MemberState {
    pub role: String,
    pub session_id: Option<String>,
    pub status: String,
    pub pending: usize,
    pub cwd: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CrewState {
    #[serde(flatten)]
    pub crew: Crew,
    pub members_state: Vec<MemberState>,
    /// `crew_msg` lines with `delivered` (to every member it is for) and `released` set, and
    /// `crew_event` lines, in order.
    pub messages: Vec<Value>,
    pub tasks: Vec<Task>,
    /// The task list's path.
    pub tasks_path: String,
    pub docs: Vec<Value>,
}

/// Everything the crew view shows.
pub fn state(app: &AppHandle, vault: &Path, crew_id: &str) -> Result<CrewState> {
    let crew = find(vault, crew_id)?;
    let runner = app.state::<Runner>();
    let events = events(vault, &crew.id);
    let released = ids_of(&events, "crew_release", "msg");
    let delivered: std::collections::HashMap<&str, HashSet<String>> =
        crew.members.iter().map(|m| (m.role.as_str(), delivered_to(&events, &m.role))).collect();
    let members_state: Vec<MemberState> = crew
        .members
        .iter()
        .map(|m| {
            let session = member_session(&events, &m.role);
            let log = session.as_ref().and_then(|s| claude::read_events(vault, s).ok());
            let meta = session.as_ref().and_then(|s| claude::meta(vault, s).ok());
            let status = match (&session, &log) {
                (Some(s), _) if !runner.approvals(Some(s)).is_empty() => "waiting".to_string(),
                (Some(s), _) if runner.is_busy(s) => "running".to_string(),
                (Some(_), Some(l)) => match claude::status_of(l).as_str() {
                    // Logged as running without a live turn: the app stopped part-way.
                    "running" => "interrupted".to_string(),
                    s => s.to_string(),
                },
                _ => "idle".to_string(),
            };
            MemberState {
                role: m.role.clone(),
                status,
                pending: pending(&events, &m.role).len(),
                cwd: meta.as_ref().map(|m| m.cwd.clone()),
                branch: meta.and_then(|m| m.worktree).map(|w| w.branch),
                session_id: session,
            }
        })
        .collect();
    let messages = events
        .iter()
        .filter(|e| e["type"] == "crew_msg" || e["type"] == "crew_event")
        .map(|e| {
            let id = e["id"].as_str().unwrap_or("");
            let mut m = e.clone();
            let all = recipients(e).iter().filter(|r| **r != USER).all(|r| delivered.get(r).is_some_and(|d| d.contains(id)));
            m["delivered"] = json!(all);
            m["released"] = json!(released.contains(id));
            m
        })
        .collect();
    let (path, list) = read_tasks(vault, &crew)?;
    let docs = crew_docs(vault, &crew.id);
    Ok(CrewState { crew, members_state, messages, tasks: list.tasks, tasks_path: path.to_string_lossy().into_owned(), docs })
}

/// The roster for the crew_members tool.
pub fn members_for_tool(app: &AppHandle, vault: &Path, crew_ref: &CrewRef) -> Result<Value> {
    let st = state(app, vault, &crew_ref.id)?;
    let members: Vec<Value> = st
        .members_state
        .iter()
        .map(|m| {
            json!({"role": m.role, "you": m.role == crew_ref.role, "status": m.status, "unread": m.pending,
                "cwd": m.cwd, "branch": m.branch})
        })
        .collect();
    Ok(json!({"crew": st.crew.title, "project": st.crew.project, "members": members}))
}

const GOAL_PLACEHOLDER: &str = "What the crew should build or fix, and how you will know it is done.";

/// The note written by New crew. It starts with only a lead, who designs the team.
/// An empty `goal` leaves a placeholder for the user to fill in.
pub fn template(id: &str, title: &str, now: &str, project: &str, goal: &str) -> String {
    let q = serde_json::to_string(title).unwrap();
    let project = if project.is_empty() { String::new() } else { format!(" {project}") };
    let goal = if goal.trim().is_empty() { GOAL_PLACEHOLDER } else { goal.trim() };
    format!(
        r#"---
id: {id}
type: crew
title: {q}
created: {now}
updated: {now}
project:{project}
# Member-to-member messages allowed after each message from you before the crew pauses for you.
max_hops: 20
# role: the member's address. worktree: false works in the project directory instead of its own worktree.
# permission_mode: auto (default) | default | acceptEdits | plan
# lead adds the rest of the team with crew_add_member. List members here to choose them yourself.
members:
  - role: lead
    worktree: false
---
# {title}

## Goal

{goal}

## Roles

### lead

You run the crew and do not edit code yourself.

1. Design the team. Read the Goal, look at the project, and decide which roles the work needs, for example impl,
   reviewer and tester. Keep it small (two to four). Add each with crew_add_member, with instructions that say what
   it owns, how it hands work on, and who reviews it. Members that change code get their own worktree; reviewers
   and testers work with `worktree: false` and read the other branches.
2. Hold a kickoff discussion. Send your plan to all with kind "ask": the approach, the first tasks and who does
   what. Collect objections, settle them, and record the result with crew_decide.
   Save the design as a document with write_doc.
3. Break the work into small, independent tasks with task_add, giving each an owner so they run in parallel. For
   more parallel work, add more implementers (impl-1, impl-2…), each in its own worktree.
4. Run the work. Watch the task list, make sure every change is reviewed and tested before it is done, discuss and
   record decisions whenever the plan changes, and tell the user what is ready and what needs them.

## Decisions
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const CREW: &str = "---\nid: c1\ntype: crew\ntitle: Hover\nproject: ~/dev/mq\nmembers:\n  - role: lead\n    worktree: false\n  - role: impl\n---\n# Hover\n\n## Goal\n\nShow types.\n\n## Roles\n\n### lead\n\nPlan.\n\n### impl\n\nBuild it.\n\n## Decisions\n\n- 2026-10-28 (lead): use LSP\n";

    #[test]
    fn parses_a_crew_note() {
        let crew = parse(CREW, Path::new("/v/crews/h.md"), Path::new("/v")).unwrap();
        assert_eq!(crew.id, "c1");
        assert_eq!(crew.rel, "crews/h.md");
        assert_eq!(crew.project.as_deref(), Some("~/dev/mq"));
        assert_eq!(crew.max_hops, DEFAULT_MAX_HOPS);
        let roles: Vec<_> = crew.members.iter().map(|m| (m.role.as_str(), m.worktree)).collect();
        assert_eq!(roles, [("lead", false), ("impl", true)]);
        assert_eq!(crew.members[1].instructions, "Build it.");
        assert_eq!(crew.goal, "Show types.");
        let t = template("c2", "New", "2026-10-28T10:00:00+09:00", "~/dev/x", "Build it\n\nwell");
        let crew = parse(&t, Path::new("/v/crews/n.md"), Path::new("/v")).unwrap();
        assert_eq!(crew.members.len(), 1);
        assert!(crew.members[0].instructions.contains("crew_add_member"));
        assert_eq!(crew.project.as_deref(), Some("~/dev/x"));
        assert_eq!(crew.goal, "Build it\n\nwell");
    }

    #[test]
    fn adds_a_member_to_the_note() {
        let t = with_member(CREW, "tester", false, Some("acceptEdits")).unwrap();
        let t = append_to_section(&t, "Roles", "### tester\n\nRun the tests.");
        let crew = parse(&t, Path::new("/v/crews/h.md"), Path::new("/v")).unwrap();
        let tester = crew.members.iter().find(|m| m.role == "tester").unwrap();
        assert!(!tester.worktree);
        assert_eq!(tester.permission_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(tester.instructions, "Run the tests.");
        // The new role goes before the next section.
        assert!(t.contains("Build it.\n\n### tester\n\nRun the tests.\n\n## Decisions"));
    }

    #[test]
    fn appends_decisions_as_one_list() {
        let t = append_to_section(CREW, "Decisions", "- 2026-10-29 (lead): ship it");
        assert!(t.ends_with("- 2026-10-28 (lead): use LSP\n- 2026-10-29 (lead): ship it\n"));
        let t = append_to_section("# A\n\nbody\n", "Decisions", "- x");
        assert_eq!(t, "# A\n\nbody\n\n## Decisions\n\n- x\n");
        // An empty section, as in the template.
        let t = append_to_section("# A\n\n## Decisions\n", "Decisions", "- x");
        assert_eq!(t, "# A\n\n## Decisions\n\n- x\n");
    }

    #[test]
    fn replies_reach_the_whole_thread() {
        let ev = vec![
            json!({"type": "crew_msg", "id": "a", "from": "lead", "to": ["impl", "reviewer"]}),
            json!({"type": "crew_msg", "id": "b", "from": "impl", "to": ["lead", "reviewer"], "reply_to": "a"}),
            json!({"type": "crew_deliver", "to": "reviewer", "msgs": ["a"], "hop": 1}),
        ];
        assert_eq!(thread_members(&ev, "b"), ["impl", "lead", "reviewer"]);
        // Delivered to reviewer does not mean delivered to impl.
        assert_eq!(pending(&ev, "impl").len(), 1);
        assert_eq!(pending(&ev, "reviewer").len(), 1);
    }

    #[test]
    fn pending_skips_delivered_and_held_mail() {
        let ev = vec![
            json!({"type": "crew_msg", "id": "a", "to": "impl", "hop": 0}),
            json!({"type": "crew_msg", "id": "b", "to": "impl", "hop": 1}),
            json!({"type": "crew_msg", "id": "c", "to": "impl", "hop": 13, "held": true}),
            json!({"type": "crew_msg", "id": "d", "to": "lead", "hop": 1}),
            json!({"type": "crew_deliver", "to": "impl", "msgs": ["a"], "hop": 0}),
        ];
        let ids = |v: Vec<&Value>| v.iter().map(|m| m["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(ids(pending(&ev, "impl")), ["b"]);
        let mut ev = ev;
        ev.push(json!({"type": "crew_release", "msg": "c"}));
        assert_eq!(ids(pending(&ev, "impl")), ["b", "c"]);
        assert_eq!(last_hop(&ev, "impl"), 0);
    }
}
