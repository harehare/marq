//! Talks to `sidecar/main.ts`, which runs sessions on agent backends (Claude through the Agent SDK).
//!
//! One Node process serves every session. Commands go to its stdin as JSON lines and events
//! come back on stdout. The sidecar keeps a session's process alive between turns, so follow-ups,
//! interrupts and approvals work while the agent is running.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::agents;
use crate::session::{self, SessionMeta};
use crate::error::{Error, Result};
use crate::thesaurus::{Query, Thesaurus};
use crate::{boards, crew, knowledge, links, mq, organize, relay, vault, workflow, workspace};

/// How a turn reaches the agent.
#[derive(Clone, Copy, PartialEq)]
pub enum Turn {
    /// A new session: log its metadata and start a conversation with its id.
    New,
    /// A follow-up: continue the existing conversation.
    Resume,
    /// The session is logged but its conversation never started (it failed before the agent ran),
    /// so start the conversation again with the same id.
    Restart,
}

/// A tool call waiting for the user's answer.
#[derive(Debug, Clone, Serialize)]
pub struct Approval {
    pub request_id: String,
    pub session_id: String,
    pub tool_name: String,
    pub input: Value,
    pub title: Option<String>,
    pub reason: Option<String>,
}

#[derive(Default)]
pub struct Runner {
    tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    /// Sessions whose agent process is alive in the sidecar.
    alive: Mutex<HashSet<String>>,
    /// Sessions in a turn: from a prompt until its result. Crew mail waits for these.
    busy: Mutex<HashSet<String>>,
    /// Vault of each session seen in this app run, for writing its log.
    vaults: Mutex<HashMap<String, PathBuf>>,
    approvals: Mutex<HashMap<String, Approval>>,
    summaries: Mutex<HashMap<String, oneshot::Sender<std::result::Result<String, String>>>>,
    replies: Mutex<HashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>,
}

use crate::shell::which;

/// The default agent's executable on the shell's PATH.
fn executable(agent: Option<&str>) -> String {
    agents::command(agent).0
}

/// The id of the agent's own session, which an ACP agent needs to resume it: the last `init` that has one.
fn agent_session(vault: &Path, id: &str) -> Option<String> {
    let events = session::read_events(vault, id).ok()?;
    events.iter().rev().filter(|e| e["type"] == "init").find_map(|e| e["session"].as_str().map(str::to_string))
}

fn sidecar_script() -> PathBuf {
    std::env::var_os("MARQ_SIDECAR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecar/main.ts"))
}

const SYSTEM_APPEND: &str = "You are running inside marq, the user's Markdown knowledge base (the vault). \
The MCP server \"marq\" can search_notes, query_notes (mq queries) and read_note to look up the user's notes, \
earlier sessions and their learnings for background; search_sessions finds past sessions by what was said or done in them. \
search_notes also finds synonyms from the vault's glossary (glossary.md: preferred terms with aliases, broader and \
narrower terms) and notes' aliases, and tag:<name> narrows it to notes with that tag. When you write documents or \
learnings, use the glossary's preferred terms rather than synonyms, and give documents a few tags. \
Link notes with [[Title]] (a note's title, file name or alias); read_note accepts the same names, and note_links \
shows what links to a note and where it is mentioned without a link. \
The user's tasks are on kanban boards (list_boards, read_board, board_add_card, board_update_card): \
when working on a card, move it and add notes as you go.\n\n\
Documents you write for the user, such as reports, plans, designs, investigations, summaries, how-tos and meeting \
notes, belong in the vault: save them with the marq write_doc tool, not as files in the working directory. \
To revise one, call write_doc again with its path. Only put a document in the repository when the user asks for \
that, or when it is part of the code (README, docs the project ships, code comments). \
Mention the saved path in your reply.\n\n\
When you learn something worth keeping (a gotcha, a decision, a fact about the codebase), record it with append_learning.\n\n\
When the user asks you to organize their notes, use list_notes to see the vault, create_folder for new folders, \
and move_note to move or rename notes and folders; it keeps relative links between notes working. \
Leave sessions/ alone, since Marq manages it.\n\n\
For a large task that needs several kinds of work in parallel, such as a feature spanning many parts that should be \
designed, implemented, reviewed and tested separately, you can hand it to a crew with start_crew: a team of sessions \
with a lead that forms the team and runs it. The user approves it. Do small and medium tasks yourself.";

