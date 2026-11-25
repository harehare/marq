//! Talks to `sidecar/main.ts`, which runs sessions on agent backends (Claude through the Agent SDK).
//!
//! One Node process serves every session. Commands go to its stdin as JSON lines and events
//! come back on stdout. The sidecar keeps a session's process alive between turns, so follow-ups,
//! interrupts and approvals work while the agent is running.

use crate::vault::PathSlash;
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
use crate::environment::{self, Environment};
use crate::session::{self, SessionMeta};
use crate::error::{Error, Result};
use crate::thesaurus::{Query, Thesaurus};
use crate::{boards, comments, knowledge, links, memory, mq, organize, relay, vault, workflow, workspace};

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
    /// Sessions in a turn: from a prompt until its result.
    busy: Mutex<HashSet<String>>,
    /// Vault of each session seen in this app run, for writing its log.
    vaults: Mutex<HashMap<String, PathBuf>>,
    approvals: Mutex<HashMap<String, Approval>>,
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

/// How the sidecar is started.
enum Launch {
    /// The executable built by `sidecar/build.mjs`, next to the app's own. It needs no Node.
    Bundled(PathBuf),
    /// `sidecar/main.ts` run by `node`, when running from source (or `MARQ_SIDECAR`).
    Script(PathBuf),
}

