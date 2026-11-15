mod agents;
mod automation;
mod boards;
mod commands;
mod config;
mod crew;
mod error;
mod git;
mod inbox;
mod knowledge;
mod links;
mod memory;
mod mq;
mod navigation;
mod organize;
mod refs;
mod relay;
mod scratch;
mod session;
mod shell;
mod tasks;
mod terminal;
mod timers;
mod thesaurus;
mod sidecar;
mod vault;
mod workflow;
mod workspace;

use crate::vault::PathSlash;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, HELP_SUBMENU_ID};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

use session::{SessionInfo, SessionMeta};
use sidecar::{Approval, Runner, Turn};
use error::Result;

/// Runs `f` on a blocking thread. Sync commands run on the main thread and freeze the UI,
/// so anything that touches git, spawns processes or scans the vault goes through here.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| error::Error::Other(format!("background task failed: {e}")))?
}

/// Tells the new-task dialog what is happening while a session starts.
fn progress(app: &AppHandle, stage: &str) {
    let _ = app.emit("task://progress", stage);
}

#[tauri::command]
async fn list_files(vault: String) -> Result<Vec<vault::FileEntry>> {
    blocking(move || Ok(vault::list_files(Path::new(&vault)))).await
}

#[tauri::command]
fn read_note(vault: String, path: String) -> Result<String> {
    Ok(std::fs::read_to_string(vault::resolve(Path::new(&vault), &path)?)?)
}

#[tauri::command]
fn write_note(vault: String, path: String, content: String) -> Result<()> {
    let p = vault::resolve(Path::new(&vault), &path)?;
    Ok(std::fs::write(p, content)?)
}

