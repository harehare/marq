mod boards;
mod claude;
mod config;
mod crew;
mod error;
mod git;
mod mq;
mod organize;
mod shell;
mod tasks;
mod terminal;
mod sidecar;
mod vault;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, HELP_SUBMENU_ID};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

use claude::{SessionInfo, SessionMeta};
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
        std::fs::write(&p, crew::template(&vault::new_id(), &title, &now, "", ""))?;
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
    /// do (default), review, plan or explain.
    intent: Option<String>,
    /// What the user wants, in their words.
    instruction: Option<String>,
    /// Selected lines to ask about instead of the whole section.
    excerpt: Option<Excerpt>,
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

/// Starts Claude from the note at `path`: the whole body for a request, otherwise the section at `line`.
fn start_from_note(app: AppHandle, vault: &str, path: &str, line: usize, opts: RunOptions) -> Result<Started> {
    let runner = app.state::<Runner>();
    let v = PathBuf::from(vault);
    let p = vault::resolve(&v, path)?;
    let text = std::fs::read_to_string(&p)?;
    let rel = p.strip_prefix(&v).unwrap_or(&p).to_string_lossy().into_owned();
    let session_id = vault::new_id();
    let project = opts.project.or_else(|| vault::fm_get(&text, "project")).filter(|s| !s.is_empty());
    let permission_mode = match opts.intent.as_deref() {
        Some("plan") => Some("plan".to_string()),
        _ => vault::fm_get(&text, "permission_mode").filter(|s| !s.is_empty()),
    };
    let model = opts.model.or_else(|| vault::fm_get(&text, "model")).filter(|s| !s.is_empty());
    let use_worktree = opts.worktree.unwrap_or_else(|| vault::fm_get(&text, "worktree").as_deref() != Some("false"));

    // A project that is a git repo gets its own worktree, unless the note says `worktree: false`.
    let worktree = match &project {
        Some(proj) if use_worktree => match git::repo_root(&vault::expand_home(proj)) {
            Some(repo) => {
                let carry = vault::fm_get(&text, "carry_changes").as_deref() == Some("true");
                let wanted = vault::fm_get(&text, "branch");
                let branch = git::branch_name(&repo, wanted.as_deref(), &session_id)?;
                progress(&app, if carry { "Creating a worktree with your changes…" } else { "Creating a worktree…" });
                Some(git::create(&repo, &session_id, &branch, carry)?)
            }
            None => None,
        },
        _ => None,
    };

    let (origin, title, prompt, text) = if vault::fm_get(&text, "type").as_deref() == Some("request") {
        let (id, t) = vault::ensure_id(&text);
        let t = vault::fm_set(&t, "status", "running");
        let t = vault::fm_push(&t, "sessions", &session_id);
        let title = vault::fm_get(&t, "title").unwrap_or_else(|| rel.clone());
        let body = vault::split_frontmatter(&t).1;
        // The result block is marq's own output, so it is not sent back as instructions.
        let body = body.split("\n## Result").next().unwrap_or(body).trim().to_string();
        let prompt = format!("{body}{}{}", render_context(&v, &t), ask_suffix(opts.intent.as_deref(), opts.instruction.as_deref()));
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
        worktree,
        crew: None,
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
                    let rel = p.strip_prefix(vault).unwrap_or(&p).to_string_lossy().into_owned();
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
    blocking(move || start_from_note(app, &vault, &path, line, options.unwrap_or_default())).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewTask {
    title: String,
    prompt: String,
    project: String,
    permission_mode: Option<String>,
    /// See `SessionMeta::model`.
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    carry_changes: bool,
    /// False: run in the project itself instead of a new worktree.
    #[serde(default = "yes")]
    worktree: bool,
    /// The user left the title empty: name the task with a small model, keeping `title` as the fallback.
    #[serde(default)]
    auto_title: bool,
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
#[tauri::command]
async fn new_task(app: AppHandle, vault: String, mut task: NewTask) -> Result<Started> {
    if task.auto_title {
        task.title = auto_title(&app, &task.prompt, task.title, task.model.as_deref()).await;
    }
    blocking(move || create_task(app, &vault, task)).await
}

fn create_task(app: AppHandle, vault: &str, task: NewTask) -> Result<Started> {
    let rel = write_request(vault, task)?;
    start_from_note(app, vault, &rel, 0, RunOptions::default())
}

/// Writes the task as a request note (`status: todo`) and returns its path relative to the vault.
fn write_request(vault: &str, task: NewTask) -> Result<String> {
    let NewTask { title, prompt, project, permission_mode, model, carry_changes, worktree, .. } = task;
    let v = Path::new(vault);
    let rel = vault::unique_path(v, "requests", &title);
    std::fs::create_dir_all(v.join("requests"))?;
    let now = vault::now();
    let mut mode = permission_mode.filter(|m| !m.is_empty()).map(|m| format!("permission_mode: {m}\n")).unwrap_or_default();
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        mode.push_str(&format!("model: {m}\n"));
    }
    if !worktree {
        mode.push_str("worktree: false\n");
    } else if carry_changes {
        mode.push_str("carry_changes: true\n");
    }
    let q = |s: &str| serde_json::to_string(s).unwrap();
    let content = format!(
        "---\nid: {}\ntype: request\ntitle: {}\ncreated: {now}\nupdated: {now}\nstatus: todo\nproject: {project}\n{mode}sessions: []\n---\n## Request\n\n{}\n",
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

/// Runs one request on several models at once, each session in its own worktree, to compare the results.
#[tauri::command]
async fn new_task_compare(app: AppHandle, vault: String, mut task: NewTask, models: Vec<String>) -> Result<StartedCompare> {
    if !(2..=4).contains(&models.len()) {
        return Err(error::Error::Other("compare needs 2 to 4 models".into()));
    }
    let in_repo = task.worktree && git::repo_root(&vault::expand_home(&task.project)).is_some();
    if !in_repo {
        return Err(error::Error::Other(
            "comparing needs a git repository and a new worktree, so the runs do not overwrite each other".into(),
        ));
    }
    if task.auto_title {
        task.title = auto_title(&app, &task.prompt, task.title, None).await;
    }
    // Each session gets its model from the options below, not from the note.
    task.model = None;
    blocking(move || {
        let request = write_request(&vault, task)?;
        let mut sessions = vec![];
        for model in models {
            let opts = RunOptions { model: Some(model), ..Default::default() };
            sessions.push(start_from_note(app.clone(), &vault, &request, 0, opts)?);
        }
        Ok(StartedCompare { request, sessions })
    })
    .await
}

/// Saves the new-task dialog as a request note without running it. It waits in the Inbox.
#[tauri::command]
async fn save_task(app: AppHandle, vault: String, mut task: NewTask) -> Result<String> {
    if task.auto_title {
        task.title = auto_title(&app, &task.prompt, task.title, task.model.as_deref()).await;
    }
    blocking(move || write_request(&vault, task)).await
}

/// The session's worktree, with the branch that is checked out now.
fn worktree_of(vault: &str, session_id: &str) -> Result<git::Worktree> {
    claude::current_worktree(Path::new(vault), session_id)?
        .ok_or_else(|| error::Error::Other("this session has no worktree".into()))
}

#[tauri::command]
async fn session_changes(vault: String, session_id: String) -> Result<git::Changes> {
    blocking(move || git::changes(&worktree_of(&vault, &session_id)?)).await
}

#[tauri::command]
async fn session_file_diff(vault: String, session_id: String, file: String) -> Result<String> {
    blocking(move || git::file_diff(&worktree_of(&vault, &session_id)?, &file)).await
}

#[tauri::command]
async fn session_commit(vault: String, session_id: String, message: String) -> Result<String> {
    blocking(move || git::commit_all(&worktree_of(&vault, &session_id)?, &message)).await
}

#[tauri::command]
async fn session_push(vault: String, session_id: String) -> Result<String> {
    blocking(move || git::push(&worktree_of(&vault, &session_id)?)).await
}

/// Pushes the current branch of a session that ran in its project, without a worktree.
#[tauri::command]
async fn session_push_cwd(vault: String, session_id: String) -> Result<String> {
    blocking(move || {
        let meta = claude::meta(Path::new(&vault), &session_id)?;
        let repo = git::repo_root(&vault::expand_home(&meta.cwd))
            .ok_or_else(|| error::Error::Other(format!("{} is not a git repository", meta.cwd)))?;
        git::push_dir(&repo)
    })
    .await
}

#[tauri::command]
async fn session_create_pr(app: AppHandle, vault: String, session_id: String, message: String) -> Result<String> {
    blocking(move || {
        let meta = claude::meta(Path::new(&vault), &session_id)?;
        let wt = worktree_of(&vault, &session_id)?;
        let footer = format!("Created from Marq session `{session_id}`.");
        let (title, body) = git::pr_text(&message, &meta.title, &footer);
        let url = git::create_pr(&wt, &title, &body)?;
        // A session with an open PR is reviewed there, so it leaves Needs review.
        let _ = claude::set_review(Path::new(&vault), &session_id, "pr", Some(&url));
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
        if let Some(path) = claude::set_review(Path::new(&vault), &session_id, &state, None)? {
            let _ = app.emit("vault://changed", serde_json::json!({"path": path}));
        }
        let _ = app.emit("sessions://changed", &session_id);
        Ok(())
    })
    .await
}

/// Renames the session's branch and records it in the session log.
#[tauri::command]
async fn session_rename_branch(app: AppHandle, vault: String, session_id: String, branch: String) -> Result<git::Worktree> {
    blocking(move || {
        let wt = git::rename_branch(&worktree_of(&vault, &session_id)?, &branch)?;
        claude::update_worktree(Path::new(&vault), &session_id, &wt)?;
        let _ = app.emit("sessions://changed", &session_id);
        Ok(wt)
    })
    .await
}

#[tauri::command]
async fn session_remove_worktree(vault: String, session_id: String) -> Result<()> {
    blocking(move || git::remove(&worktree_of(&vault, &session_id)?)).await
}

/// Opens a path in Finder or VS Code, or reveals a file in Finder.
#[tauri::command]
async fn open_in(path: String, app: String) -> Result<()> {
    blocking(move || open_with(&path, &app)).await
}

fn open_with(path: &str, app: &str) -> Result<()> {
    let mut cmd = std::process::Command::new("open");
    match app {
        "vscode" => cmd.args(["-a", "Visual Studio Code"]),
        "reveal" => cmd.arg("-R"),
        _ => &mut cmd,
    };
    cmd.arg(vault::expand_home(path)).status()?;
    Ok(())
}

#[tauri::command]
async fn search_text(vault: String, query: String, include_sessions: bool) -> Result<Vec<vault::SearchHit>> {
    blocking(move || Ok(vault::grep(Path::new(&vault), &query, include_sessions, 200, 20))).await
}

/// Saves a query as `queries/<name>.md`: a note whose mq block runs in the preview too. Overwrites.
#[tauri::command]
fn save_query(app: AppHandle, vault: String, name: String, query: String, glob: String, aggregate: bool) -> Result<String> {
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
    let content = format!(
        "---\ntype: query\ntitle: {}\nglob: {}\naggregate: {aggregate}\nupdated: {}\n---\n# {name}\n\n```mq input={up}{glob}{flags}\n{}\n```\n",
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
    let p = boards::create(Path::new(&vault), &name)?;
    let _ = app.emit("vault://changed", serde_json::json!({"path": p}));
    Ok(p.to_string_lossy().into_owned())
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

#[tauri::command]
async fn probe_url(app: AppHandle, url: String) -> Result<serde_json::Value> {
    app.state::<Runner>().probe_url(&app, &url).await
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
        for s in claude::list(Path::new(&vault), None) {
            let p = s.meta.worktree.as_ref().map(|w| w.repo.clone()).unwrap_or(s.meta.cwd);
            if p != vault && !seen.contains(&p) {
                seen.push(p);
            }
        }
        Ok(seen)
    })
    .await
}

#[tauri::command]
async fn send_message(app: AppHandle, vault: String, session_id: String, text: String) -> Result<()> {
    blocking(move || {
        let v = PathBuf::from(&vault);
        let meta = claude::meta(&v, &session_id)?;
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
        let events = claude::read_events(&v, &session_id)?;
        let meta = claude::meta(&v, &session_id)?;
        if !std::path::Path::new(&vault::expand_home(&meta.cwd)).is_dir() {
            return Err(error::Error::Other(format!("the working directory no longer exists: {}", meta.cwd)));
        }
        if claude::has_conversation(&events) {
            runner.start(app.clone(), v, meta, CONTINUE_PROMPT.into(), Turn::Resume)
        } else {
            let prompt = claude::first_prompt(&events).ok_or_else(|| error::Error::Other("no prompt to retry".into()))?;
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
) -> Result<()> {
    runner.answer(&app, &request_id, allow, always, message)
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
        (None, Some(id)) => claude::meta(Path::new(&vault), id).map(|m| m.cwd).unwrap_or_else(|_| vault.clone()),
        (None, None) => vault.clone(),
    };
    let runner = app.state::<Runner>();
    runner.commands(&app, &cwd, session_id.as_deref()).await
}

/// Fills in `## Summary` and `## Learnings` from a forked one-turn summary.
#[tauri::command]
async fn summarize_session(app: AppHandle, vault: String, session_id: String) -> Result<String> {
    let runner = app.state::<Runner>();
    runner.summarize(&app, Path::new(&vault), &session_id).await
}

#[tauri::command]
fn session_events(vault: String, session_id: String) -> Result<Vec<serde_json::Value>> {
    claude::read_events(Path::new(&vault), &session_id)
}

/// Lists sessions. One still marked running without a live process (e.g. after a crash) is
/// recorded as interrupted, so it can be resumed or deleted.
#[tauri::command]
async fn list_sessions(app: AppHandle, vault: String, origin: Option<String>) -> Result<Vec<SessionInfo>> {
    blocking(move || {
        let runner = app.state::<Runner>();
        let v = Path::new(&vault);
        let mut list = claude::list(v, origin.as_deref());
        for s in list.iter_mut().filter(|s| s.status == "running" && !runner.is_alive(&s.meta.id)) {
            if claude::mark_interrupted(v, &s.meta.id).is_ok() {
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
    let meta = claude::meta(v, session_id)?;
    let runner = app.state::<Runner>();
    if runner.is_alive(session_id) {
        progress(app, "Stopping the session…");
        runner.stop(app, session_id)?;
    }
    // The branch may have been renamed in the worktree, so delete the one checked out now.
    let current = if delete_branch { claude::current_worktree(v, session_id).ok().flatten() } else { None };
    if let Some(wt) = current.as_ref().or(meta.worktree.as_ref()) {
        if remove_worktree || delete_branch {
            progress(app, "Removing the worktree…");
            git::remove(wt)?;
        }
        if delete_branch {
            git::delete_branch(wt)?;
        }
    }
    progress(app, "Moving files to the Trash…");
    if let Some(path) = claude::delete(v, session_id)? {
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
        let from = v.join(&from).strip_prefix(v).map(|p| p.to_string_lossy().into_owned()).unwrap_or(from);
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
async fn new_crew(app: AppHandle, vault: String, title: String, prompt: String, project: String, auto_title: bool) -> Result<StartedCrew> {
    let title = if auto_title { self::auto_title(&app, &prompt, title, None).await } else { title };
    blocking(move || {
        progress(&app, "Starting the crew…");
        let c = crew::start(&app, Path::new(&vault), &title, &prompt, &project)?;
        Ok(StartedCrew { rel: c.rel, title: c.title })
    })
    .await
}

/// Adds a task to the crew's task list as the user.
#[tauri::command]
async fn crew_task_add(app: AppHandle, vault: String, crew_id: String, title: String, owner: Option<String>) -> Result<tasks::Task> {
    blocking(move || crew::task_add(&app, Path::new(&vault), &crew_id, crew::USER, &title, owner.as_deref(), None)).await
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
    let Ok(meta) = claude::meta(&v, session_id) else { return Ok(None) };
    let Some(path) = claude::find_origin(&v, &meta) else { return Ok(None) };
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
    let submenu = if cfg!(target_os = "macos") {
        menu.items()?.into_iter().next().and_then(|i| i.as_submenu().cloned())
    } else {
        menu.get(HELP_SUBMENU_ID).and_then(|i| i.as_submenu().cloned())
    };
    if let Some(sub) = submenu {
        sub.remove_at(0)?;
        sub.prepend(&about)?;
    }
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

pub fn run() {
    tauri::Builder::default()
        .menu(app_menu)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Runner::default())
        .manage(terminal::Terminals::default())
        .setup(|app| {
            // Resolving `claude` and `node` through the login shell and starting Node take a few
            // seconds, so do it now instead of on the first run.
            let handle = app.handle().clone();
            std::thread::spawn(move || sidecar::prewarm(&handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ollama_models,
            probe_url,
            save_query,
            search_text,
            board_create,
            board_read,
            board_add,
            board_update,
            board_remove,
            board_list,
            read_config,
            config_path,
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
            summarize_session,
            list_commands,
            session_events,
            list_sessions,
            session_origin,
            new_task,
            save_task,
            new_task_compare,
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
            list_dirs,
            create_folder,
            move_path,
            open_in,
            recent_projects,
            crew_state,
            crew_send,
            crew_release,
            crew_kick_off,
            crew_task_add,
            crew_task_update,
            new_crew,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