/// The sidecar command that starts a session's process. Crew members also get the crew's
/// system prompt, the crew tools and read access to the other members' directories.
fn start_cmd(vault: &Path, meta: &SessionMeta, prompt: &str, resume: bool) -> Value {
    let mut system = SYSTEM_APPEND.to_string();
    let mut dirs = vec![];
    system.push_str(&knowledge::for_project(vault, meta.project()));
    if let Some(c) = &meta.crew {
        system.push_str(&crew::system_prompt(vault, c));
        dirs = crew::other_dirs(vault, c);
    }
    system.push_str(&workspace::system_prompt(&meta.dirs, None));
    dirs.extend(meta.dirs.iter().map(|d| d.path.clone()));
    let (executable, args) = agents::command(meta.agent.as_deref());
    json!({
        "op": "start",
        "id": meta.id,
        "cwd": vault::expand_home(&meta.cwd),
        "prompt": prompt,
        "resume": resume,
        "permissionMode": meta.permission_mode,
        "model": meta.model,
        "agent": meta.agent,
        "executable": executable,
        "args": args,
        "agentSession": if resume { agent_session(vault, &meta.id) } else { None },
        "system": system,
        "crew": meta.crew.is_some(),
        "additionalDirectories": dirs,
        "sandbox": meta.sandbox,
    })
}

/// Resolves the default agent and `node` and starts the sidecar ahead of the first session.
pub fn prewarm(app: &AppHandle) {
    executable(None);
    which("node");
    if let Err(e) = app.state::<Runner>().sender(app) {
        eprintln!("marq: {e}");
    }
}

impl Runner {
    fn sender(&self, app: &AppHandle) -> Result<mpsc::UnboundedSender<String>> {
        let mut tx = self.tx.lock().unwrap();
        if tx.as_ref().is_none_or(|t| t.is_closed()) {
            *tx = Some(spawn(app.clone())?);
        }
        Ok(tx.as_ref().unwrap().clone())
    }

    fn send(&self, app: &AppHandle, cmd: Value) -> Result<()> {
        self.sender(app)?
            .send(cmd.to_string())
            .map_err(|_| Error::Other("the sidecar is not running".into()))
    }

    /// Starts a session, or sends a turn to it. A session whose process has exited is resumed.
    pub fn start(&self, app: AppHandle, vault: PathBuf, meta: SessionMeta, prompt: String, turn: Turn) -> Result<()> {
        let id = meta.id.clone();
        // Marked alive before the prompt is logged, so a concurrent listing never sees it as stale.
        let was_alive = !self.alive.lock().unwrap().insert(id.clone());
        self.busy.lock().unwrap().insert(id.clone());
        let raw = session::raw_path(&vault, &id);
        std::fs::create_dir_all(raw.parent().unwrap())?;
        if turn == Turn::New {
            let mut m = serde_json::to_value(&meta).unwrap();
            m["type"] = json!("marq_meta");
            session::append(&raw, &m)?;
        }
        session::append(&raw, &json!({"type": "marq_user", "text": prompt, "timestamp": vault::now()}))?;
        session::rerender(&vault, &id)?;
        self.vaults.lock().unwrap().insert(id.clone(), vault.clone());
        // The session is running again: the session list moves it to Active.
        let _ = app.emit("sessions://changed", &id);

        let cmd = if was_alive {
            // A crew member's model can change between turns.
            json!({"op": "send", "id": id, "text": prompt, "model": meta.model})
        } else {
            start_cmd(&vault, &meta, &prompt, turn == Turn::Resume)
        };
        if let Err(e) = self.send(&app, cmd) {
            finish(&app, &id, "error", Some(&e.to_string()));
            return Err(e);
        }
        Ok(())
    }

    pub fn is_alive(&self, id: &str) -> bool {
        self.alive.lock().unwrap().contains(id)
    }

    /// Whether the session is in a turn.
    pub fn is_busy(&self, id: &str) -> bool {
        self.busy.lock().unwrap().contains(id)
    }

    /// Ends the session's process. Pending approvals are denied.
    pub fn stop(&self, app: &AppHandle, id: &str) -> Result<()> {
        if !self.is_alive(id) {
            return Ok(());
        }
        self.send(app, json!({"op": "stop", "id": id}))
    }

    /// Interrupts the current turn. The session stays open for follow-ups.
    pub fn interrupt(&self, app: &AppHandle, id: &str) -> Result<()> {
        self.send(app, json!({"op": "interrupt", "id": id}))
    }

    pub fn answer(&self, app: &AppHandle, request_id: &str, allow: bool, always: bool, message: Option<String>) -> Result<()> {
        let Some(a) = self.approvals.lock().unwrap().remove(request_id) else {
            return Err(Error::Other("this request was already answered".into()));
        };
        if let Some(v) = self.vaults.lock().unwrap().get(&a.session_id) {
            let line = json!({"type": "marq_approval", "tool": a.tool_name, "input": a.input, "allow": allow, "always": always});
            let _ = session::append(&session::raw_path(v, &a.session_id), &line);
        }
        let _ = app.emit("session://approval", json!({"session_id": a.session_id, "request_id": request_id, "answered": true}));
        self.send(app, json!({"op": "approval", "requestId": request_id, "allow": allow, "always": always, "message": message}))
    }

    pub fn approvals(&self, session_id: Option<&str>) -> Vec<Approval> {
        self.approvals
            .lock()
            .unwrap()
            .values()
            .filter(|a| session_id.is_none_or(|s| s == a.session_id))
            .cloned()
            .collect()
    }