#[tauri::command]
fn create_note(vault: String, rel: String, kind: String) -> Result<String> {
    let v = Path::new(&vault);
    let p = v.join(&rel);
    if p.exists() {
        return Err(error::Error::Other(format!("already exists: {rel}")));
    }
    std::fs::create_dir_all(p.parent().unwrap())?;
    let p = vault::resolve(v, &rel)?;
    let title = p.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let now = vault::now();
    if kind == "crew" {
        std::fs::write(&p, crew::template(&vault::new_id(), &title, &now, "", "", ""))?;
        return Ok(p.to_string_lossy().into_owned());
    }
    let mut fm = format!("---\nid: {}\ntype: {kind}\ntitle: {title}\ncreated: {now}\nupdated: {now}\n", vault::new_id());
    if kind == "request" {
        fm.push_str("status: todo\nproject: \nsessions: []\n");
    }
    let body = if kind == "request" { "## Request\n\n" } else { "" };
    std::fs::write(&p, format!("{fm}---\n# {title}\n\n{body}"))?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
fn pin_mq_output(vault: String, path: String, line: usize, output: String) -> Result<String> {
    let p = vault::resolve(Path::new(&vault), &path)?;
    let text = std::fs::read_to_string(&p)?;
    let text = vault::pin_output(&text, line, &output).ok_or_else(|| error::Error::Other("no code block at that line".into()))?;
    std::fs::write(&p, &text)?;
    Ok(text)
}

#[tauri::command]
fn note_anchors(content: String) -> Vec<vault::Anchor> {
    vault::anchors(&content)
}

#[tauri::command]
async fn mq_eval(
    vault: String,
    query: String,
    content: Option<String>,
    glob: Option<String>,
    base: Option<String>,
    aggregate: bool,
) -> Result<Vec<mq::FileResult>> {
    blocking(move || {
        mq::eval(
            Path::new(&vault),
            &query,
            content.as_deref(),
            glob.as_deref(),
            base.as_deref().map(Path::new),
            aggregate,
        )
    })
    .await
}

#[derive(Serialize)]
struct Started {
    session_id: String,
    title: String,
    /// The note after marq added its id, anchor or status.
    content: String,
}

/// Choices from the Ask dialog; project, worktree and model override the note's frontmatter for this run.
#[derive(Debug, Default, serde::Deserialize)]
pub struct RunOptions {
    project: Option<String>,
    worktree: Option<bool>,
    model: Option<String>,
    effort: Option<String>,
    /// The agent to run on instead of the note's `agent:` (None keeps the note's).
    agent: Option<String>,
    /// do (default), review, plan or explain.
    intent: Option<String>,
    /// What the user wants, in their words.
    instruction: Option<String>,
    /// Selected lines to ask about instead of the whole section.
    excerpt: Option<Excerpt>,
    /// Work in this worktree instead of creating one: a retry or the next phase of a request.
    #[serde(skip)]
    reuse: Option<git::Worktree>,
    /// The check to run, carried over from the session this one retries.
    #[serde(skip)]
    verify: Option<workflow::Verify>,
    /// What went wrong in the previous attempt, for a retry in a fresh session.
    #[serde(skip)]
    previous: Option<String>,
    /// The other directories of the session this one carries on, reused as they are.
    #[serde(skip)]
    reuse_dirs: Option<Vec<workspace::ExtraDir>>,
}

#[derive(Debug, serde::Deserialize)]
pub struct Excerpt {
    text: String,
    from: usize,
    to: usize,
}

/// The intent and instruction, appended to the prompt.
fn ask_suffix(intent: Option<&str>, instruction: Option<&str>) -> String {
    let what = match intent {
        Some("review") => "Review this: point out problems, risks, unclear parts and missing pieces, with concrete suggestions. Do not change any files.",
        Some("plan") => "Make a step-by-step plan for this. Do not change any files yet.",
        Some("explain") => "Investigate and explain this. Answer here; do not change any files.",
        _ => "",
    };
    let mut out = String::new();
    if !what.is_empty() {
        out.push_str(&format!("\n\n{what}"));
    }
    if let Some(i) = instruction.map(str::trim).filter(|i| !i.is_empty()) {
        out.push_str(&format!("\n\nMy request: {i}"));
    }
    out
}

/// Starts a session from the note at `path`: the whole body for a request, otherwise the section at `line`.
fn start_from_note(app: AppHandle, vault: &str, path: &str, line: usize, opts: RunOptions) -> Result<Started> {
    let runner = app.state::<Runner>();
    let v = PathBuf::from(vault);
    let p = vault::resolve(&v, path)?;
    let text = std::fs::read_to_string(&p)?;
    let rel = p.strip_prefix(&v).unwrap_or(&p).to_string_lossy().into_owned();
    let session_id = vault::new_id();
    // `workspace:` gives the project when the note has none, and the other directories.
    let ws = workspace::resolve(&v, &text)?;
    let project = opts.project.or(ws.project).filter(|s| !s.is_empty());
    let permission_mode = match opts.intent.as_deref() {
        Some("plan") => Some("plan".to_string()),
        _ => vault::fm_get(&text, "permission_mode").filter(|s| !s.is_empty()),
    };
    let model = opts.model.or_else(|| vault::fm_get(&text, "model")).filter(|s| !s.is_empty());
    let effort = opts.effort.or_else(|| vault::fm_get(&text, "effort")).filter(|s| !s.is_empty());
    let agent = opts.agent.or_else(|| vault::fm_get(&text, "agent")).filter(|s| !s.is_empty() && s != agents::DEFAULT);
    let use_worktree = opts.worktree.unwrap_or_else(|| vault::fm_get(&text, "worktree").as_deref() != Some("false"));
    let is_request = vault::fm_get(&text, "type").as_deref() == Some("request");
    // A request in phases runs each phase in a new session, on the worktree of the one before.
    let phase = if is_request { workflow::current_phase(&text) } else { None };
    let first_phase = phase.is_none() || workflow::phases_of(&text).first() == phase.as_ref();
    let last = (!first_phase).then(|| workflow::last_run(&v, &text)).flatten();
    let reuse = opts.reuse.clone().or_else(|| last.as_ref().filter(|_| use_worktree).and_then(|m| m.worktree.clone()));
    let reuse_dirs = opts.reuse_dirs.clone().or_else(|| last.map(|m| m.dirs));

    // A project that is a git repo gets its own worktree, unless the note says `worktree: false`.
    let worktree = match &project {
        _ if reuse.is_some() => reuse,
        Some(proj) if use_worktree => match git::repo_root(&vault::expand_home(proj)) {
            Some(repo) => {
                let carry = vault::fm_get(&text, "carry_changes").as_deref() == Some("true");
                let wanted = vault::fm_get(&text, "branch");
                let branch = git::branch_name(&repo, wanted.as_deref(), &session_id)?;
                let base = git::Base::parse(vault::fm_get(&text, "base").as_deref());
                if base != git::Base::Head {
                    progress(&app, "Fetching the latest base branch…");
                    if !git::fetch_origin(&repo) {
                        progress(&app, "Could not fetch; starting from the local branch…");
                    }
                }
                progress(&app, if carry { "Creating a worktree with your changes…" } else { "Creating a worktree…" });
                Some(git::create(&repo, &session_id, &branch, carry, &base)?)
            }
            None => None,
        },
        _ => None,
    };

    // Taken now, so the session cannot change its own check by editing the note.
    let verify = match &phase {
        Some(ph) if !workflow::is_last_phase(&text, ph) => None,
        _ if is_request => opts.verify.clone().or_else(|| workflow::verify_of(&text)),
        _ => None,
    };
    let sandbox = workflow::sandbox_of(&text);

    let (origin, title, prompt, text) = if is_request {
        let (id, t) = vault::ensure_id(&text);
        let t = vault::fm_set(&t, "status", "running");
        let t = vault::fm_push(&t, "sessions", &session_id);
        let title = vault::fm_get(&t, "title").unwrap_or_else(|| rel.clone());
        let body = vault::split_frontmatter(&t).1;
        // The result block is marq's own output, so it is not sent back as instructions; the acceptance
        // criteria are for the check, not for the agent doing the work.
        let body = workflow::without_sections(body.split("\n## Result").next().unwrap_or(body), &["Acceptance"]);
        let phase_part = phase.as_deref().map(|ph| workflow::phase_prompt(&v, &p, &t, ph)).unwrap_or_default();
        let previous = opts.previous.as_deref().map(|m| format!("\n\n<previous_attempt>\n{m}\n</previous_attempt>")).unwrap_or_default();
        let prompt = format!(
            "{body}{}{phase_part}{previous}{}",
            render_context(&v, &t),
            ask_suffix(opts.intent.as_deref(), opts.instruction.as_deref())
        );
        let title = match &phase {
            Some(ph) => format!("{title} · {ph}"),
            None => title,
        };
        (id, title, prompt, t)
    } else {
        let section = vault::section_at(&text, line);
        let (id, t) = vault::ensure_anchor(&text, &section);
        let suffix = ask_suffix(opts.intent.as_deref(), opts.instruction.as_deref());
        let (prompt, title) = match &opts.excerpt {
            Some(ex) => {
                let within = if section.title.is_empty() { String::new() } else { format!(", in the section \"{}\"", section.title) };
                let prompt = format!(
                    "This is part of my note `{rel}` (lines {}-{}{within}).\n\n<note path=\"{rel}\" lines=\"{}-{}\">\n{}\n</note>{suffix}",
                    ex.from + 1, ex.to + 1, ex.from + 1, ex.to + 1, ex.text.trim()
                );
                let first = ex.text.trim().lines().next().unwrap_or_default().trim_start_matches(['#', '-', '*', ' ']);
                let title: String = first.chars().take(60).collect();
                (prompt, if title.is_empty() { section.title.clone() } else { title })
            }
            None => {
                let prompt = format!("This is a section of my note `{rel}`.\n\n<note path=\"{rel}\">\n{}\n</note>{suffix}", section.text.trim());
                (prompt, if section.title.is_empty() { rel.clone() } else { section.title.clone() })
            }
        };
        (id, title, prompt, t)
    };
    std::fs::write(&p, &text)?;

    let dirs = match reuse_dirs {
        Some(d) => d,
        None => {
            if !ws.dirs.is_empty() {
                progress(&app, "Preparing the workspace's directories…");
            }
            let branch = worktree.as_ref().map(|w| w.branch.as_str());
            workspace::prepare(&ws.dirs, &session_id, branch, project.as_deref().map(vault::expand_home).as_deref())?
        }
    };
    let prompt = match &ws.notes {
        Some((source, notes)) => format!("{prompt}\n\n<context source=\"{source}\">\n{notes}\n</context>"),
        None => prompt,
    };
    let cwd = match &worktree {
        Some(wt) => wt.path.clone(),
        None => project.unwrap_or_else(|| vault.to_string()),
    };
    let meta = SessionMeta {
        id: session_id.clone(),
        title: title.clone(),
        origin,
        origin_path: rel,
        cwd,
        started: vault::now(),
        permission_mode,
        model,
        effort,
        agent,
        worktree,
        crew: None,
        sandbox,
        verify,
        verifies: None,
        phase,
        dirs,
    };
    progress(&app, "Starting the session…");
    runner.start(app.clone(), v, meta, prompt, Turn::New)?;
    Ok(Started { session_id, title, content: text })
}

/// Renders a request's `context:` entries as `<context>` blocks appended to the prompt.
fn render_context(vault: &Path, text: &str) -> String {
    let mut out = String::new();
    for item in vault::context_items(text) {
        let (label, body) = match &item {
            vault::ContextItem::Note(n) => match vault::find_note(vault, n) {
                Some(p) => {
                    let rel = p.strip_prefix(vault).unwrap_or(&p).to_slash();
                    (rel, std::fs::read_to_string(&p).unwrap_or_default())
                }
                None => (n.clone(), format!("(note not found: {n})")),
            },
            vault::ContextItem::Query { query, from } => {
                let body = match mq::eval(vault, query, None, Some(from), None, true) {
                    Ok(rs) => rs.into_iter().flat_map(|r| r.items).collect::<Vec<_>>().join("\n\n"),
                    Err(e) => format!("(mq error: {e})"),
                };
                (format!("{from} | {query}"), body)
            }
        };
        out.push_str(&format!("\n\n<context source=\"{}\">\n{}\n</context>", label.replace('"', "'"), body.trim()));
    }
    out
}

#[tauri::command]
async fn run_from_note(app: AppHandle, vault: String, path: String, line: usize, options: Option<RunOptions>) -> Result<Started> {
    let (a, v) = (app.clone(), vault.clone());
    let started = blocking(move || start_from_note(a, &v, &path, line, options.unwrap_or_default())).await?;
    // A section's heading or a note's path says little about what was asked: name the session
    // from its prompt while it runs. Requests keep their own title.
    if vault::fm_get(&started.content, "type").as_deref() != Some("request") {
        let id = started.session_id.clone();
        tauri::async_runtime::spawn(async move { name_session(&app, &vault, &id).await });
    }
    Ok(started)
}

/// Gives a session a short title from its first prompt, written by a small model.
async fn name_session(app: &AppHandle, vault: &str, id: &str) {
    let v = PathBuf::from(vault);
    let Some(prompt) = session::read_events(&v, id).ok().and_then(|e| session::first_prompt(&e)) else { return };
    let model = session::meta(&v, id).ok().and_then(|m| m.model);
    match app.state::<Runner>().title(app, &prompt, model.as_deref()).await {
        Ok(title) => {
            if session::set_title(&v, id, &title).is_ok() {
                let _ = app.emit("sessions://changed", id);
                let _ = app.emit("sessions://renamed", serde_json::json!({"session_id": id, "title": title}));
            }
        }
        Err(e) => eprintln!("marq: could not name the session: {e}"),
    }
}

/// Renames a session.
#[tauri::command]
async fn rename_session(app: AppHandle, vault: String, session_id: String, title: String) -> Result<()> {
    blocking(move || {
        session::set_title(Path::new(&vault), &session_id, &title)?;
        let _ = app.emit("sessions://changed", &session_id);
        let _ = app.emit("sessions://renamed", serde_json::json!({"session_id": session_id, "title": title.trim()}));
        Ok(())
    })
    .await
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewTask {
    title: String,
    prompt: String,
    project: String,
    permission_mode: Option<String>,
    /// See `SessionMeta::model`.
    #[serde(default)]
    model: Option<String>,
    /// See `SessionMeta::effort`.
    #[serde(default)]
    effort: Option<String>,
    /// See `SessionMeta::agent`.
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    carry_changes: bool,
    /// Where the worktree's branch starts: `head` (the default), `latest` (the default branch, fetched) or a branch name.
    #[serde(default)]
    base: Option<String>,
    /// False: run in the project itself instead of a new worktree.
    #[serde(default = "yes")]
    worktree: bool,
    /// The user left the title empty: name the task with a small model, keeping `title` as the fallback.
    #[serde(default)]
    auto_title: bool,
    /// A command that checks the work after each turn (`verify:`).
    #[serde(default)]
    verify: Option<String>,
    /// `fresh`: retry a failed check in a new session (`verify_retry:`).
    #[serde(default)]
    verify_retry: Option<String>,
    #[serde(default)]
    verify_retries: Option<u32>,
    /// `on` or `strict`.
    #[serde(default)]
    sandbox: Option<String>,
    /// Run the task in these phases, each in a new session.
    #[serde(default)]
    phases: Vec<String>,
    /// Criteria the agent is not shown, checked by a separate session (`## Acceptance`).
    #[serde(default)]
    acceptance: Option<String>,
    /// A workspace note: its directories (and its project, when `project` is empty).
    #[serde(default)]
    workspace: Option<String>,
    /// Directories beyond the project, when not taken from a workspace.
    #[serde(default)]
    directories: Vec<workspace::DirSpec>,
    /// Other frontmatter keys, e.g. inherited from a spec.
    #[serde(skip)]
    extra: Vec<(String, String)>,
}

fn yes() -> bool {
    true
}

/// A model-written title for `prompt`, or `fallback` when that fails.
async fn auto_title(app: &AppHandle, prompt: &str, fallback: String, model: Option<&str>) -> String {
    progress(app, "Naming the task…");
    match app.state::<Runner>().title(app, prompt, model).await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("marq: could not name the task: {e}");
            fallback
        }
    }
}