fn launch() -> Launch {
    if let Some(script) = std::env::var_os("MARQ_SIDECAR") {
        return Launch::Script(script.into());
    }
    let name = if cfg!(windows) { "marq-sidecar.exe" } else { "marq-sidecar" };
    if let Some(bundled) = std::env::current_exe().ok().and_then(|e| Some(e.parent()?.join(name))).filter(|p| p.is_file()) {
        return Launch::Bundled(bundled);
    }
    Launch::Script(Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecar/main.ts"))
}

/// Asks for the suggested next steps that marq shows as buttons under the last message of a turn.
const NEXT_NOTE: &str = "\n\nWhen you finish a piece of work, or need the user to choose how to go on, end your last \
message with one code block whose info string is `next` and whose body is a one-line JSON array of 1 to 3 \
suggested next steps, most useful first: [{\"label\":\"...\",\"prompt\":\"...\",\"reason\":\"...\"}]. \
label is at most 30 characters, prompt is the full instruction you would receive if the user picked it (at most \
300 characters), reason is at most 80 characters. marq shows them as buttons and sends the prompt on a click. Put \
questions with a few answers there instead of asking in prose. Leave the block out when nothing sensible follows.";

const SYSTEM_APPEND: &str = "You are running inside marq, the user's Markdown knowledge base (the vault). \
The MCP server \"marq\" can search_notes, query_notes (mq queries) and read_note to look up the user's notes, \
earlier sessions and their learnings for background; search_sessions finds past sessions by what was said or done in them. \
search_notes also finds synonyms from the vault's glossary (glossary.md: preferred terms with aliases, broader and \
narrower terms) and notes' aliases, and tag:<name> narrows it to notes with that tag. Both searches take \
type:, status:, project:, workspace:, since: and before: in the text to narrow by frontmatter, with or without words. When you write documents or \
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
When you learn something worth keeping (a gotcha, a decision, a fact about the codebase), record it with append_learning. \
On a long task, or one you will come back to after a follow-up, keep short progress notes with set_progress (done, left, where you stopped); \
they are given back to you at every later run, even after the conversation is compacted.\n\n\
When the user asks you to organize their notes, use list_notes to see the vault, create_folder for new folders, \
and move_note to move or rename notes and folders; it keeps relative links between notes working. \
Leave sessions/ alone, since Marq manages it.";

/// Ports each session gets, as `MARQ_PORT_1`…, and the range they are taken from. The range sits below
/// the OS's ephemeral ports, so a port picked here is not handed out to an outgoing connection.
const SESSION_PORTS: u16 = 4;
const PORT_RANGE: (u16, u16) = (20000, 10000);

/// The environment that tells sessions apart, so that tasks running at the same time (a comparison,
/// queued requests) can each start their own dev server or database without colliding. It is derived from the
/// session's id alone, so a resumed session gets the same values and finds its own server again.
///
/// - `MARQ_SESSION_ID`: the session's short id, for naming databases, containers or temp directories.
/// - `MARQ_PORT_1`…`MARQ_PORT_4`: ports reserved for this session. Two sessions can still draw the
///   same block (rarely), and a port can be taken by another program: the agent is told to check.
pub(crate) fn session_env(id: &str, env: Option<&Environment>) -> Value {
    let short = &id[id.len().saturating_sub(8)..];
    // FNV-1a: stable across runs and Rust versions, unlike the std hasher.
    let hash = id.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    let blocks = u64::from(PORT_RANGE.1 / SESSION_PORTS);
    let base = u64::from(PORT_RANGE.0) + hash % blocks * u64::from(SESSION_PORTS);
    let mut out = serde_json::Map::new();
    out.insert("MARQ_SESSION_ID".into(), json!(short));
    for i in 0..u64::from(SESSION_PORTS) {
        out.insert(format!("MARQ_PORT_{}", i + 1), json!((base + i).to_string()));
    }
    if let Some(e) = env {
        // The environment note names ports in order, and sets variables only when it is the user's own.
        for (i, name) in e.ports.iter().enumerate() {
            out.insert(format!("MARQ_PORT_{name}"), json!((base + i as u64).to_string()));
        }
        if e.trusted {
            for (k, v) in e.vars.iter().chain(e.resources.iter().flat_map(|r| &r.env)) {
                out.insert(k.clone(), json!(environment::expand(v, short)));
            }
        }
    }
    Value::Object(out)
}

/// What the agent is told about [`session_env`].
const ENV_NOTE: &str = "\n\nThis session shares the machine with other sessions that may run at the same time. \
Do not use fixed ports such as 3000 or 8080 for dev servers, previews or test databases: use the ports reserved \
for you in $MARQ_PORT_1 to $MARQ_PORT_4 (for example `PORT=$MARQ_PORT_1 npm run dev`), and put $MARQ_SESSION_ID in \
the names of databases, containers and temp directories you create. If a reserved port is already in use, \
take another free one rather than stopping the process that holds it, which may belong to another session. \
A command that was cut off before it reported its result (a migration, a deploy) may have run: check before you repeat it.";

/// Makes the resources the project's environment note lists for the session, if it is trusted, and sets up its worktree.
fn provision_resources(app: &AppHandle, vault: &Path, meta: &SessionMeta) -> Result<()> {
    let Some(env) = environment::load(vault, meta.project()) else { return Ok(()) };
    let progress = |s: &str| {
        let _ = app.emit("task://progress", s);
    };
    let (cwd, vars) = (vault::expand_home(&meta.cwd), session_env(&meta.id, Some(&env)));
    crate::resources::provision(vault, &meta.id, &cwd, &env, &vars, &progress)?;
    // Then the worktree itself: the files git does not carry, and the project's setup commands.
    crate::setup::prepare(vault, &vault::expand_home(meta.project()), &cwd, &env, &vars, &progress)
}

/// Drops what was made for the session. Returns what could not be dropped.
pub fn release_resources(app: &AppHandle, vault: &Path, id: &str) -> Vec<String> {
    if crate::resources::ledger(vault, id).is_empty() {
        return vec![];
    }
    let env = session::meta(vault, id).ok().and_then(|m| environment::load(vault, m.project()));
    let progress = |s: &str| {
        let _ = app.emit("task://progress", s);
    };
    crate::resources::release(vault, id, &session_env(id, env.as_ref()), &progress)
}

/// What the agent is told about how the user files work: the tags and keys in use, and what this
/// session is filed under, so it can file itself with `set_tags` using the same words.
fn filing_prompt(vault: &Path, meta: &SessionMeta) -> String {
    let keys = crate::config::organize_keys();
    let files = vault::list_files(vault);
    // The values in use, most used first, so the agent reuses them instead of coining new ones.
    let in_use = |values: Vec<&String>| {
        let mut count: std::collections::HashMap<&String, usize> = Default::default();
        for v in values {
            *count.entry(v).or_default() += 1;
        }
        let mut by: Vec<(&String, usize)> = count.into_iter().collect();
        by.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        by.into_iter().take(20).map(|(v, _)| v.as_str()).collect::<Vec<_>>().join(", ")
    };
    let mut lines = vec![format!("- tags: {}", in_use(files.iter().flat_map(|f| &f.tags).collect()))];
    for k in &keys {
        lines.push(format!("- {k}: {}", in_use(files.iter().flat_map(|f| f.fields.get(k).into_iter().flatten()).collect())));
    }
    let mut mine = meta.clone();
    session::inherit(vault, &mut mine);
    let filed = match mine.fields.iter().map(|(k, vs)| format!("{k}: {}", vs.join(", "))).collect::<Vec<_>>() {
        f if f.is_empty() => "nothing yet".to_string(),
        f => f.join("; "),
    };
    format!(
        "\n\nThe user finds sessions and notes by what they are filed under. In use in this vault:\n{}\n\
This session is filed under: {filed}. When the work clearly belongs under a tag or value it does not have yet, \
file it with set_tags (it files the request too), reusing the words above rather than new ones. \
tag_note files another note the same way; the user approves that.",
        lines.join("\n")
    )
}

/// The sidecar command that starts a session's process.
fn start_cmd(vault: &Path, meta: &SessionMeta, prompt: &str, resume: bool) -> Value {
    let mut system = SYSTEM_APPEND.to_string();
    system.push_str(NEXT_NOTE);
    system.push_str(&memory::system_prompt(vault, &meta.id));
    system.push_str(&knowledge::for_project(vault, meta.project()));
    system.push_str(&workspace::system_prompt(&meta.dirs, None));
    system.push_str(&filing_prompt(vault, meta));
    system.push_str(ENV_NOTE);
    let environment = environment::load(vault, meta.project());
    if let Some(e) = &environment {
        system.push_str(&environment::system_prompt(e, &meta.id[meta.id.len().saturating_sub(8)..]));
    }
    let dirs: Vec<String> = meta.dirs.iter().map(|d| d.path.clone()).collect();
    let (executable, args) = agents::command(meta.agent.as_deref());
    json!({
        "op": "start",
        "id": meta.id,
        "cwd": vault::expand_home(&meta.cwd),
        "prompt": prompt,
        "resume": resume,
        "permissionMode": meta.permission_mode,
        "model": meta.model,
        "effort": meta.effort,
        "agent": meta.agent,
        "executable": executable,
        "args": args,
        "agentSession": if resume { agent_session(vault, &meta.id) } else { None },
        "system": system,
        "additionalDirectories": dirs,
        "sandbox": meta.sandbox,
        "env": session_env(&meta.id, environment.as_ref()),
        "rules": environment.as_ref().map(|e| json!({"ask": e.ask, "deny": e.deny})),
    })
}

/// Resolves the default agent and `node` and starts the sidecar ahead of the first session.
pub fn prewarm(app: &AppHandle) {
    executable(None);
    if matches!(launch(), Launch::Script(_)) {
        which("node");
    }
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
        let user = json!({"type": "marq_user", "text": prompt, "timestamp": vault::now()});
        session::append(&raw, &user)?;
        session::rerender(&vault, &id)?;
        // Open views show the message at once, whoever sent it (the session's own box, Send to session, a schedule).
        let _ = app.emit("session://event", json!({"session_id": id, "event": user}));
        self.vaults.lock().unwrap().insert(id.clone(), vault.clone());
        // The session is running again: the session list moves it to Active.
        let _ = app.emit("sessions://changed", &id);

        // The log keeps the prompt as typed; the agent also gets the notes its [[links]] name.
        let prompt = crate::refs::attach(&vault, &prompt);
        let cmd = if was_alive {
            // The model, mode and effort can change between turns.
            json!({"op": "send", "id": id, "text": prompt, "model": meta.model, "permissionMode": meta.permission_mode, "effort": meta.effort})
        } else {
            // What a worktree cannot isolate (a database) is made first. A failure ends the session with its
            // reason; resuming it tries again.
            if let Err(e) = provision_resources(&app, &vault, &meta) {
                finish(&app, &id, "error", Some(&e.to_string()));
                return Err(e);
            }
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

    /// `answers` carries the user's choices for AskUserQuestion (question text -> label(s)).
    pub fn answer(
        &self,
        app: &AppHandle,
        request_id: &str,
        allow: bool,
        always: bool,
        message: Option<String>,
        answers: Option<serde_json::Map<String, Value>>,
    ) -> Result<()> {
        let Some(a) = self.approvals.lock().unwrap().remove(request_id) else {
            return Err(Error::Other("this request was already answered".into()));
        };
        if let Some(v) = self.vaults.lock().unwrap().get(&a.session_id) {
            let line = json!({"type": "marq_approval", "tool": a.tool_name, "input": a.input, "allow": allow, "always": always, "answers": answers});
            let _ = session::append(&session::raw_path(v, &a.session_id), &line);
        }
        let _ = app.emit("session://approval", json!({"session_id": a.session_id, "request_id": request_id, "answered": true}));
        self.send(app, json!({"op": "approval", "requestId": request_id, "allow": allow, "always": always, "message": message, "answers": answers}))
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

    /// The models `agent` (None: Claude) offers, as the sidecar lists them: value, label, efforts.
    pub async fn agent_models(&self, app: &AppHandle, agent: Option<&str>) -> Result<Value> {
        let (executable, args) = agents::command(agent);
        let req_id = vault::new_id();
        let (tx, rx) = oneshot::channel();
        self.replies.lock().unwrap().insert(req_id.clone(), tx);
        self.send(app, json!({"op": "models", "reqId": req_id, "agent": agent, "executable": executable, "args": args}))?;
        let reply = tokio::time::timeout(std::time::Duration::from_secs(20), rx).await;
        self.replies.lock().unwrap().remove(&req_id);
        reply
            .map_err(|_| Error::Other("the agent did not list its models".into()))?
            .map_err(|_| Error::Other("the sidecar exited".into()))?
            .map_err(Error::Other)
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

fn spawn(app: AppHandle) -> Result<mpsc::UnboundedSender<String>> {
    // Sync commands run on the main thread, outside the tokio runtime that tokio::process needs.
    let rt = tauri::async_runtime::handle();
    let _guard = rt.inner().enter();
    let launch = launch();
    // The sidecar and every agent process under it get the shell's PATH, so the agent's Bash tool
    // finds the same commands as in a terminal.
    let (mut cmd, program) = match &launch {
        Launch::Bundled(exe) => (tokio::process::Command::new(exe), exe.clone()),
        Launch::Script(script) => {
            let mut c = tokio::process::Command::new(which("node"));
            c.arg(script).current_dir(script.parent().unwrap());
            (c, script.clone())
        }
    };
    if let Some(url) = crate::config::ollama_url() {
        cmd.env("OLLAMA_HOST", url);
    }
    // The plugin of skills ships in the app's resources; from source the sidecar finds its own folder.
    if let Some(plugin) = app.path().resource_dir().ok().map(|d| d.join("plugin")).filter(|p| p.is_dir()) {
        cmd.env("MARQ_PLUGIN", plugin);
    }
    let mut child = cmd
        .env("PATH", crate::shell::path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Error::Other(format!("failed to start the sidecar ({}): {e}", program.display())))?;
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
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    // Replies other sessions are waiting for are delivered now.
                    if let Err(e) = relay::on_turn_end(&app, &v, &id) {
                        eprintln!("marq: reply failed: {e}");
                    }
                    // Checks the work, moves a phased request on, and settles the session.
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
        "read_board" => Ok(json!(boards::filtered(boards::read(&boards::find(vault, &s("board"))?)?, &boards::Filter::from_params(p)))),
        "search_cards" => Ok(json!(boards::search(vault, &boards::Filter::from_params(p)))),
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
            Ok(json!({"board": board.strip_prefix(vault).unwrap_or(&board).to_slash(), "cards_added": added}))
        }
        "create_board" => {
            let lists: Vec<String> = p["lists"].as_array().map(|l| l.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            let path = boards::create(vault, &s("name"), &lists)?;
            changed(app, &path);
            Ok(json!({"created": path.strip_prefix(vault).unwrap_or(&path).to_slash(), "lists": boards::read(&path)?.lists.iter().map(|l| l.name.clone()).collect::<Vec<_>>()}))
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
        "list_comments" => {
            let only = match p["note"].as_str().filter(|n| !n.is_empty()) {
                Some(n) => Some(find_any(vault, n)?),
                None => None,
            };
            let status = p["status"].as_str().unwrap_or("open");
            Ok(json!(comments::list(vault, only.as_deref(), status, p["mention"].as_bool().unwrap_or(false))))
        }
        "note_links" => {
            let note = s("note");
            let path = find_any(vault, &note)?;
            let rel = path.strip_prefix(vault).unwrap_or(&path).to_slash();
            let b = links::backlinks(&vault::list_files(vault), &rel);
            Ok(json!({"note": rel, "links_here": b.linked, "mentions": b.mentions, "links_to": b.outgoing, "missing": b.missing}))
        }
        "write_doc" => {
            let meta = session::meta(vault, session)?;
            let opt = |k: &str| p[k].as_str().filter(|v| !v.is_empty());
            let folder = opt("folder").map(str::to_string);
            let tags: Vec<String> =
                p["tags"].as_array().map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect()).unwrap_or_default();
            let (title, content) = (s("title"), s("content"));
            let req = vault::DocWrite { title: &title, content: &content, folder: folder.as_deref(), path: opt("path"), tags: &tags };
            let doc = vault::write_doc(vault, req, session, &meta.origin)?;
            let line = json!({"type": "marq_doc", "path": doc.rel, "title": doc.title, "created": doc.created});
            session::append(&session::raw_path(vault, session), &line)?;
            let _ = app.emit("session://event", json!({"session_id": session, "event": line}));
            let _ = app.emit("vault://changed", json!({"path": vault.join(&doc.rel)}));
            Ok(json!({"saved": doc.rel, "created": doc.created}))
        }
        "set_progress" => {
            memory::set_progress(vault, session, &s("text"))?;
            Ok(json!("Saved. You get these notes back at the start of every later run of this session."))
        }
        "set_followup" => {
            let t = crate::timers::add(vault, session, &s("after"), &s("note"), chrono::Local::now())?;
            Ok(json!({"id": t.id, "due": t.due, "note": "You will be resumed with your note when it is due. Do not wait or poll; end your turn."}))
        }
        "list_followups" => Ok(json!(crate::timers::waiting(vault, session))),
        "cancel_followup" => Ok(json!({"cancelled": crate::timers::cancel(vault, session, &s("id"))?})),
        "append_learning" => {
            session::append_learning(vault, session, &s("text"))?;
            Ok(json!("recorded"))
        }
        "set_tags" | "tag_note" => {
            let list = |v: &Value| -> Vec<String> {
                match v {
                    Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
                    Value::String(s) => s.split(',').map(str::to_string).collect(),
                    _ => vec![],
                }
            };
            let change = vault::Refile {
                add_tags: list(&p["tags"]),
                remove_tags: list(&p["remove"]),
                fields: p["fields"].as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), list(v))).collect()).unwrap_or_default(),
            };
            let keys = crate::config::organize_keys();
            let mut all = vec!["tags".to_string()];
            all.extend(keys.clone());
            // Writes the changed keys into a note and says so.
            let write = |path: &Path, changed: &std::collections::BTreeMap<String, Vec<String>>| -> Result<()> {
                std::fs::write(path, vault::apply_fields(&std::fs::read_to_string(path)?, changed))?;
                let _ = app.emit("vault://changed", json!({"path": path}));
                Ok(())
            };
            if method == "tag_note" {
                let name = s("note");
                let path = vault::find_note(vault, &name).ok_or_else(|| Error::Other(format!("no note \"{name}\"")))?;
                let rel = path.strip_prefix(vault).unwrap_or(&path).to_slash();
                if rel.starts_with("sessions/") {
                    return Err(Error::Other("session notes are filed with set_tags, from their own session".into()));
                }
                let current = vault::fields_of(&std::fs::read_to_string(&path)?, &all);
                let changed = vault::refile(&current, &change, &keys)?;
                write(&path, &changed)?;
                let mut now = current;
                now.extend(changed);
                now.retain(|_, v| !v.is_empty());
                return Ok(json!({"note": rel, "filed_under": now}));
            }
            let mut meta = session::meta(vault, session)?;
            session::inherit(vault, &mut meta);
            let changed = vault::refile(&meta.fields, &change, &keys)?;
            session::set_fields(vault, session, &changed)?;
            // Its request is filed the same way, so the two are found together.
            let request = session::find_origin(vault, &meta)
                .filter(|path| std::fs::read_to_string(path).is_ok_and(|t| vault::fm_get(&t, "id").as_deref() == Some(meta.origin.as_str())));
            if let Some(path) = &request {
                write(path, &changed)?;
            }
            let _ = app.emit("sessions://changed", session);
            let mut now = meta.fields;
            now.extend(changed);
            now.retain(|_, v| !v.is_empty());
            Ok(json!({"filed_under": now, "request": request.map(|p| p.strip_prefix(vault).unwrap_or(&p).to_slash())}))
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
        "related_sessions" => {
            let runner = app.state::<Runner>();
            let all = session::list(vault, None);
            let Some(me) = all.iter().find(|x| x.meta.id == session) else { return Ok(json!([])) };
            let active = |x: &session::SessionInfo| x.status == "running" || runner.is_alive(&x.meta.id);
            Ok(json!(session::related(me, &all, active)))
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
    search_sessions_for(vault, &q, project, since, limit, exclude)
}

/// [`search_sessions`] for a parsed query, so a caller can also show how its words were expanded.
/// The query's own `status:`, `project:`, `workspace:`, `since:` and `before:` narrow it too, and
/// with no words at all they list the sessions that pass, newest first.
pub fn search_sessions_for(vault: &Path, q: &Query, project: Option<&str>, since: Option<&str>, limit: usize, exclude: &str) -> Vec<Value> {
    let fl = &q.filters;
    if q.is_empty() {
        return vec![];
    }
    let files = if fl.workspaces.is_empty() { vec![] } else { vault::list_files(vault) };
    let mut hits: Vec<(usize, Value)> = session::list(vault, None)
        .into_iter()
        .filter(|x| x.meta.id != exclude)
        .filter(|x| project.is_none_or(|p| x.meta.project().contains(p)))
        .filter(|x| since.is_none_or(|d| x.meta.started.as_str() >= d))
        .filter(|x| fl.matches_status(Some(&x.status)) && fl.matches_project(Some(x.meta.project())) && fl.matches_date(&x.meta.started))
        .filter(|x| fl.matches_fields(&x.meta.fields) && q.matches_tags(x.meta.fields.get("tags").map_or(&[], Vec::as_slice)))
        .filter(|x| fl.workspaces.is_empty() || fl.matches_workspace(&vault::workspace_names(&files, x.meta.workspace.as_deref(), None)))
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
            let rel = Path::new(&x.path).strip_prefix(vault).unwrap_or(Path::new(&x.path)).to_slash();
            Some((matching, json!({"id": x.meta.id, "title": x.meta.title, "status": x.status, "project": x.meta.project(),
                "started": x.meta.started, "note": rel, "matching_lines": matching, "matches": top})))
        })
        .collect();
    // list() is newest first and the sort is stable, so ties stay in that order.
    hits.sort_by_key(|a| std::cmp::Reverse(a.0));
    hits.into_iter().take(limit).map(|(_, v)| v).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_gets_the_same_ports_every_time() {
        let a = session_env("0192f1c2-aaaa-7000-8000-123456789abc", None);
        assert_eq!(a, session_env("0192f1c2-aaaa-7000-8000-123456789abc", None));
        assert_eq!(a["MARQ_SESSION_ID"], "56789abc");
        let ports: Vec<u16> = (1..=4).map(|i| a[format!("MARQ_PORT_{i}")].as_str().unwrap().parse().unwrap()).collect();
        assert!(ports.windows(2).all(|w| w[1] == w[0] + 1));
        assert!(ports[0] >= 20000 && ports[3] < 30000);
    }

    #[test]
    fn an_environment_names_ports_and_a_repository_cannot_set_variables() {
        let id = "0192f1c2-aaaa-7000-8000-123456789abc";
        let note = "---\nports: [web, api]\nvars:\n  DATABASE_URL: db_{id}\n  PATH: /evil\n---\n";
        let mine = session_env(id, Some(&environment::parse(note, "n.md", true)));
        assert_eq!(mine["MARQ_PORT_WEB"], mine["MARQ_PORT_1"]);
        assert_eq!(mine["MARQ_PORT_API"], mine["MARQ_PORT_2"]);
        assert_eq!(mine["DATABASE_URL"], "db_56789abc");
        let theirs = session_env(id, Some(&environment::parse(note, "n.md", false)));
        assert_eq!(theirs["MARQ_PORT_WEB"], mine["MARQ_PORT_WEB"]);
        assert!(theirs.get("DATABASE_URL").is_none() && theirs.get("PATH").is_none());
    }

    #[test]
    fn sessions_mostly_get_different_ports() {
        let first = |id: &str| session_env(id, None)["MARQ_PORT_1"].as_str().unwrap().to_string();
        assert_ne!(first("0192f1c2-aaaa-7000-8000-123456789abc"), first("0192f1c2-bbbb-7000-8000-fedcba987654"));
    }

    #[test]
    fn a_trusted_resource_sets_its_variables_and_an_untrusted_one_does_not() {
        let id = "0192f1c2-aaaa-7000-8000-123456789abc";
        let note = "---\nresources:\n  db:\n    create: make {id}\n    drop: rm {id}\n    env:\n      DATABASE_URL: pg://app_{id}\n---\n";
        assert_eq!(session_env(id, Some(&environment::parse(note, "n", true)))["DATABASE_URL"], "pg://app_56789abc");
        assert!(session_env(id, Some(&environment::parse(note, "n", false))).get("DATABASE_URL").is_none());
    }

    #[test]
    fn every_session_gets_four_consecutive_aligned_ports_in_range() {
        for i in 0..2000u32 {
            let id = format!("0192f1c2-{i:04x}-7000-8000-{:012x}", u64::from(i) * 7919);
            let a = session_env(&id, None);
            let ports: Vec<u32> = (1..=4).map(|n| a[format!("MARQ_PORT_{n}")].as_str().unwrap().parse().unwrap()).collect();
            assert!(ports[0] >= 20000 && ports[3] < 30000, "{ports:?}");
            assert!(ports.windows(2).all(|w| w[1] == w[0] + 1));
            assert_eq!(ports[0] % 4, 0);
        }
    }

    #[test]
    fn named_ports_follow_the_order_and_stay_within_the_reserved_four() {
        let id = "0192f1c2-aaaa-7000-8000-123456789abc";
        let e = environment::parse("---\nports: [a, b, c, d, e]\n---\n", "n", false);
        let a = session_env(id, Some(&e));
        for (n, name) in ["A", "B", "C", "D"].iter().enumerate() {
            assert_eq!(a[format!("MARQ_PORT_{name}")], a[format!("MARQ_PORT_{}", n + 1)]);
        }
        assert!(a.get("MARQ_PORT_E").is_none());
    }

    #[test]
    fn a_users_own_note_may_set_any_variable() {
        let id = "0192f1c2-aaaa-7000-8000-123456789abc";
        let plain = session_env(id, None);
        // A vault note is the user's own, so nothing stops it; this pins that.
        let e = environment::parse("---\nvars:\n  MARQ_SESSION_ID: mine\n---\n", "n", true);
        assert_eq!(session_env(id, Some(&e))["MARQ_SESSION_ID"], "mine");
        assert_eq!(plain["MARQ_SESSION_ID"], "56789abc");
    }
    /// Commands call `spawn` from the main thread, which has no tokio runtime of its own.
    #[test]
    #[cfg(unix)] // runs `true`
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
        // Filters in the query narrow it, and work without words: newest first.
        assert_eq!(super::search_sessions(v, "hover before:2026-10-10", None, None, 10, "")[0]["id"], "s-aaaaaaaa");
        assert!(super::search_sessions(v, "hover project:elsewhere", None, None, 10, "").is_empty());
        let all = super::search_sessions(v, "project:/work", None, None, 10, "");
        assert_eq!((all.len(), &all[0]["id"]), (2, &json!("s-bbbbbbbb")));
        assert!(super::search_sessions(v, "workspace:docs", None, None, 10, "").is_empty());
    }

    #[test]
    fn cleans_model_titles() {
        assert_eq!(super::clean_title("\n「hover に型を表示」\n").as_deref(), Some("hover に型を表示"));
        assert_eq!(super::clean_title("# **Fix login**").as_deref(), Some("Fix login"));
        assert_eq!(super::clean_title("  "), None);
    }

    #[test]
    #[cfg(unix)] // runs `true`
    fn spawning_without_the_runtime_panics() {
        let r = std::thread::spawn(|| tokio::process::Command::new("true").spawn().map(|_| ())).join();
        assert!(r.is_err(), "tokio::process should panic outside a runtime");
    }
}