    /// Writes `## Summary` and `## Learnings` from a forked one-turn summary of the session.
    pub async fn summarize(&self, app: &AppHandle, vault: &Path, id: &str) -> Result<String> {
        let meta = session::meta(vault, id)?;
        let (executable, args) = agents::command(meta.agent.as_deref());
        // Agents that cannot fork a conversation summarize the session note instead.
        let transcript = std::fs::read_to_string(session::md_path(vault, &meta)).unwrap_or_default();
        let req_id = vault::new_id();
        let (tx, rx) = oneshot::channel();
        self.summaries.lock().unwrap().insert(req_id.clone(), tx);
        self.send(
            app,
            json!({
                "op": "summarize",
                "reqId": req_id,
                "id": id,
                "cwd": vault::expand_home(&meta.cwd),
                "instruction": SUMMARY_INSTRUCTION,
                "model": meta.model,
                "agent": meta.agent,
                "executable": executable,
                "args": args,
                "agentSession": agent_session(vault, id),
                "transcript": transcript,
            }),
        )?;
        let text = rx.await.map_err(|_| Error::Other("the sidecar exited".into()))?.map_err(Error::Other)?;
        session::set_summary(vault, id, &text)?;
        Ok(text)
    }
}

impl Runner {
    /// Slash commands and skills the default agent offers in `cwd`, from the running session if there is one.
    pub async fn commands(&self, app: &AppHandle, cwd: &str, session_id: Option<&str>) -> Result<Value> {
        let req_id = vault::new_id();
        let (tx, rx) = oneshot::channel();
        self.replies.lock().unwrap().insert(req_id.clone(), tx);
        let id = session_id.filter(|s| self.is_alive(s));
        self.send(
            app,
            json!({"op": "commands", "reqId": req_id, "id": id, "cwd": vault::expand_home(cwd), "executable": executable(None)}),
        )?;
        rx.await.map_err(|_| Error::Other("the sidecar exited".into()))?.map_err(Error::Other)
    }
}

impl Runner {
    /// A short task title from a small model (or the task's Ollama model). Times out after 15s (Ollama: 60s).
    pub async fn title(&self, app: &AppHandle, text: &str, model: Option<&str>) -> Result<String> {
        let req_id = vault::new_id();
        let (tx, rx) = oneshot::channel();
        self.replies.lock().unwrap().insert(req_id.clone(), tx);
        self.send(app, json!({"op": "title", "reqId": req_id, "text": text, "model": model, "executable": executable(None)}))?;
        let secs = if model.is_some_and(|m| m.starts_with("ollama:")) { 60 } else { 15 };
        let reply = tokio::time::timeout(std::time::Duration::from_secs(secs), rx).await;
        self.replies.lock().unwrap().remove(&req_id);
        let value = reply
            .map_err(|_| Error::Other("naming the task took too long".into()))?
            .map_err(|_| Error::Other("the sidecar exited".into()))?
            .map_err(Error::Other)?;
        clean_title(value.as_str().unwrap_or("")).ok_or_else(|| Error::Other("no title".into()))
    }

    /// Pulled Ollama models as `ollama:<name>`.
    pub async fn ollama_models(&self, app: &AppHandle) -> Result<Value> {
        let req_id = vault::new_id();
        let (tx, rx) = oneshot::channel();
        self.replies.lock().unwrap().insert(req_id.clone(), tx);
        self.send(app, json!({"op": "ollama_models", "reqId": req_id}))?;
        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), rx).await;
        self.replies.lock().unwrap().remove(&req_id);
        reply
            .map_err(|_| Error::Other("Ollama did not answer".into()))?
            .map_err(|_| Error::Other("the sidecar exited".into()))?
            .map_err(Error::Other)
    }
}

/// The first line of a model's reply, without quotes or Markdown, at most 60 characters.
fn clean_title(s: &str) -> Option<String> {
    let line = s.lines().map(str::trim).find(|l| !l.is_empty())?;
    let t = line.trim_start_matches(['#', '*', '-', ' ']).trim_end_matches('*');
    let t = t.trim_matches(['"', '\'', '「', '」', '`', '*', ' ']);
    let t: String = t.chars().take(60).collect();
    (!t.is_empty()).then_some(t)
}

const SUMMARY_INSTRUCTION: &str = "Summarize this session for my notes. Reply with Markdown only, in exactly this shape:\n\n\
## Summary\n\n<3-6 sentences: what was asked, what was done, the outcome and anything left open>\n\n\
## Learnings\n\n- <reusable insights: gotchas, decisions and their reasons, facts about the codebase. Skip the obvious. \
Write '- None' if there are none>";