/// Creates a request note from the new-task dialog and runs it, so every task is kept as a note.
/// An untitled task starts under its first line at once and is renamed when the model has named it.
#[tauri::command]
async fn new_task(app: AppHandle, vault: String, task: NewTask) -> Result<Started> {
    let rename = task.auto_title.then(|| (task.prompt.clone(), task.model.clone()));
    let (a, v) = (app.clone(), vault.clone());
    let (rel, started) = blocking(move || create_task(a, &v, task)).await?;
    if let Some((prompt, model)) = rename {
        let id = started.session_id.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(title) = app.state::<Runner>().title(&app, &prompt, model.as_deref()).await else { return };
            let v = Path::new(&vault);
            if let Err(e) = session::set_title(v, &id, &title).and_then(|_| retitle_request(&v.join(&rel), &title)) {
                eprintln!("marq: could not rename the task: {e}");
                return;
            }
            let _ = app.emit("sessions://changed", &id);
            let _ = app.emit("sessions://renamed", serde_json::json!({"session_id": id, "title": title}));
        });
    }
    Ok(started)
}

fn create_task(app: AppHandle, vault: &str, task: NewTask) -> Result<(String, Started)> {
    let rel = write_request(vault, task)?;
    let started = start_from_note(app, vault, &rel, 0, RunOptions::default())?;
    Ok((rel, started))
}

/// Replaces the `title:` in a request note's frontmatter; the file keeps its name.
fn retitle_request(path: &Path, title: &str) -> Result<()> {
    let text = std::fs::read_to_string(path)?;
    let line = format!("title: {}", serde_json::to_string(title).unwrap());
    let mut done = false;
    let out: Vec<String> = text
        .lines()
        .map(|l| if !done && l.starts_with("title: ") { done = true; line.clone() } else { l.to_string() })
        .collect();
    std::fs::write(path, out.join("\n") + "\n")?;
    Ok(())
}

/// Writes the task as a request note (`status: todo`) and returns its path relative to the vault.
fn write_request(vault: &str, task: NewTask) -> Result<String> {
    let NewTask {
        title, prompt, project, permission_mode, model, effort, agent, carry_changes, base, worktree, verify, verify_retry, verify_retries,
        sandbox, phases, acceptance, extra, workspace: ws, directories, ..
    } = task;
    let v = Path::new(vault);
    let rel = vault::unique_path(v, "requests", &title);
    std::fs::create_dir_all(v.join("requests"))?;
    let now = vault::now();
    let mut mode = permission_mode.filter(|m| !m.is_empty()).map(|m| format!("permission_mode: {m}\n")).unwrap_or_default();
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        mode.push_str(&format!("model: {m}\n"));
    }
    if let Some(e) = effort.filter(|e| !e.is_empty()) {
        mode.push_str(&format!("effort: {e}\n"));
    }
    if let Some(a) = agent.filter(|a| !a.is_empty() && a != agents::DEFAULT) {
        mode.push_str(&format!("agent: {a}\n"));
    }
    if !worktree {
        mode.push_str("worktree: false\n");
    } else {
        // Uncommitted changes are a diff against HEAD, so they only make sense on a worktree that starts there.
        let base = git::Base::parse(base.as_deref());
        if base != git::Base::Head {
            mode.push_str(&format!("base: {}\n", match base { git::Base::Latest => "latest".to_string(), git::Base::Branch(b) => b, git::Base::Head => unreachable!() }));
        } else if carry_changes {
            mode.push_str("carry_changes: true\n");
        }
    }
    let q = |s: &str| serde_json::to_string(s).unwrap();
    let mut keys: Vec<(String, String)> = extra;
    let mut set = |k: &str, v: Option<String>| {
        if let Some(v) = v.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            keys.retain(|(key, _)| key != k);
            keys.push((k.to_string(), v));
        }
    };
    set("verify", verify);
    set("verify_retry", verify_retry);
    set("verify_retries", verify_retries.map(|n| n.to_string()));
    set("sandbox", workflow::normalize_sandbox(sandbox.as_deref()));
    set("workspace", ws);
    let phases: Vec<String> = phases.iter().map(|p| p.trim().to_lowercase()).filter(|p| !p.is_empty()).collect();
    for (k, v) in &keys {
        // Commands go in quotes; the rest are plain words and numbers.
        let v = if k == "verify" { q(v) } else { v.clone() };
        mode.push_str(&format!("{k}: {v}\n"));
    }
    if !phases.is_empty() {
        mode.push_str(&format!("phases: [{}]\n", phases.join(", ")));
    }
    mode.push_str(&workspace::render_dirs(&directories));
    let acceptance = acceptance.map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).map(|a| format!("\n## Acceptance\n\n{a}\n")).unwrap_or_default();
    let content = format!(
        "---\nid: {}\ntype: request\ntitle: {}\ncreated: {now}\nupdated: {now}\nstatus: todo\nproject: {project}\n{mode}sessions: []\n---\n## Request\n\n{}\n{acceptance}",
        vault::new_id(),
        q(&title),
        prompt.trim()
    );
    std::fs::write(v.join(&rel), content)?;
    Ok(rel)
}

#[derive(Serialize)]
struct StartedCompare {
    /// The request note all the sessions share, relative to the vault.
    request: String,
    sessions: Vec<Started>,
}

/// One run of a comparison: an agent (None is Claude) and, for Claude, a model.
#[derive(Debug, serde::Deserialize)]
struct CompareTarget {
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
}

impl CompareTarget {
    fn is_claude(&self) -> bool {
        self.agent.as_deref().is_none_or(|a| a.is_empty() || a == agents::DEFAULT)
    }
}

/// Runs one request on several agents and models at once, each session in its own worktree, to compare the results.
#[tauri::command]
async fn new_task_compare(app: AppHandle, vault: String, mut task: NewTask, targets: Vec<CompareTarget>) -> Result<StartedCompare> {
    if !(2..=4).contains(&targets.len()) {
        return Err(error::Error::Other("compare needs 2 to 4 runs".into()));
    }
    let in_repo = task.worktree && git::repo_root(&vault::expand_home(&task.project)).is_some();
    if !in_repo {
        return Err(error::Error::Other(
            "comparing needs a git repository and a new worktree, so the runs do not overwrite each other".into(),
        ));
    }
    // What only Claude has: a sandbox, and a model of its own choosing.
    if task.sandbox.as_deref().is_some_and(|s| !s.is_empty()) && targets.iter().any(|t| !t.is_claude()) {
        return Err(error::Error::Other("the sandbox is Claude only: turn it off to compare other agents".into()));
    }
    for t in targets.iter().filter(|t| !t.is_claude()) {
        let agent = agents::find(t.agent.as_deref());
        if !std::path::Path::new(&shell::which(&agent.command)).is_absolute() {
            return Err(error::Error::Other(format!("{} is not installed (looked for `{}`)", agent.label, agent.command)));
        }
    }
    if task.auto_title {
        task.title = auto_title(&app, &task.prompt, task.title, None).await;
    }
    // Each session gets its agent and model from the options below, not from the note.
    task.model = None;
    task.effort = None;
    task.agent = None;
    blocking(move || {
        let request = write_request(&vault, task)?;
        let mut sessions = vec![];
        for t in targets {
            // Codex takes a model; other ACP agents run on their own.
            let model = t.model.clone().filter(|m| !m.is_empty());
            let effort = t.effort.clone().filter(|e| !e.is_empty());
            let opts = if t.is_claude() {
                RunOptions { model, effort, ..Default::default() }
            } else if t.agent.as_deref() == Some("codex") {
                RunOptions { agent: t.agent, model, effort, ..Default::default() }
            } else {
                RunOptions { agent: t.agent, ..Default::default() }
            };
            sessions.push(start_from_note(app.clone(), &vault, &request, 0, opts)?);
        }
        Ok(StartedCompare { request, sessions })
    })
    .await
}

/// Saves the new-task dialog as a request note without running it. It waits as a todo request.
#[tauri::command]
async fn save_task(app: AppHandle, vault: String, mut task: NewTask) -> Result<String> {
    if task.auto_title {
        task.title = auto_title(&app, &task.prompt, task.title, task.model.as_deref()).await;
    }
    blocking(move || write_request(&vault, task)).await
}

/// The session's worktree, or with `repo` the worktree of that repository among its other
/// directories, with the branch that is checked out now.
fn worktree_of(vault: &str, session_id: &str, repo: Option<&str>) -> Result<git::Worktree> {
    session::worktree_for(Path::new(vault), session_id, repo)?
        .ok_or_else(|| error::Error::Other("this session has no worktree".into()))
}

/// What to diff for a session: its worktree (or `repo`'s), or else the checkout it ran in.
fn diff_target(vault: &str, session_id: &str, repo: Option<&str>) -> Result<git::Worktree> {
    if let Some(wt) = session::worktree_for(Path::new(vault), session_id, repo)? {
        return Ok(wt);
    }
    let meta = session::meta(Path::new(vault), session_id)?;
    git::checkout(&vault::expand_home(&meta.cwd))
        .ok_or_else(|| error::Error::Other(format!("{} is not a git repository with a commit", meta.cwd)))
}

/// The checkout a session without a worktree ran in, if it is a git repository.
#[tauri::command]
async fn session_checkout(vault: String, session_id: String) -> Result<Option<git::Worktree>> {
    blocking(move || {
        let meta = session::meta(Path::new(&vault), &session_id)?;
        Ok(git::checkout(&vault::expand_home(&meta.cwd)))
    })
    .await
}

#[tauri::command]
async fn session_changes(vault: String, session_id: String, repo: Option<String>) -> Result<git::Changes> {
    blocking(move || git::changes(&diff_target(&vault, &session_id, repo.as_deref())?)).await
}

#[tauri::command]
async fn session_file_diff(vault: String, session_id: String, file: String, repo: Option<String>, ignore_whitespace: Option<bool>) -> Result<String> {
    blocking(move || git::file_diff(&diff_target(&vault, &session_id, repo.as_deref())?, &file, ignore_whitespace.unwrap_or(false))).await
}

#[tauri::command]
async fn session_commit(vault: String, session_id: String, message: String, repo: Option<String>) -> Result<String> {
    blocking(move || git::commit_all(&worktree_of(&vault, &session_id, repo.as_deref())?, &message)).await
}

#[tauri::command]
async fn session_push(vault: String, session_id: String, repo: Option<String>) -> Result<String> {
    blocking(move || git::push(&worktree_of(&vault, &session_id, repo.as_deref())?)).await
}

/// Pushes the current branch of a session that ran in its project, without a worktree.
#[tauri::command]
async fn session_push_cwd(vault: String, session_id: String) -> Result<String> {
    blocking(move || {
        let meta = session::meta(Path::new(&vault), &session_id)?;
        let repo = git::repo_root(&vault::expand_home(&meta.cwd))
            .ok_or_else(|| error::Error::Other(format!("{} is not a git repository", meta.cwd)))?;
        git::push_dir(&repo)
    })
    .await
}

#[tauri::command]
async fn session_create_pr(app: AppHandle, vault: String, session_id: String, message: String, repo: Option<String>) -> Result<String> {
    blocking(move || {
        let meta = session::meta(Path::new(&vault), &session_id)?;
        let wt = worktree_of(&vault, &session_id, repo.as_deref())?;
        let footer = format!("Created from Marq session `{session_id}`.");
        let (title, body) = git::pr_text(&message, &meta.title, &footer);
        let url = git::create_pr(&wt, &title, &body)?;
        // A session with an open PR is reviewed there, so it leaves Needs review.
        let _ = session::set_review(Path::new(&vault), &session_id, "pr", Some(&url));
        let _ = app.emit("sessions://changed", &session_id);
        Ok(url)
    })
    .await
}

/// Marks a session as reviewed (`done`) or back to `open`. `done` also closes its request.
#[tauri::command]
async fn set_session_review(app: AppHandle, vault: String, session_id: String, state: String) -> Result<()> {
    blocking(move || {
        if !["done", "open"].contains(&state.as_str()) {
            return Err(error::Error::Other(format!("unknown review state: {state}")));
        }
        if let Some(path) = session::set_review(Path::new(&vault), &session_id, &state, None)? {
            let _ = app.emit("vault://changed", serde_json::json!({"path": path}));
        }
        if state == "done" {
            inbox::resolve_session(&app, &session_id);
            if !app.state::<Runner>().is_alive(&session_id) {
                remove_clean_worktrees(Path::new(&vault), &session_id);
            }
        }
        let _ = app.emit("sessions://changed", &session_id);
        Ok(())
    })
    .await
}

/// A finished session's worktrees are no use any more, so they go, branches kept. One with uncommitted or
/// untracked files stays, since removing it would lose them. Failures leave the worktree where it is.
fn remove_clean_worktrees(v: &Path, session_id: &str) {
    let Ok(meta) = session::meta(v, session_id) else { return };
    let repos = meta.worktree.iter().map(|w| w.repo.clone()).chain(meta.dirs.iter().filter_map(|d| d.worktree.as_ref().map(|w| w.repo.clone())));
    for repo in repos {
        let Some(wt) = session::worktree_for(v, session_id, Some(&repo)).ok().flatten() else { continue };
        if !Path::new(&wt.path).exists() || git::changes(&wt).is_ok_and(|c| c.dirty) {
            continue;
        }
        let _ = git::remove(&wt);
    }
}

/// Renames the session's branch and records it in the session log.
#[tauri::command]
async fn session_rename_branch(app: AppHandle, vault: String, session_id: String, branch: String, repo: Option<String>) -> Result<git::Worktree> {
    blocking(move || {
        let own = session::meta(Path::new(&vault), &session_id)?.worktree.is_some_and(|w| repo.as_deref().is_none_or(|r| r == w.repo));
        let wt = git::rename_branch(&worktree_of(&vault, &session_id, repo.as_deref())?, &branch)?;
        if own {
            session::update_worktree(Path::new(&vault), &session_id, &wt)?;
        } else {
            session::update_dir_worktree(Path::new(&vault), &session_id, &wt)?;
        }
        let _ = app.emit("sessions://changed", &session_id);
        Ok(wt)
    })
    .await
}

#[tauri::command]
async fn session_remove_worktree(vault: String, session_id: String, repo: Option<String>) -> Result<()> {
    blocking(move || git::remove(&worktree_of(&vault, &session_id, repo.as_deref())?)).await
}

/// Opens a path in Finder or VS Code, or reveals a file in Finder.
#[tauri::command]
async fn open_in(path: String, app: String) -> Result<()> {
    blocking(move || open_with(&path, &app)).await
}

fn open_with(path: &str, app: &str) -> Result<()> {
    let path = vault::expand_home(path);
    let mut cmd;
    if cfg!(target_os = "macos") {
        cmd = std::process::Command::new("open");
        match app {
            "vscode" => cmd.args(["-a", "Visual Studio Code"]),
            "reveal" => cmd.arg("-R"),
            _ => &mut cmd,
        };
        cmd.arg(&path);
    } else if app == "vscode" {
        // `code` is on the PATH where VS Code is installed (a .cmd file on Windows).
        cmd = shell::command("code");
        cmd.arg(&path);
    } else if cfg!(windows) {
        cmd = std::process::Command::new("explorer");
        if app == "reveal" {
            cmd.arg(format!("/select,{}", path.display()));
        } else {
            cmd.arg(&path);
        }
    } else {
        // Linux file managers cannot select a file, so reveal opens its folder.
        cmd = std::process::Command::new("xdg-open");
        let target = if app == "reveal" && path.is_file() { path.parent().map(Path::to_path_buf).unwrap_or(path) } else { path };
        cmd.arg(target);
    }
    // explorer exits with 1 even when it worked, so only a failure to start is an error.
    cmd.status()?;
    Ok(())
}

#[tauri::command]
async fn search_text(vault: String, query: String, include_sessions: bool) -> Result<serde_json::Value> {
    blocking(move || {
        let (hits, q) = vault::search(Path::new(&vault), &query, include_sessions, 200, 20);
        Ok(serde_json::json!({"hits": hits, "expanded": q.expanded()}))
    })
    .await
}

/// Past sessions that mention every word of a search (or a synonym), best matches first.
#[tauri::command]
async fn search_sessions(vault: String, query: String, project: Option<String>, since: Option<String>) -> Result<serde_json::Value> {
    blocking(move || {
        let v = Path::new(&vault);
        let q = thesaurus::Query::parse(&query, &thesaurus::Thesaurus::load(&vault::list_files(v)));
        let hits = sidecar::search_sessions_for(v, &q, project.as_deref().filter(|p| !p.is_empty()), since.as_deref().filter(|d| !d.is_empty()), 100, "");
        Ok(serde_json::json!({"hits": hits, "expanded": q.expanded()}))
    })
    .await
}