fn spawn(app: AppHandle) -> Result<mpsc::UnboundedSender<String>> {
    // Sync commands run on the main thread, outside the tokio runtime that tokio::process needs.
    let rt = tauri::async_runtime::handle();
    let _guard = rt.inner().enter();
    let script = sidecar_script();
    // The sidecar and every agent process under it get the shell's PATH, so the agent's Bash tool
    // finds the same commands as in a terminal.
    let mut cmd = tokio::process::Command::new(which("node"));
    if let Some(url) = crate::config::ollama_url() {
        cmd.env("OLLAMA_HOST", url);
    }
    let mut child = cmd
        .env("PATH", crate::shell::path())
        .arg(&script)
        .current_dir(script.parent().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Error::Other(format!("failed to start the sidecar ({}): {e}", script.display())))?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    tauri::async_runtime::spawn(async move {
        while let Some(line) = rx.recv().await {
            if stdin.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                break;
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(ev) = serde_json::from_str::<Value>(&line) {
                handle(&app, ev).await;
            }
        }
        let _ = child.wait().await;
        sidecar_exited(&app);
    });
    Ok(tx)
}

/// Every session that was alive ends when the sidecar does.
fn sidecar_exited(app: &AppHandle) {
    let runner = app.state::<Runner>();
    let ids: Vec<String> = runner.alive.lock().unwrap().drain().collect();
    for id in ids {
        finish(app, &id, "error", Some("the sidecar exited"));
    }
    runner.approvals.lock().unwrap().clear();
    *runner.tx.lock().unwrap() = None;
}

fn finish(app: &AppHandle, id: &str, status: &str, error: Option<&str>) {
    let runner = app.state::<Runner>();
    runner.alive.lock().unwrap().remove(id);
    runner.busy.lock().unwrap().remove(id);
    runner.approvals.lock().unwrap().retain(|_, a| a.session_id != id);
    if let Some(v) = runner.vaults.lock().unwrap().get(id) {
        let _ = session::append(
            &session::raw_path(v, id),
            &json!({"type": "marq_exit", "status": status, "ended": vault::now(), "stderr": error.unwrap_or("")}),
        );
        let _ = session::rerender(v, id);
    }
    let _ = app.emit("session://exit", json!({"session_id": id, "status": status, "stderr": error.unwrap_or("")}));
    // A crew member that failed may be started again.
    if status == "error"
        && let Some(v) = runner.vaults.lock().unwrap().get(id).cloned()
    {
        let (app, id) = (app.clone(), id.to_string());
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = crew::on_exit(&app, &v, &id) {
                eprintln!("marq: could not restart the crew member: {e}");
            }
        });
    }
}

async fn handle(app: &AppHandle, ev: Value) {
    let runner = app.state::<Runner>();
    let id = ev["id"].as_str().unwrap_or("").to_string();
    let vault = runner.vaults.lock().unwrap().get(&id).cloned();
    match ev["ev"].as_str().unwrap_or("") {
        "event" => {
            let Some(v) = vault else { return };
            let event = &ev["event"];
            let _ = session::append(&session::raw_path(&v, &id), event);
            let _ = app.emit("session://event", json!({"session_id": id, "event": event}));
            if event["type"] == "turn_end" {
                let _ = session::rerender(&v, &id);
                if let Ok(Some(path)) = session::write_back(&v, &id) {
                    let _ = app.emit("vault://changed", json!({"path": path}));
                }
                // The final reply, for the notification.
                let _ = app.emit("session://turn", json!({"session_id": id, "result": event["result"].as_str().unwrap_or("")}));
                runner.busy.lock().unwrap().remove(&id);
                // Crew mail that arrived during the turn is delivered now.
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(e) = crew::on_turn_end(&app, &v, &id) {
                        eprintln!("marq: crew delivery failed: {e}");
                    }
                    // So do replies other sessions are waiting for.
                    if let Err(e) = relay::on_turn_end(&app, &v, &id) {
                        eprintln!("marq: reply failed: {e}");
                    }
                    // Checks the work, moves a phased request on, and settles the session for the queue.
                    workflow::on_turn_end(&app, &v, &id);
                });
            }
        }
        "exit" => finish(app, &id, ev["status"].as_str().unwrap_or("done"), ev["error"].as_str()),
        "approval_request" => {
            let a = Approval {
                request_id: ev["requestId"].as_str().unwrap_or("").to_string(),
                session_id: id.clone(),
                tool_name: ev["toolName"].as_str().unwrap_or("").to_string(),
                input: ev["input"].clone(),
                title: ev["title"].as_str().map(str::to_string),
                reason: ev["reason"].as_str().map(str::to_string),
            };
            runner.approvals.lock().unwrap().insert(a.request_id.clone(), a.clone());
            let _ = app.emit("session://approval", &a);
        }
        "approval_cancelled" => {
            let request_id = ev["requestId"].as_str().unwrap_or("");
            runner.approvals.lock().unwrap().remove(request_id);
            let _ = app.emit("session://approval", json!({"session_id": id, "request_id": request_id, "answered": true}));
        }
        "not_running" => {
            // The process ended between our check and the send, so resume it with the same text.
            runner.alive.lock().unwrap().remove(&id);
            if let (Some(v), Some(text)) = (vault, ev["text"].as_str())
                && let Ok(meta) = session::meta(&v, &id)
            {
                runner.alive.lock().unwrap().insert(id.clone());
                let _ = runner.send(app, start_cmd(&v, &meta, text, true));
            }
        }
        "reply" => {
            let req = ev["reqId"].as_str().unwrap_or("");
            if let Some(tx) = runner.replies.lock().unwrap().remove(req) {
                let r = match ev["error"].as_str() {
                    Some(e) => Err(e.to_string()),
                    None => Ok(ev["result"].clone()),
                };
                let _ = tx.send(r);
            }
        }
        "summary" => {
            let req = ev["reqId"].as_str().unwrap_or("");
            if let Some(tx) = runner.summaries.lock().unwrap().remove(req) {
                let r = match ev["error"].as_str() {
                    Some(e) => Err(e.to_string()),
                    None => Ok(ev["text"].as_str().unwrap_or("").to_string()),
                };
                let _ = tx.send(r);
            }
        }
        "rpc" => {
            let req_id = ev["reqId"].as_str().unwrap_or("").to_string();
            let session = ev["params"]["session"].as_str().unwrap_or("").to_string();
            let vault = runner.vaults.lock().unwrap().get(&session).cloned();
            let method = ev["method"].as_str().unwrap_or("").to_string();
            let params = ev["params"].clone();
            let app = app.clone();
            // mq's engine is not Send, so tools run on a blocking thread.
            tauri::async_runtime::spawn_blocking(move || {
                let reply = match vault {
                    Some(v) => rpc(&app, &v, &session, &method, &params),
                    None => Err(Error::Other("unknown session".into())),
                };
                let msg = match reply {
                    Ok(result) => json!({"op": "rpc_result", "reqId": req_id, "result": result}),
                    Err(e) => json!({"op": "rpc_result", "reqId": req_id, "error": e.to_string()}),
                };
                let _ = app.state::<Runner>().send(&app, msg);
            });
        }
        _ => {}
    }
}