/// Links into and out of a note, and mentions of it that are not links yet.
#[tauri::command]
async fn note_links(vault: String, path: String) -> Result<links::Backlinks> {
    blocking(move || {
        let v = Path::new(&vault);
        let p = vault::resolve(v, &path)?;
        let rel = p.strip_prefix(v).unwrap_or(&p).to_slash();
        Ok(links::backlinks(&vault::list_files(v), &rel))
    })
    .await
}

/// The note a `[[target]]` names, created under notes/ when there is none yet (`create`).
#[tauri::command]
fn wikilink_open(app: AppHandle, vault: String, target: String, create: bool) -> Result<Option<String>> {
    let v = Path::new(&vault);
    if let Some(f) = links::resolve(&vault::list_files(v), &target) {
        return Ok(Some(f.path.clone()));
    }
    if !create {
        return Ok(None);
    }
    let p = links::create_for(v, &target)?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(Some(p.to_string_lossy().into_owned()))
}

/// Marks a knowledge note as checked by the user.
#[tauri::command]
fn knowledge_review(app: AppHandle, vault: String, path: String) -> Result<()> {
    let p = vault::resolve(Path::new(&vault), &path)?;
    knowledge::set_reviewed(&p)?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(())
}

/// The schedule that merges learnings into knowledge notes, created the first time.
/// Every workspace note.
#[tauri::command]
async fn list_workspaces(vault: String) -> Result<Vec<workspace::Workspace>> {
    blocking(move || Ok(workspace::list(Path::new(&vault)))).await
}

/// Saves a set of directories as a workspace note and returns its path.
#[tauri::command]
fn create_workspace(app: AppHandle, vault: String, title: String, project: String, directories: Vec<workspace::DirSpec>) -> Result<String> {
    let p = workspace::create(Path::new(&vault), &title, &project, &directories, "")?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(p.to_string_lossy().into_owned())
}

/// Writes a new spec note from the template and returns its path.
#[tauri::command]
fn new_spec(app: AppHandle, vault: String, title: String) -> Result<String> {
    let p = workflow::new_spec(Path::new(&vault), &title)?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(p.to_string_lossy().into_owned())
}

#[derive(Serialize)]
struct BrokenDown {
    board: String,
    added: usize,
}

/// Puts a spec's open tasks on its board.
#[tauri::command]
async fn spec_to_board(app: AppHandle, vault: String, path: String) -> Result<BrokenDown> {
    blocking(move || {
        let v = Path::new(&vault);
        let (board, added) = workflow::spec_to_board(v, &vault::resolve(v, &path)?)?;
        let _ = app.emit("vault://changed", serde_json::json!({"path": board}));
        let _ = app.emit("vault://changed", serde_json::json!({"path": path}));
        Ok(BrokenDown { board: board.to_string_lossy().into_owned(), added })
    })
    .await
}