fn changed(app: &AppHandle, path: &Path) {
    let _ = app.emit("vault://changed", json!({"path": path}));
}

/// A note by id, vault-relative path, or what a `[[wikilink]]` would name (title, file name, alias).
fn find_any(vault: &Path, note: &str) -> Result<PathBuf> {
    vault::find_note(vault, note)
        .or_else(|| links::resolve(&vault::list_files(vault), note.trim_start_matches("[[").trim_end_matches("]]")).map(|f| PathBuf::from(&f.path)))
        .ok_or_else(|| Error::Other(format!("note not found: {note}")))
}

/// Vault tools for agents.
fn rpc(app: &AppHandle, vault: &Path, session: &str, method: &str, p: &Value) -> Result<Value> {
    let s = |k: &str| p[k].as_str().unwrap_or("").to_string();
    match method {
        "search_notes" => Ok(json!(search(vault, &s("text")))),
        "list_boards" => Ok(json!(boards::list(vault))),
        "read_board" => Ok(json!(boards::read(&boards::find(vault, &s("board"))?)?)),
        "board_add_card" => {
            let path = boards::find(vault, &s("board"))?;
            let c = boards::add(&path, &s("title"), p["list"].as_str(), p["owner"].as_str(), p["note"].as_str())?;
            changed(app, &path);
            Ok(json!(c))
        }
        "board_update_card" => {
            let path = boards::find(vault, &s("board"))?;
            let c = boards::update(&path, &s("id"), serde_json::from_value(p.clone()).unwrap_or_default())?;
            changed(app, &path);
            Ok(json!(c))
        }
        "write_spec" => {
            let meta = session::meta(vault, session)?;
            let rel = workflow::write_spec(vault, &s("title"), &s("content"), p["path"].as_str(), meta.project(), p["verify"].as_str())?;
            changed(app, &vault.join(&rel));
            Ok(json!({"saved": rel, "next": "The user reviews the spec. spec_to_board puts its open tasks on a board."}))
        }
        "spec_to_board" => {
            let spec = find_any(vault, &s("spec"))?;
            let (board, added) = workflow::spec_to_board(vault, &spec)?;
            changed(app, &board);
            changed(app, &spec);
            Ok(json!({"board": board.strip_prefix(vault).unwrap_or(&board).to_string_lossy(), "cards_added": added}))
        }
        "create_board" => {
            let lists: Vec<String> = p["lists"].as_array().map(|l| l.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            let path = boards::create(vault, &s("name"), &lists)?;
            changed(app, &path);
            Ok(json!({"created": path.strip_prefix(vault).unwrap_or(&path).to_string_lossy(), "lists": boards::read(&path)?.lists.iter().map(|l| l.name.clone()).collect::<Vec<_>>()}))
        }
        "board_add_list" => {
            let path = boards::find(vault, &s("board"))?;
            boards::add_list(&path, &s("name"))?;
            changed(app, &path);
            Ok(json!({"added": s("name")}))
        }
        "query_notes" => {
            let r = mq::eval(vault, &s("query"), None, Some(&s("glob")), None, p["aggregate"].as_bool().unwrap_or(true))?;
            Ok(serde_json::to_value(r).unwrap())
        }
        "read_note" => {
            let note = s("note");
            let path = find_any(vault, &note)?;
            Ok(json!(std::fs::read_to_string(path)?))
        }
        "list_learnings" => {
            let project = p["project"].as_str().filter(|v| !v.is_empty());
            Ok(knowledge::list_json(knowledge::learnings(vault, project, p["all"].as_bool().unwrap_or(false))))
        }
        "write_knowledge" => {
            let strs = |k: &str| -> Vec<String> {
                p[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
            };
            let (topic, content, sources, tags) = (s("topic"), s("content"), strs("sources"), strs("tags"));
            let project = p["project"].as_str();
            let req = knowledge::KnowledgeWrite { topic: &topic, content: &content, sources: &sources, tags: &tags, project };
            let rel = knowledge::write(vault, req)?;
            changed(app, &vault.join(&rel));
            Ok(json!({"path": rel, "status": "draft", "note": "The user reviews it before it counts as checked."}))
        }
        "note_links" => {
            let note = s("note");
            let path = find_any(vault, &note)?;
            let rel = path.strip_prefix(vault).unwrap_or(&path).to_string_lossy().into_owned();
            let b = links::backlinks(&vault::list_files(vault), &rel);
            Ok(json!({"note": rel, "links_here": b.linked, "mentions": b.mentions, "links_to": b.outgoing, "missing": b.missing}))
        }
        "write_doc" => {
            let meta = session::meta(vault, session)?;
            let opt = |k: &str| p[k].as_str().filter(|v| !v.is_empty());
            // A crew member's documents go to the crew's folder unless it names one.
            let folder = match (opt("folder"), &meta.crew) {
                (Some(f), _) => Some(f.to_string()),
                (None, Some(c)) => crew::docs_folder(vault, &c.id).ok(),
                (None, None) => None,
            };
            let tags: Vec<String> =
                p["tags"].as_array().map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect()).unwrap_or_default();
            let (title, content) = (s("title"), s("content"));
            let req = vault::DocWrite { title: &title, content: &content, folder: folder.as_deref(), path: opt("path"), tags: &tags };
            let doc = vault::write_doc(vault, req, session, &meta.origin)?;
            if let (Some(c), true) = (&meta.crew, doc.created) {
                crew::doc_saved(app, vault, &c.id, &c.role, &doc.rel, &doc.title)?;
            }
            let line = json!({"type": "marq_doc", "path": doc.rel, "title": doc.title, "created": doc.created});
            session::append(&session::raw_path(vault, session), &line)?;
            let _ = app.emit("session://event", json!({"session_id": session, "event": line}));
            let _ = app.emit("vault://changed", json!({"path": vault.join(&doc.rel)}));
            Ok(json!({"saved": doc.rel, "created": doc.created}))
        }
        "append_learning" => {
            session::append_learning(vault, session, &s("text"))?;
            Ok(json!("recorded"))
        }
        "list_notes" => Ok(json!(organize::outline(vault, p["folder"].as_str())?)),
        "create_folder" => Ok(json!({"created": organize::create_folder(vault, &s("path"))?})),
        "move_note" => {
            let r = organize::move_path(vault, &s("from"), &s("to"))?;
            crate::emit_moved(app, vault, &r);
            Ok(json!({"moved_to": r.to, "links_updated_in": r.relinked}))
        }
        "trash_note" => {
            let rel = s("path");
            if rel.split('/').next() == Some("sessions") || rel.split('/').any(|x| x.starts_with('.')) {
                return Err(Error::Other("only notes and folders outside sessions/ can be trashed".into()));
            }
            let full = vault::resolve(vault, &rel)?;
            vault::move_to_trash(&full)?;
            let _ = app.emit("vault://changed", json!({"path": full}));
            Ok(json!({"trashed": rel}))
        }
        "list_sessions" => {
            let runner = app.state::<Runner>();
            let list: Vec<Value> = session::list(vault, None)
                .into_iter()
                .filter(|x| x.meta.id != session)
                .take(30)
                .map(|x| {
                    let status = if runner.is_alive(&x.meta.id) && x.status != "running" { "idle".into() } else { x.status };
                    json!({"id": x.meta.id, "title": x.meta.title, "status": status, "cwd": x.meta.cwd,
                        "branch": x.meta.worktree.map(|w| w.branch), "started": x.meta.started, "from": x.meta.origin_path})
                })
                .collect();
            Ok(json!(list))
        }
        "search_sessions" => {
            let opt = |k: &str| p[k].as_str().filter(|v| !v.is_empty());
            let limit = p["limit"].as_u64().unwrap_or(10).clamp(1, 30) as usize;
            Ok(json!(search_sessions(vault, &s("text"), opt("project"), opt("since"), limit, session)))
        }
        "read_session" => {
            let id = s("session_id");
            let events = session::read_events(vault, &id)?;
            let meta = session::meta(vault, &id)?;
            let last = events.iter().rev().find(|e| e["type"] == "turn_end").and_then(|e| e["result"].as_str());
            Ok(json!({"id": id, "title": meta.title, "status": session::status_of(&events), "cwd": meta.cwd,
                "first_prompt": session::first_prompt(&events), "latest_result": last}))
        }
        "send_to_session" => {
            let reply = p["reply"].as_bool().unwrap_or(true);
            relay::send(app, vault, session, &s("session_id"), &s("text"), reply, relay::By::Session)?;
            Ok(json!(if reply {
                "Sent. Its answer will arrive as a new message when it finishes; do not wait or poll for it."
            } else {
                "Sent."
            }))
        }
        "start_crew" => {
            let meta = session::meta(vault, session)?;
            if meta.crew.is_some() {
                return Err(Error::Other("this session is already in a crew".into()));
            }
            // The crew works on the repository itself, not on this session's worktree.
            let project = meta.worktree.as_ref().map(|w| w.repo.clone()).unwrap_or(meta.cwd.clone());
            // Likewise the other directories: the repositories, with a worktree where this session had one.
            let dirs: Vec<workspace::DirSpec> = meta
                .dirs
                .iter()
                .map(|d| workspace::DirSpec { path: d.worktree.as_ref().map_or(d.source.clone(), |w| w.repo.clone()), worktree: d.worktree.is_some() })
                .collect();
            let c = crew::start(app, vault, &s("title"), &s("goal"), &project, &workspace::render_dirs(&dirs))?;
            let line = json!({"type": "marq_crew", "path": c.rel, "title": c.title});
            session::append(&session::raw_path(vault, session), &line)?;
            let _ = app.emit("session://event", json!({"session_id": session, "event": line}));
            let _ = app.emit("crew://started", json!({"rel": c.rel, "title": c.title}));
            Ok(json!({"crew": c.rel, "note": "The crew has started and its lead has the goal. Tell the user it is running in its own tab; you do not need to do the work yourself."}))
        }
        "crew_members" | "crew_send" | "crew_add_member" | "crew_set_model" | "crew_decide" | "task_list" | "task_add" | "task_update" => {
            let Some(c) = session::meta(vault, session)?.crew else {
                return Err(Error::Other("this session is not in a crew".into()));
            };
            match method {
                "crew_members" => return crew::members_for_tool(app, vault, &c),
                "crew_add_member" => {
                    let (role, instructions) = (s("role"), s("instructions"));
                    let m = crew::NewMember {
                        role: &role,
                        instructions: &instructions,
                        worktree: p["worktree"].as_bool().unwrap_or(true),
                        permission_mode: p["permission_mode"].as_str(),
                        model: p["model"].as_str(),
                    };
                    crew::add_member(app, vault, &c.id, &c.role, m)?;
                    return Ok(json!({"added": role, "note": "Its session starts when the first message reaches it."}));
                }
                "crew_set_model" => {
                    let role = p["role"].as_str().filter(|r| !r.is_empty()).unwrap_or(&c.role).to_string();
                    let model = crew::set_model(app, vault, &c.id, &c.role, &role, p["model"].as_str())?;
                    return Ok(json!({"role": role, "model": model.as_deref().unwrap_or("default"), "note": "It applies from that member's next turn."}));
                }
                "task_list" => return crew::task_list(vault, &c.id),
                "task_add" => {
                    let t = crew::task_add(app, vault, &c.id, &c.role, &s("title"), p["owner"].as_str(), p["note"].as_str())?;
                    return Ok(json!(t));
                }
                "task_update" => {
                    let change = crew::TaskChange { status: p["status"].as_str(), owner: p["owner"].as_str(), note: p["note"].as_str() };
                    return Ok(json!(crew::task_update(app, vault, &c.id, &c.role, &s("id"), change)?));
                }
                "crew_decide" => {
                    let sent = crew::decide(app, vault, &c.id, &c.role, &s("decision"))?;
                    return Ok(json!({"recorded": true, "told": sent.to, "held": sent.held}));
                }
                _ => {}
            }
            let (to, kind, text) = (s("to"), s("kind"), s("text"));
            let msg = crew::Outgoing { from: &c.role, to: &to, kind: &kind, text: &text, reply_to: p["reply_to"].as_str() };
            let sent = crew::send(app, vault, &c.id, msg)?;
            Ok(if sent.held {
                json!({"id": sent.id, "status": "held", "note": "The crew reached its hop limit, so the user will read this and decide whether to let it through. Finish your turn."})
            } else {
                json!({"id": sent.id, "status": "sent", "to": sent.to})
            })
        }
        _ => Err(Error::Other(format!("unknown method: {method}"))),
    }
}

/// Case-insensitive line search over the vault, at most 40 hits.
fn search(vault: &Path, text: &str) -> Vec<Value> {
    vault::grep(vault, text, true, 40, 5)
        .into_iter()
        .flat_map(|h| h.lines.into_iter().map(move |(line, text)| json!({"path": h.rel, "line": line, "text": text})))
        .take(40)
        .collect()
}

/// Past sessions whose note mentions every word of `text` (or a synonym), anywhere in it.
/// Best matches first, each with its three best lines. `project` is a part of the working directory
/// or repository, `since` a `YYYY-MM-DD` start date.
fn search_sessions(vault: &Path, text: &str, project: Option<&str>, since: Option<&str>, limit: usize, exclude: &str) -> Vec<Value> {
    let q = Query::parse(text, &Thesaurus::load(&vault::list_files(vault)));
    if q.words.is_empty() {
        return vec![];
    }
    let mut hits: Vec<(usize, Value)> = session::list(vault, None)
        .into_iter()
        .filter(|x| x.meta.id != exclude)
        .filter(|x| project.is_none_or(|p| x.meta.project().contains(p)))
        .filter(|x| since.is_none_or(|d| x.meta.started.as_str() >= d))
        .filter_map(|x| {
            let content = std::fs::read_to_string(&x.path).ok()?;
            if !q.matches_text(&content) {
                return None;
            }
            let mut lines: Vec<(usize, usize, &str)> = content
                .lines()
                .enumerate()
                .map(|(i, l)| (q.line_score(l), i + 1, l))
                .filter(|(score, ..)| *score > 0)
                .collect();
            let matching = lines.len();
            lines.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
            let top: Vec<Value> = lines
                .into_iter()
                .take(3)
                .map(|(_, n, l)| json!({"line": n, "text": l.trim().chars().take(240).collect::<String>()}))
                .collect();
            let rel = Path::new(&x.path).strip_prefix(vault).unwrap_or(Path::new(&x.path)).to_string_lossy().into_owned();
            Some((matching, json!({"id": x.meta.id, "title": x.meta.title, "status": x.status, "project": x.meta.project(),
                "started": x.meta.started, "note": rel, "matching_lines": matching, "matches": top})))
        })
        .collect();
    // list() is newest first and the sort is stable, so ties stay in that order.
    hits.sort_by(|a, b| b.0.cmp(&a.0));
    hits.into_iter().take(limit).map(|(_, v)| v).collect()
}

#[cfg(test)]
mod tests {
    /// Commands call `spawn` from the main thread, which has no tokio runtime of its own.
    #[test]
    fn spawns_a_process_outside_the_runtime() {
        std::thread::spawn(|| {
            let rt = tauri::async_runtime::handle();
            let _guard = rt.inner().enter();
            tokio::process::Command::new("true").spawn().unwrap();
        })
        .join()
        .unwrap();
    }

    #[test]
    fn finds_sessions_by_words_anywhere_in_the_note() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path();
        std::fs::create_dir_all(v.join("sessions/.raw")).unwrap();
        let meta = |id: &str, started: &str| {
            format!(r#"{{"type":"marq_meta","id":"{id}","title":"t {id}","origin":"","origin_path":"","cwd":"/work/app","started":"{started}"}}"#)
        };
        for (id, started, body) in [
            ("s-aaaaaaaa", "2026-10-01T10:00:00Z", "hover\n\nlater: the LSP crashed\n"),
            ("s-bbbbbbbb", "2026-10-20T10:00:00Z", "only hover here\n"),
        ] {
            std::fs::write(v.join(format!("sessions/.raw/{id}.jsonl")), meta(id, started) + "\n").unwrap();
            std::fs::write(v.join(format!("sessions/{}-{}.md", &started[..10], id.rsplit('-').next().unwrap())), body).unwrap();
        }
        let hits = super::search_sessions(v, "hover lsp", None, None, 10, "");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["id"], "s-aaaaaaaa");
        assert!(super::search_sessions(v, "hover", None, Some("2026-10-10"), 10, "").iter().all(|h| h["id"] == "s-bbbbbbbb"));
        assert!(super::search_sessions(v, "hover", Some("/elsewhere"), None, 10, "").is_empty());
        assert_eq!(super::search_sessions(v, "hover", None, None, 10, "s-aaaaaaaa").len(), 1);
    }

    #[test]
    fn cleans_model_titles() {
        assert_eq!(super::clean_title("\n「hover に型を表示」\n").as_deref(), Some("hover に型を表示"));
        assert_eq!(super::clean_title("# **Fix login**").as_deref(), Some("Fix login"));
        assert_eq!(super::clean_title("  "), None);
    }

    #[test]
    fn spawning_without_the_runtime_panics() {
        let r = std::thread::spawn(|| tokio::process::Command::new("true").spawn().map(|_| ())).join();
        assert!(r.is_err(), "tokio::process should panic outside a runtime");
    }
}