/// The schedule that writes reviewed knowledge back into the project, created on first use.
#[tauri::command]
fn knowledge_promotion(app: AppHandle, vault: String) -> Result<String> {
    let p = knowledge::ensure_promotion(Path::new(&vault))?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
fn knowledge_gardening(app: AppHandle, vault: String) -> Result<String> {
    let p = knowledge::ensure_gardening(Path::new(&vault))?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(p.to_string_lossy().into_owned())
}

/// Opens `glossary.md`, creating it with an example entry first.
#[tauri::command]
fn glossary_path(app: AppHandle, vault: String) -> Result<String> {
    let p = thesaurus::ensure_glossary(Path::new(&vault))?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(p.to_string_lossy().into_owned())
}

/// Opens `instructions.md`, creating it with an explanation first.
#[tauri::command]
fn instructions_path(app: AppHandle, vault: String) -> Result<String> {
    let p = memory::ensure_instructions(Path::new(&vault))?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(p.to_string_lossy().into_owned())
}

/// Saves a query as `queries/<name>.md`: a note whose mq block runs in the preview too. Overwrites.
#[tauri::command]
fn save_query(
    app: AppHandle, vault: String, name: String, query: String, glob: String, aggregate: bool, agent: Option<String>, agent_each: Option<bool>,
) -> Result<String> {
    let name = name.trim().trim_end_matches(".md");
    if name.is_empty() || name.split('/').any(|p| p == "..") {
        return Err(error::Error::Other("a query needs a name".into()));
    }
    let v = Path::new(&vault);
    let rel = format!("queries/{name}.md");
    std::fs::create_dir_all(v.join(&rel).parent().unwrap())?;
    let p = vault::resolve(v, &rel)?;
    let q = |s: &str| serde_json::to_string(s).unwrap();
    // The fence's input is relative to the note, which sits one folder down per `/` in the name.
    let up = "../".repeat(rel.matches('/').count());
    let flags = if aggregate { String::new() } else { " aggregate=false".into() };
    // What an agent started from the results is told, and whether each file gets its own session.
    let agent = agent.as_deref().map(str::trim).filter(|a| !a.is_empty());
    let agent_fm = agent.map_or(String::new(), |a| format!("agent: {}\n", q(a)) + &if agent_each == Some(true) { "agent_each: true\n".to_string() } else { String::new() });
    let content = format!(
        "---\ntype: query\ntitle: {}\nglob: {}\naggregate: {aggregate}\n{agent_fm}updated: {}\n---\n# {name}\n\n```mq input={up}{glob}{flags}\n{}\n```\n",
        q(name),
        q(&glob),
        vault::now(),
        query.trim()
    );
    std::fs::write(&p, content)?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(p.to_string_lossy().into_owned())
}

// ---- boards ----

/// Applies `f` to the board at `path` and tells the views it changed.
fn on_board<T>(app: &AppHandle, vault: &str, path: &str, f: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    let p = vault::resolve(Path::new(vault), path)?;
    let out = f(&p)?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(out)
}

#[tauri::command]
fn board_create(app: AppHandle, vault: String, name: String) -> Result<String> {
    let p = boards::create(Path::new(&vault), &name, &[])?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(p.to_string_lossy().into_owned())
}

/// The vault the window has open, for schedules and the inbox.
#[tauri::command]
fn automation_watch(app: AppHandle, vault: String) {
    app.state::<automation::Automation>().watch(&vault);
}

#[tauri::command]
async fn schedules_list(app: AppHandle, vault: String) -> Result<Vec<serde_json::Value>> {
    blocking(move || Ok(automation::list(&app, Path::new(&vault)))).await
}

#[tauri::command]
fn schedule_create(
    app: AppHandle, vault: String, title: String, when: String, prompt: String, project: String, query: Option<String>,
) -> Result<String> {
    let p = automation::create(Path::new(&vault), &title, &when, &prompt, &project, query.as_deref().unwrap_or_default())?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn schedule_run(app: AppHandle, vault: String, path: String) -> Result<Option<String>> {
    blocking(move || {
        let v = PathBuf::from(&vault);
        let p = vault::resolve(&v, &path)?;
        automation::run_schedule(&app, &v, &p)
    })
    .await
}

#[tauri::command]
fn schedule_set_enabled(app: AppHandle, vault: String, path: String, enabled: bool) -> Result<()> {
    let p = vault::resolve(Path::new(&vault), &path)?;
    automation::set_enabled(&p, enabled)?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(())
}

#[tauri::command]
fn board_read(vault: String, path: String) -> Result<boards::Board> {
    boards::read(&vault::resolve(Path::new(&vault), &path)?)
}

#[tauri::command]
fn board_add(app: AppHandle, vault: String, path: String, title: String, list: Option<String>) -> Result<boards::Card> {
    on_board(&app, &vault, &path, |p| boards::add(p, &title, list.as_deref(), None, None))
}

#[tauri::command]
fn board_update(app: AppHandle, vault: String, path: String, id: String, change: boards::Change) -> Result<boards::Card> {
    on_board(&app, &vault, &path, |p| boards::update(p, &id, change))
}

#[tauri::command]
fn board_remove(app: AppHandle, vault: String, path: String, id: String) -> Result<()> {
    on_board(&app, &vault, &path, |p| boards::remove(p, &id))
}

/// `op`: add, rename (to `to`), left, right, move (to index `to`) or remove.
#[tauri::command]
fn board_list(app: AppHandle, vault: String, path: String, op: String, name: String, to: Option<String>) -> Result<()> {
    on_board(&app, &vault, &path, |p| match op.as_str() {
        "add" => boards::add_list(p, &name),
        "rename" => boards::rename_list(p, &name, to.as_deref().unwrap_or_default()),
        "left" => boards::move_list(p, &name, -1),
        "right" => boards::move_list(p, &name, 1),
        "move" => boards::move_list_to(p, &name, to.as_deref().and_then(|t| t.parse().ok()).unwrap_or(0)),
        "remove" => boards::remove_list(p, &name),
        _ => Err(error::Error::Other(format!("unknown list op: {op}"))),
    })
}

#[tauri::command]
fn read_config() -> Result<serde_json::Value> {
    config::read()
}

/// The config file's path, creating it from the template if needed.
#[tauri::command]
fn config_path() -> Result<String> {
    Ok(config::ensure()?.to_string_lossy().into_owned())
}

/// Sets `section.key` values in config.toml; null removes a key.
#[tauri::command]
fn write_config(changes: serde_json::Map<String, serde_json::Value>) -> Result<()> {
    config::write(&changes)
}

#[tauri::command]
fn shells() -> Vec<String> {
    config::shells()
}

#[tauri::command]
fn terminal_open(
    app: AppHandle,
    terms: State<terminal::Terminals>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
) -> Result<()> {
    terms.open(&app, &id, &cwd, cols, rows, command.as_deref())
}

#[tauri::command]
fn terminal_write(terms: State<terminal::Terminals>, id: String, data: String) -> Result<()> {
    terms.write(&id, &data)
}

#[tauri::command]
fn terminal_resize(terms: State<terminal::Terminals>, id: String, cols: u16, rows: u16) -> Result<()> {
    terms.resize(&id, cols, rows)
}

#[tauri::command]
fn terminal_close(terms: State<terminal::Terminals>, id: String) {
    terms.close(&id)
}

/// The models an agent lists for the new-task dialog.
#[tauri::command]
async fn agent_models(app: AppHandle, agent: Option<String>) -> Result<serde_json::Value> {
    let agent = agent.filter(|a| !a.is_empty() && a != agents::DEFAULT);
    app.state::<Runner>().agent_models(&app, agent.as_deref()).await
}

/// Ollama models for the new-task dialog.
#[tauri::command]
async fn ollama_models(app: AppHandle) -> Result<serde_json::Value> {
    app.state::<Runner>().ollama_models(&app).await
}

/// Projects used by earlier sessions, most recent first, for the new-task dialog.
#[tauri::command]
async fn recent_projects(vault: String) -> Result<Vec<String>> {
    blocking(move || {
        let mut seen = Vec::new();
        for s in session::list(Path::new(&vault), None) {
            let p = s.meta.worktree.as_ref().map(|w| w.repo.clone()).unwrap_or(s.meta.cwd);
            if p != vault && !seen.contains(&p) {
                seen.push(p);
            }
        }
        Ok(seen)
    })
    .await
}

/// Sends text from one session to another for the user (Send to session), optionally bringing the
/// answer back to the first.
#[tauri::command]
async fn forward_message(app: AppHandle, vault: String, from: String, to: String, text: String, reply: bool) -> Result<()> {
    blocking(move || relay::send(&app, Path::new(&vault), &from, &to, &text, reply, relay::By::User)).await
}

#[tauri::command]
async fn send_message(app: AppHandle, vault: String, session_id: String, text: String) -> Result<()> {
    blocking(move || {
        let v = PathBuf::from(&vault);
        let meta = session::meta(&v, &session_id)?;
        app.state::<Runner>().start(app.clone(), v, meta, text, Turn::Resume)
    })
    .await
}

const CONTINUE_PROMPT: &str = "The previous run was interrupted before it finished (the app stopped or crashed). \
Check the current state of the work and continue the task from where it left off.";

/// Resumes a session that stopped part-way: continues its conversation, or starts it again from
/// the first prompt when the conversation never started.
#[tauri::command]
async fn resume_session(app: AppHandle, vault: String, session_id: String) -> Result<()> {
    blocking(move || {
        let v = PathBuf::from(&vault);
        let runner = app.state::<Runner>();
        if runner.is_alive(&session_id) {
            return Err(error::Error::Other("the session is still running".into()));
        }
        let events = session::read_events(&v, &session_id)?;
        let meta = session::meta(&v, &session_id)?;
        if !std::path::Path::new(&vault::expand_home(&meta.cwd)).is_dir() {
            return Err(error::Error::Other(format!("the working directory no longer exists: {}", meta.cwd)));
        }
        if session::has_conversation(&events) {
            runner.start(app.clone(), v, meta, CONTINUE_PROMPT.into(), Turn::Resume)
        } else {
            let prompt = session::first_prompt(&events).ok_or_else(|| error::Error::Other("no prompt to retry".into()))?;
            runner.start(app.clone(), v, meta, prompt, Turn::Restart)
        }
    })
    .await
}

/// Interrupts the current turn. The session stays open for follow-ups.
#[tauri::command]
fn stop_session(app: AppHandle, runner: State<Runner>, session_id: String) -> Result<()> {
    runner.interrupt(&app, &session_id)
}

#[tauri::command]
fn answer_approval(
    app: AppHandle,
    runner: State<Runner>,
    request_id: String,
    allow: bool,
    always: bool,
    message: Option<String>,
    answers: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<()> {
    runner.answer(&app, &request_id, allow, always, message, answers)
}

#[tauri::command]
fn list_approvals(runner: State<Runner>, session_id: Option<String>) -> Vec<Approval> {
    runner.approvals(session_id.as_deref())
}

/// Slash commands and skills for completion. `cwd` defaults to the session's directory, then the vault.
#[tauri::command]
async fn list_commands(app: AppHandle, vault: String, cwd: Option<String>, session_id: Option<String>) -> Result<serde_json::Value> {
    let cwd = match (cwd.filter(|c| !c.is_empty()), &session_id) {
        (Some(c), _) => c,
        (None, Some(id)) => session::meta(Path::new(&vault), id).map(|m| m.cwd).unwrap_or_else(|_| vault.clone()),
        (None, None) => vault.clone(),
    };
    let runner = app.state::<Runner>();
    // Skills and commands on disk (Claude's, Codex's, Gemini's...) are listed too, so completion still
    // works when `claude` is missing and the agent's own list cannot be had.
    let dir = vault::expand_home(&cwd);
    let found = blocking(move || Ok(commands::scan(&dir))).await.unwrap_or_default();
    let mut list = match runner.commands(&app, &cwd, session_id.as_deref()).await {
        Ok(serde_json::Value::Array(list)) => list,
        Ok(_) => vec![],
        Err(e) if found.is_empty() => return Err(e),
        Err(_) => vec![],
    };
    let known: std::collections::HashSet<String> =
        list.iter().filter_map(|c| c["name"].as_str().map(str::to_string)).collect();
    list.extend(found.into_iter().filter(|c| !known.contains(c["name"].as_str().unwrap_or_default())));
    Ok(serde_json::Value::Array(list))
}

/// The agents a task can run on, with whether each is installed.
#[tauri::command]
async fn list_agents() -> Result<Vec<agents::AgentInfo>> {
    blocking(|| Ok(agents::list())).await
}

#[tauri::command]
fn session_events(vault: String, session_id: String) -> Result<Vec<serde_json::Value>> {
    session::read_events(Path::new(&vault), &session_id)
}

/// Lists sessions. One still marked running without a live process (e.g. after a crash) is
/// recorded as interrupted, so it can be resumed or deleted.
#[tauri::command]
async fn list_sessions(app: AppHandle, vault: String, origin: Option<String>) -> Result<Vec<SessionInfo>> {
    blocking(move || {
        let runner = app.state::<Runner>();
        let v = Path::new(&vault);
        let mut list = session::list(v, origin.as_deref());
        for s in list.iter_mut().filter(|s| s.status == "running" && !runner.is_alive(&s.meta.id)) {
            if session::mark_interrupted(v, &s.meta.id).is_ok() {
                s.status = "interrupted".into();
            }
        }
        Ok(list)
    })
    .await
}

/// Deletes a session. Files go to the Trash; the worktree and branch only when asked.
#[tauri::command]
async fn delete_session(app: AppHandle, vault: String, session_id: String, remove_worktree: bool, delete_branch: bool) -> Result<()> {
    blocking(move || remove_session(&app, &vault, &session_id, remove_worktree, delete_branch)).await
}

fn remove_session(app: &AppHandle, vault: &str, session_id: &str, remove_worktree: bool, delete_branch: bool) -> Result<()> {
    let v = Path::new(vault);
    let meta = session::meta(v, session_id)?;
    let runner = app.state::<Runner>();
    if runner.is_alive(session_id) {
        progress(app, "Stopping the session…");
        runner.stop(app, session_id)?;
    }
    // The branch may have been renamed in the worktree, so delete the one checked out now.
    let current = if delete_branch { session::current_worktree(v, session_id).ok().flatten() } else { None };
    if let Some(wt) = current.as_ref().or(meta.worktree.as_ref()) {
        if remove_worktree || delete_branch {
            progress(app, "Removing the worktree…");
            git::remove(wt)?;
        }
        if delete_branch {
            git::delete_branch(wt)?;
        }
    }
    // The worktrees made for the workspace's other directories go with the session's own.
    if remove_worktree || delete_branch {
        for d in &meta.dirs {
            let Some(repo) = d.worktree.as_ref().map(|w| w.repo.clone()) else { continue };
            let Some(wt) = session::worktree_for(v, session_id, Some(&repo)).ok().flatten() else { continue };
            if Path::new(&wt.path).exists() {
                git::remove(&wt)?;
            }
            if delete_branch {
                git::delete_branch(&wt)?;
            }
        }
    }
    progress(app, "Moving files to the Trash…");
    if let Some(path) = session::delete(v, session_id)? {
        let _ = app.emit("vault://changed", serde_json::json!({"path": path}));
    }
    Ok(())
}

/// Sets a request's `status` (todo, running, review, done, dropped).
#[tauri::command]
async fn set_note_status(vault: String, path: String, status: String) -> Result<()> {
    blocking(move || {
        if !["todo", "running", "review", "done", "dropped"].contains(&status.as_str()) {
            return Err(error::Error::Other(format!("unknown status: {status}")));
        }
        let p = vault::resolve(Path::new(&vault), &path)?;
        let t = std::fs::read_to_string(&p)?;
        let t = vault::fm_set(&t, "status", &status);
        std::fs::write(&p, vault::fm_set(&t, "updated", &vault::now()))?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn list_dirs(vault: String) -> Result<Vec<String>> {
    blocking(move || Ok(organize::list_dirs(Path::new(&vault)))).await
}

#[tauri::command]
async fn create_folder(app: AppHandle, vault: String, path: String) -> Result<String> {
    blocking(move || {
        let rel = organize::create_folder(Path::new(&vault), &path)?;
        let _ = app.emit("vault://changed", serde_json::json!({"path": Path::new(&vault).join(&rel)}));
        Ok(rel)
    })
    .await
}

/// Moves or renames a note or folder and rewrites relative links.
#[tauri::command]
async fn move_path(app: AppHandle, vault: String, from: String, to: String) -> Result<organize::MoveResult> {
    blocking(move || {
        let v = Path::new(&vault);
        let from = v.join(&from).strip_prefix(v).map(|p| p.to_slash()).unwrap_or(from);
        let r = organize::move_path(v, &from, &to)?;
        emit_moved(&app, v, &r);
        Ok(r)
    })
    .await
}

/// Tells open tabs that notes moved, and refreshes notes whose links changed.
pub(crate) fn emit_moved(app: &AppHandle, vault: &Path, r: &organize::MoveResult) {
    let _ = app.emit("vault://moved", &r.moved);
    for rel in &r.relinked {
        let _ = app.emit("vault://changed", serde_json::json!({"path": vault.join(rel)}));
    }
}

/// Moves a note to the Trash.
#[tauri::command]
async fn delete_note(vault: String, path: String) -> Result<()> {
    blocking(move || vault::move_to_trash(&vault::resolve(Path::new(&vault), &path)?)).await
}

/// The documents a session's task produced: those written for its origin, by any run, or by the session itself.
#[tauri::command]
async fn session_docs(vault: String, session_id: String) -> Result<Vec<serde_json::Value>> {
    blocking(move || {
        let v = Path::new(&vault);
        let meta = session::meta(v, &session_id)?;
        Ok(vault::docs_from(v, &meta.origin, Some(&session_id)))
    })
    .await
}

/// A new untitled note in `notes/`, or with `scratch`, a scratch memo in `scratch/`. Returns its path.
#[tauri::command]
fn create_untitled(vault: String, scratch: bool) -> Result<String> {
    Ok(scratch::create(Path::new(&vault), scratch)?.to_string_lossy().into_owned())
}

/// Deletes an untitled note or scratch memo with nothing in it, as its tab closes.
#[tauri::command]
fn discard_untitled(vault: String, path: String) -> Result<bool> {
    scratch::discard_if_empty(Path::new(&vault), &path)
}

/// On opening a vault: removes empty untitled notes and trashes scratch memos past `[scratch] keep_days`.
#[tauri::command]
async fn sweep_scratch(vault: String) -> Result<scratch::Swept> {
    blocking(move || scratch::sweep(Path::new(&vault), scratch::keep_days(), vault::move_to_trash)).await
}

/// Keeps a scratch memo as a note at `to`.
#[tauri::command]
async fn keep_scratch(app: AppHandle, vault: String, from: String, to: String) -> Result<organize::MoveResult> {
    blocking(move || {
        let v = Path::new(&vault);
        let r = scratch::keep(v, &from, &to)?;
        emit_moved(&app, v, &r);
        Ok(r)
    })
    .await
}

/// The crew view's data: the note, its members and the message timeline.
#[tauri::command]
async fn crew_state(app: AppHandle, vault: String, crew_id: String) -> Result<crew::CrewState> {
    blocking(move || crew::state(&app, Path::new(&vault), &crew_id)).await
}

/// Sends a message from the user to a crew member.
#[tauri::command]
async fn crew_send(app: AppHandle, vault: String, crew_id: String, to: String, text: String) -> Result<crew::Sent> {
    blocking(move || {
        let msg = crew::Outgoing { from: crew::USER, to: &to, kind: "tell", text: &text, reply_to: None };
        crew::send(&app, Path::new(&vault), &crew_id, msg)
    }).await
}

/// Sets the model a member runs on from its next turn. An empty model goes back to the crew's.
#[tauri::command]
async fn crew_set_model(app: AppHandle, vault: String, crew_id: String, role: String, model: String) -> Result<Option<String>> {
    blocking(move || crew::set_model(&app, Path::new(&vault), &crew_id, crew::USER, &role, Some(&model))).await
}

/// Sends the crew's Goal to its first member.
#[tauri::command]
async fn crew_kick_off(app: AppHandle, vault: String, crew_id: String) -> Result<()> {
    blocking(move || crew::kick_off(&app, Path::new(&vault), &crew_id).map(|_| ())).await
}

#[derive(Serialize)]
struct StartedCrew {
    rel: String,
    title: String,
}

/// Starts a task as a crew (New task with Team): a crew note with the prompt as its Goal, kicked off.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn new_crew(
    app: AppHandle, vault: String, title: String, prompt: String, project: String, auto_title: bool,
    workspace: Option<String>, directories: Option<Vec<workspace::DirSpec>>,
) -> Result<StartedCrew> {
    let title = if auto_title { self::auto_title(&app, &prompt, title, None).await } else { title };
    let mut setup = workspace.filter(|w| !w.trim().is_empty()).map(|w| format!("workspace: {}\n", serde_json::to_string(w.trim()).unwrap())).unwrap_or_default();
    setup.push_str(&workspace::render_dirs(&directories.unwrap_or_default()));
    blocking(move || {
        progress(&app, "Starting the crew…");
        let c = crew::start(&app, Path::new(&vault), &title, &prompt, &project, &setup)?;
        Ok(StartedCrew { rel: c.rel, title: c.title })
    })
    .await
}

/// Changes a task's status or owner as the user. An empty owner unassigns it.
#[tauri::command]
async fn crew_task_update(
    app: AppHandle,
    vault: String,
    crew_id: String,
    id: String,
    status: Option<String>,
    owner: Option<String>,
) -> Result<tasks::Task> {
    blocking(move || {
        let change = crew::TaskChange { status: status.as_deref(), owner: owner.as_deref(), note: None };
        crew::task_update(&app, Path::new(&vault), &crew_id, crew::USER, &id, change)
    })
    .await
}

/// Lets a message held at the hop limit through.
#[tauri::command]
async fn crew_release(app: AppHandle, vault: String, crew_id: String, msg_id: String) -> Result<()> {
    blocking(move || crew::release(&app, Path::new(&vault), &crew_id, &msg_id)).await
}

#[derive(Serialize)]
struct OriginLocation {
    path: String,
    line: usize,
}

/// Where a session came from, for jumping back to the note.
#[tauri::command]
async fn session_origin(vault: String, session_id: String) -> Result<Option<OriginLocation>> {
    blocking(move || find_session_origin(&vault, &session_id)).await
}

fn find_session_origin(vault: &str, session_id: &str) -> Result<Option<OriginLocation>> {
    let v = PathBuf::from(vault);
    let Ok(meta) = session::meta(&v, session_id) else { return Ok(None) };
    let Some(path) = session::find_origin(&v, &meta) else { return Ok(None) };
    let text = std::fs::read_to_string(&path)?;
    let line = vault::anchors(&text).into_iter().find(|a| a.id == meta.origin).map(|a| a.line).unwrap_or(0);
    Ok(Some(OriginLocation { path: path.to_string_lossy().into_owned(), line }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// The default menu with an About panel that shows the icon (dev builds have none).
fn app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::default(app)?;
    let info = app.package_info();
    let about = PredefinedMenuItem::about(
        app,
        Some("About Marq"),
        Some(AboutMetadata {
            name: Some(info.name.clone()),
            version: Some(info.version.to_string()),
            icon: Some(tauri::include_image!("icons/128x128@2x.png")),
            copyright: Some("© 2026 Takahiro Sato".into()),
            ..Default::default()
        }),
    )?;
    // About: first item of the app menu on macOS, of Help elsewhere.
    let first = menu.items()?.into_iter().next().and_then(|i| i.as_submenu().cloned());
    let submenu = if cfg!(target_os = "macos") {
        first.clone()
    } else {
        menu.get(HELP_SUBMENU_ID).and_then(|i| i.as_submenu().cloned())
    };
    if let Some(sub) = submenu {
        sub.remove_at(0)?;
        sub.prepend(&about)?;
    }
    // Settings…: under About on macOS, at the top of File elsewhere. Opened in the webview (`menu://settings`).
    if let Some(sub) = first {
        let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
        let at = if cfg!(target_os = "macos") { 1 } else { 0 };
        sub.insert_items(&[&PredefinedMenuItem::separator(app)?, &settings], at)?;
    }
    add_command_menus(app, &menu)?;
    // ⌘W closes the tab in the webview, not the window.
    for item in menu.items()? {
        let Some(sub) = item.as_submenu() else { continue };
        let items = sub.items()?;
        for (i, it) in items.iter().enumerate().rev() {
            if it.as_predefined_menuitem().and_then(|p| p.text().ok()).as_deref() == Some("Close Window") {
                sub.remove_at(i)?;
            }
        }
    }
    Ok(menu)
}

/// A menu item that runs an app command (the ids of the ⌘K palette) in the webview. It has no
/// native accelerator on purpose: the webview handles keys itself, so rebinding them in config.toml works.
fn command_item(app: &AppHandle, command: &str, text: &str) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, format!("cmd:{command}"), text, true, None::<&str>)
}

/// File, Edit and View get the app's own items; Split and Tab are new menus before Window.
fn add_command_menus(app: &AppHandle, menu: &Menu<Wry>) -> tauri::Result<()> {
    use tauri::menu::Submenu;
    let sep = || PredefinedMenuItem::separator(app);
    let items = |list: &[(&str, &str)]| -> tauri::Result<Vec<MenuItem<Wry>>> {
        list.iter().map(|(c, t)| command_item(app, c, t)).collect()
    };
    let append = |sub: &Submenu<Wry>, list: &[(&str, &str)], leading_separator: bool| -> tauri::Result<()> {
        if leading_separator {
            sub.append(&sep()?)?;
        }
        for it in items(list)? {
            sub.append(&it)?;
        }
        Ok(())
    };
    let find = |name: &str| -> Option<Submenu<Wry>> {
        menu.items().ok()?.into_iter().filter_map(|i| i.as_submenu().cloned()).find(|s| s.text().ok().as_deref() == Some(name))
    };

    if let Some(file) = find("File") {
        let new = items(&[
            ("task.new", "New Task…"),
            ("note.new", "New Note…"),
            ("note.quick", "Quick Note"),
            ("scratch.new", "Scratch Memo"),
            ("board.new", "New Board…"),
            ("terminal.new", "New Terminal"),
        ])?;
        for (i, it) in new.iter().enumerate() {
            file.insert(it, i)?;
        }
        file.insert(&sep()?, new.len())?;
        file.insert(&command_item(app, "file.open", "Open…")?, new.len() + 1)?;
        file.insert(&sep()?, new.len() + 2)?;
        file.append(&command_item(app, "tab.close", "Close Tab")?)?;
    }
    if let Some(edit) = find("Edit") {
        append(&edit, &[("find", "Find…"), ("search.open", "Search Notes…"), ("palette", "Command Palette…")], true)?;
    }
    if let Some(view) = find("View") {
        append(
            &view,
            &[
                ("sidebar.toggle", "Show or Hide Sidebar"),
                ("theme.next", "Next Theme"),
                ("note.toggleEdit", "Switch Note Between Preview and Edit"),
            ],
            true,
        )?;
    }
    let split = Submenu::with_items(
        app,
        "Split",
        true,
        &[
            &command_item(app, "split.open", "Split View (Show Tab Beside the Previous One)")?,
            &command_item(app, "split.focus", "Focus the Other Side")?,
            &command_item(app, "split.direction", "Side by Side / Stacked")?,
            &command_item(app, "split.close", "Close Split")?,
            &sep()?,
            &command_item(app, "terminal.splitRight", "Terminal: Split Right")?,
            &command_item(app, "terminal.splitDown", "Terminal: Split Down")?,
            &command_item(app, "terminal.paneNext", "Terminal: Next Pane")?,
            &command_item(app, "terminal.paneZoom", "Terminal: Zoom Pane")?,
            &command_item(app, "terminal.paneClose", "Terminal: Close Pane")?,
        ],
    )?;
    let tab = Submenu::with_items(
        app,
        "Tab",
        true,
        &[
            &command_item(app, "tab.next", "Next Tab")?,
            &command_item(app, "tab.prev", "Previous Tab")?,
            &command_item(app, "tab.pin", "Pin or Unpin Tab")?,
            &command_item(app, "tab.rename", "Rename Tab or Session…")?,
            &sep()?,
            &command_item(app, "session.nextActive", "Go to Next Running or Waiting Session")?,
            &command_item(app, "query.open", "mq Query")?,
            &command_item(app, "glossary.open", "Glossary")?,
            &command_item(app, "instructions.open", "Standing Instructions")?,
        ],
    )?;
    let at = menu.items()?.iter().position(|i| i.as_submenu().and_then(|s| s.text().ok()).as_deref() == Some("Window"));
    match at {
        Some(at) => menu.insert_items(&[&split, &tab], at)?,
        None => menu.append_items(&[&split, &tab])?,
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .menu(app_menu)
        .on_menu_event(|app, e| {
            if e.id() == "settings" {
                let _ = app.emit("menu://settings", ());
            } else if let Some(command) = e.id().0.strip_prefix("cmd:") {
                let _ = app.emit("menu://command", command);
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Runner::default())
        .manage(terminal::Terminals::default())
        .manage(automation::Automation::default())
        .manage(inbox::Inbox::default())
        .setup(|app| {
            automation::start(app.handle());
            inbox::start(app.handle());
            // Resolving `claude` and `node` through the login shell and starting Node take a few
            // seconds, so do it now instead of on the first run.
            let handle = app.handle().clone();
            std::thread::spawn(move || sidecar::prewarm(&handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ollama_models,
            agent_models,
            save_query,
            search_text,
            search_sessions,
            glossary_path,
            instructions_path,
            note_links,
            knowledge_review,
            knowledge_gardening,
            knowledge_promotion,
            new_spec,
            spec_to_board,
            list_workspaces,
            create_workspace,
            wikilink_open,
            board_create,
            board_read,
            board_add,
            board_update,
            board_remove,
            board_list,
            automation_watch,
            schedules_list,
            schedule_create,
            schedule_run,
            schedule_set_enabled,
            read_config,
            config_path,
            write_config,
            shells,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            list_files,
            read_note,
            write_note,
            create_note,
            note_anchors,
            pin_mq_output,
            mq_eval,
            run_from_note,
            send_message,
            stop_session,
            resume_session,
            answer_approval,
            list_approvals,
            list_agents,
            list_commands,
            session_events,
            list_sessions,
            session_origin,
            new_task,
            save_task,
            new_task_compare,
            session_checkout,
            session_changes,
            session_file_diff,
            session_commit,
            session_create_pr,
            session_push,
            session_push_cwd,
            set_session_review,
            session_remove_worktree,
            session_rename_branch,
            delete_session,
            delete_note,
            set_note_status,
            inbox::inbox_list,
            inbox::inbox_resolve,
            inbox::inbox_clear,
            inbox::inbox_queue_request,
            list_dirs,
            create_folder,
            move_path,
            open_in,
            recent_projects,
            crew_state,
            session_docs,
            create_untitled,
            discard_untitled,
            sweep_scratch,
            keep_scratch,
            crew_send,
            crew_release,
            crew_kick_off,
            crew_set_model,
            forward_message,
            rename_session,
            crew_task_update,
            new_crew,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod compare_tests {
    use super::CompareTarget;

    fn target(json: &str) -> CompareTarget {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn a_run_without_an_agent_is_claude() {
        assert!(target(r#"{"model":"sonnet"}"#).is_claude());
        assert!(target(r#"{"agent":"claude"}"#).is_claude());
        assert!(target(r#"{"agent":""}"#).is_claude());
        assert!(!target(r#"{"agent":"codex"}"#).is_claude());
    }
}
