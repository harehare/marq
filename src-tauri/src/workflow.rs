//! Workflows on top of requests: checking the work after each turn, phases, specs and the sandbox.
//!
//! Everything is set in the request note's frontmatter:
//!
//! ```markdown
//! ---
//! type: request
//! verify: pnpm check          # run after each turn in the session's directory; exit 0 passes
//! verify_retries: 3           # failed checks sent back to the agent before giving up (default 2)
//! verify_retry: fresh         # retry in a new session on the same worktree instead of the same one
//! verify_timeout: 10m
//! verify_model: opus          # the acceptance check's model
//! phases: [research, plan, implement]
//! phase_gate: auto            # start the next phase on its own (default: wait for the user)
//! sandbox: strict             # on | strict
//! ---
//! ## Request
//! …
//! ## Acceptance
//! - criteria the implementing agent does not get in its prompt; a separate session checks them
//! ```
//!
//! When a session's turn ends, `on_turn_end` runs the check. A failure goes back to the agent (or to a
//! new session) until it passes or the retries run out; then the session is *settled* and
//! `workflow://settled` tells `automation` the session's first turn is settled. A request with phases runs each phase
//! in a new session on the same worktree, and saves each phase's reply in `phases/` for the next one.
//!
//! Log lines: `marq_verify` (a check started, passed or failed) and `marq_phase` (a phase finished).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{Error, Result};
use crate::session::{self, SessionMeta};
use crate::sidecar::{Runner, Turn};
use crate::{boards, shell, vault, RunOptions};

// ---- sandbox ----

/// `on` or `strict` from a note's `sandbox:`; None leaves Claude Code's own settings alone.
pub fn sandbox_of(text: &str) -> Option<String> {
    normalize_sandbox(vault::fm_get(text, "sandbox").as_deref())
}

pub fn normalize_sandbox(v: Option<&str>) -> Option<String> {
    match v.map(|s| s.trim().to_lowercase()).as_deref() {
        Some("on" | "true" | "yes") => Some("on".into()),
        Some("strict") => Some("strict".into()),
        _ => None,
    }
}

/// The sandbox for sessions nobody watches start (schedules): `[sandbox] unattended`
/// in config.toml.
pub fn unattended_sandbox() -> Option<String> {
    crate::config::read().ok().and_then(|c| normalize_sandbox(c["sandbox"]["unattended"].as_str()))
}

// ---- sections ----

/// The `## ` sections of a Markdown body: (heading, first line, end line), code fences skipped.
fn h2_sections(body: &str) -> Vec<(String, usize, usize)> {
    let lines: Vec<&str> = body.lines().collect();
    let mut fence = false;
    let mut heads = vec![];
    for (i, l) in lines.iter().enumerate() {
        if l.trim_start().starts_with("```") {
            fence = !fence;
        }
        if !fence && (l.starts_with("## ") || l.starts_with("# ")) {
            heads.push((i, l.starts_with("## ").then(|| l[3..].trim().to_string())));
        }
    }
    heads
        .iter()
        .enumerate()
        .filter_map(|(n, (i, h))| Some((h.clone()?, *i, heads.get(n + 1).map_or(lines.len(), |(j, _)| *j))))
        .collect()
}

/// The body of the `## <name>` section, without its heading; None when missing or empty.
pub fn section(body: &str, name: &str) -> Option<String> {
    let lines: Vec<&str> = body.lines().collect();
    let (_, start, end) = h2_sections(body).into_iter().find(|(h, ..)| h.eq_ignore_ascii_case(name))?;
    let text = lines[start + 1..end].join("\n").trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The body without the `## ` sections named in `names`.
pub fn without_sections(body: &str, names: &[&str]) -> String {
    let lines: Vec<&str> = body.lines().collect();
    let cut: Vec<(usize, usize)> = h2_sections(body)
        .into_iter()
        .filter(|(h, ..)| names.iter().any(|n| h.eq_ignore_ascii_case(n)))
        .map(|(_, s, e)| (s, e))
        .collect();
    lines
        .iter()
        .enumerate()
        .filter(|(i, _)| !cut.iter().any(|(s, e)| i >= s && i < e))
        .map(|(_, l)| *l)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

// ---- verify ----

/// How a request's work is checked; see the module docs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Verify {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// The `## Acceptance` section, checked by a separate session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance: Option<String>,
    pub retries: u32,
    /// Retry in a new session on the same worktree, with a fresh context.
    #[serde(default)]
    pub fresh: bool,
    pub timeout_secs: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Failed checks in earlier sessions of the same run (fresh retries).
    #[serde(default)]
    pub attempt: u32,
}

const DEFAULT_RETRIES: u32 = 2;
const MAX_RETRIES: u32 = 20;
const DEFAULT_TIMEOUT: u64 = 600;
/// Most of a check's output that goes back to the agent and into the log.
const OUTPUT_TAIL: usize = 6000;

/// `90`, `90s`, `10m` or `1h`, in seconds.
fn parse_secs(s: &str) -> Option<u64> {
    let s = s.trim();
    let split = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let n: u64 = s[..split].parse().ok()?;
    let secs = match s[split..].trim() {
        "" | "s" => n,
        "m" | "min" => n * 60,
        "h" => n * 3600,
        _ => return None,
    };
    (secs > 0).then_some(secs)
}

/// The check a request asks for, or None.
pub fn verify_of(text: &str) -> Option<Verify> {
    let get = |k: &str| vault::fm_get(text, k).filter(|v| !v.trim().is_empty());
    let command = get("verify");
    let acceptance = section(vault::split_frontmatter(text).1, "Acceptance");
    if command.is_none() && acceptance.is_none() {
        return None;
    }
    Some(Verify {
        command,
        acceptance,
        retries: get("verify_retries").and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_RETRIES).min(MAX_RETRIES),
        fresh: get("verify_retry").as_deref() == Some("fresh"),
        timeout_secs: get("verify_timeout").and_then(|v| parse_secs(&v)).unwrap_or(DEFAULT_TIMEOUT),
        model: get("verify_model"),
        attempt: 0,
    })
}

/// Checks this session failed so far.
fn failures(events: &[Value]) -> u32 {
    events.iter().filter(|e| e["type"] == "marq_verify" && e["passed"] == false).count() as u32
}

fn log(app: &AppHandle, vault: &Path, id: &str, line: Value) -> Result<()> {
    session::append(&session::raw_path(vault, id), &line)?;
    let _ = app.emit("session://event", json!({"session_id": id, "event": line}));
    session::rerender(vault, id)
}

fn tail(s: &str) -> String {
    let s = s.trim_end();
    if s.len() <= OUTPUT_TAIL {
        return s.to_string();
    }
    let mut start = s.len() - OUTPUT_TAIL;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…\n{}", &s[start..])
}

/// A sandbox-exec profile like Claude Code's sandbox: writes only in the directory and temp
/// folders, no network but localhost, no SSH or cloud credentials.
fn sandbox_profile(cwd: &Path, others: &[PathBuf]) -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let q = |p: &Path| serde_json::to_string(&p.to_string_lossy()).unwrap();
    format!(
        r#"(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:*") (remote unix-socket))
(allow network-bind network-inbound (local ip "localhost:*"))
(deny file-write*)
(allow file-write* (subpath {cwd}){others} (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/tty"))
(deny file-read* (subpath {ssh}) (subpath {aws}) (subpath {gcloud}))
"#,
        cwd = q(cwd),
        others = others.iter().map(|p| format!(" (subpath {})", q(&p.canonicalize().unwrap_or(p.clone())))).collect::<String>(),
        ssh = q(&home.join(".ssh")),
        aws = q(&home.join(".aws")),
        gcloud = q(&home.join(".config/gcloud")),
    )
}

/// Runs the check in `cwd` with the shell's PATH. Returns whether it exited 0, and its output.
/// The command runs code from the worktree the agent changed (a package script, a Makefile), so a
/// sandboxed session's check runs sandboxed too.
fn run_check(command: &str, cwd: &Path, others: &[PathBuf], timeout: Duration, sandboxed: bool) -> (bool, String) {
    let out_path = std::env::temp_dir().join(format!("marq-verify-{}.log", vault::new_id()));
    let Ok(out) = std::fs::File::create(&out_path) else { return (false, "could not create a file for the output".into()) };
    let Ok(err) = out.try_clone() else { return (false, "could not create a file for the output".into()) };
    let mut cmd = if sandboxed && cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("/usr/bin/sandbox-exec");
        c.args(["-p", &sandbox_profile(&cwd.canonicalize().unwrap_or(cwd.to_path_buf()), others), "/bin/sh", "-c", command]);
        c
    } else {
        shell::system_command(command)
    };
    cmd.current_dir(cwd).env("PATH", shell::path()).env("CI", "1").stdin(Stdio::null()).stdout(out).stderr(err);
    if sandboxed {
        // A proxy on localhost would be a way out of the sandbox's network rules.
        for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] {
            cmd.env_remove(k);
        }
    }
    let started = Instant::now();
    let result = match cmd.spawn() {
        Err(e) => Err(format!("could not run the check: {e}")),
        Ok(mut child) => loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status.success()),
                Ok(None) if started.elapsed() > timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(format!("the check did not finish in {}s and was stopped", timeout.as_secs()));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(200)),
                Err(e) => break Err(e.to_string()),
            }
        },
    };
    let output = std::fs::read_to_string(&out_path).unwrap_or_default();
    let _ = std::fs::remove_file(&out_path);
    let note = if sandboxed && !cfg!(target_os = "macos") { "\n(the check ran without a sandbox: it is only available on macOS)" } else { "" };
    match result {
        Ok(ok) => (ok, format!("{}{note}", tail(&output))),
        Err(e) => (false, format!("{}\n{e}{note}", tail(&output))),
    }
}

/// Called when a session's turn ends (not for crew members). Checks the work, starts the next phase
/// or settles the session.
pub fn on_turn_end(app: &AppHandle, vault: &Path, id: &str) {
    if let Err(e) = turn_ended(app, vault, id) {
        eprintln!("marq: checking {id} failed: {e}");
        if let Ok(meta) = session::meta(vault, id) {
            let _ = settle(app, vault, &meta, "failed", Some(&format!("⚠ marq could not check the work: {e}")));
        }
    }
}

fn turn_ended(app: &AppHandle, vault: &Path, id: &str) -> Result<()> {
    let meta = session::meta(vault, id)?;
    if meta.crew.is_some() {
        return Ok(());
    }
    let events = session::read_events(vault, id)?;
    if let Some(target) = &meta.verifies {
        return verdict(app, vault, &meta, target, &events);
    }
    let failed_turn = events.iter().rev().find(|e| e["type"] == "turn_end").is_some_and(|e| e["is_error"] == true);
    if failed_turn {
        return settle(app, vault, &meta, "failed", Some("⚠ The turn ended with an error"));
    }
    let Some(v) = meta.verify.clone() else { return settle(app, vault, &meta, "done", None) };
    let attempt = v.attempt + failures(&events) + 1;
    if let Some(command) = &v.command {
        log(app, vault, id, json!({"type": "marq_verify", "stage": "command", "command": command, "status": "running", "at": vault::now()}))?;
        let cwd = vault::expand_home(&meta.cwd);
        let others: Vec<PathBuf> = meta.dirs.iter().map(|d| PathBuf::from(&d.path)).collect();
        let (passed, output) = run_check(command, &cwd, &others, Duration::from_secs(v.timeout_secs), meta.sandbox.is_some());
        log(
            app,
            vault,
            id,
            json!({"type": "marq_verify", "stage": "command", "command": command, "passed": passed, "output": output,
                   "attempt": attempt, "of": v.retries + 1, "at": vault::now()}),
        )?;
        if !passed {
            let feedback = format!("The check `{command}` failed. Its output:\n\n```text\n{output}\n```");
            return retry(app, vault, &meta, &v, attempt, &feedback);
        }
    }
    match &v.acceptance {
        Some(criteria) => start_acceptance(app, vault, &meta, &v, criteria),
        None => settle(app, vault, &meta, "passed", None),
    }
}

/// Sends a failed check back: to the same session, or to a new one on the same worktree.
fn retry(app: &AppHandle, vault: &Path, meta: &SessionMeta, v: &Verify, attempt: u32, feedback: &str) -> Result<()> {
    if attempt > v.retries {
        let note = format!("⚠ The check still failed after {attempt} attempts");
        return settle(app, vault, meta, "failed", Some(&note));
    }
    let message = format!(
        "marq checked the work after your turn and it did not pass (attempt {attempt} of {}).\n\n{feedback}\n\n\
         Fix the cause, then finish the task. Do not weaken or skip the check to make it pass.",
        v.retries + 1
    );
    if !v.fresh {
        return app.state::<Runner>().start(app.clone(), vault.to_path_buf(), meta.clone(), message, Turn::Resume);
    }
    // A new iteration with a fresh context: the same request, the same worktree, and only the
    // last failure carried over.
    let origin = session::find_origin(vault, meta).ok_or_else(|| Error::Other("the request note is gone".into()))?;
    let rel = origin.strip_prefix(vault).unwrap_or(&origin).to_string_lossy().into_owned();
    let opts = RunOptions {
        worktree: Some(meta.worktree.is_some()),
        reuse: meta.worktree.clone(),
        reuse_dirs: Some(meta.dirs.clone()),
        verify: Some(Verify { attempt, ..v.clone() }),
        previous: Some(message),
        ..Default::default()
    };
    let started = crate::start_from_note(app.clone(), &vault.to_string_lossy(), &rel, 0, opts)?;
    handoff(app, vault, &meta.id, &started.session_id, "retry")
}

/// Records that `to` carries on `from`'s work, so what started `from` follows it.
fn handoff(app: &AppHandle, vault: &Path, from: &str, to: &str, why: &str) -> Result<()> {
    log(app, vault, from, json!({"type": "marq_verify", "stage": "handoff", "session": to, "why": why, "at": vault::now()}))?;
    let _ = app.emit("workflow://handoff", json!({"from": from, "to": to}));
    let _ = app.emit("sessions://changed", to);
    Ok(())
}

const VERDICT_PASS: &str = "VERDICT: PASS";
const VERDICT_FAIL: &str = "VERDICT: FAIL";

/// The acceptance check's verdict: the last `VERDICT:` line in its reply.
fn parse_verdict(reply: &str) -> Option<bool> {
    reply.lines().rev().find_map(|l| {
        let l = l.trim().trim_matches(['*', '`', '_']).trim().to_uppercase();
        if l.starts_with(VERDICT_PASS) {
            Some(true)
        } else if l.starts_with(VERDICT_FAIL) {
            Some(false)
        } else {
            None
        }
    })
}

/// The request's task as the implementing agent got it: the body without Acceptance or Result.
fn task_text(note: &str) -> String {
    without_sections(vault::split_frontmatter(note).1, &["Acceptance", "Result"])
}

/// Starts a separate session that checks the work against the acceptance criteria.
fn start_acceptance(app: &AppHandle, vault: &Path, meta: &SessionMeta, v: &Verify, criteria: &str) -> Result<()> {
    let note = session::find_origin(vault, meta).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let branch = meta.worktree.as_ref().map(|w| format!(" (branch {})", w.branch)).unwrap_or_default();
    let prompt = format!(
        "You are checking another agent's work against acceptance criteria it was not shown. Its work is in the \
         current directory{branch}.\n\nThe task it was given:\n\n<task>\n{}\n</task>\n\nThe acceptance criteria:\n\n\
         <acceptance>\n{criteria}\n</acceptance>\n\nCheck every criterion: read the changes (git diff against the \
         base), run the tests or the program where that helps. Do not change any files. Describe what fails as \
         observed behaviour, so the implementer can fix it without copying the criteria. End your reply with one \
         line: `{VERDICT_PASS}` when every criterion holds, otherwise `{VERDICT_FAIL}`.",
        task_text(&note)
    );
    let check = SessionMeta {
        id: vault::new_id(),
        title: format!("{} · acceptance", meta.title),
        origin: meta.origin.clone(),
        origin_path: meta.origin_path.clone(),
        cwd: meta.cwd.clone(),
        started: vault::now(),
        permission_mode: meta.permission_mode.clone(),
        model: v.model.clone().or_else(|| meta.model.clone()),
        agent: meta.agent.clone(),
        effort: meta.effort.clone(),
        sandbox: meta.sandbox.clone(),
        verifies: Some(meta.id.clone()),
        ..Default::default()
    };
    let check_id = check.id.clone();
    log(app, vault, &meta.id, json!({"type": "marq_verify", "stage": "acceptance", "status": "running", "session": check_id, "at": vault::now()}))?;
    app.state::<Runner>().start(app.clone(), vault.to_path_buf(), check, prompt, Turn::New)?;
    let _ = app.emit("sessions://changed", &check_id);
    Ok(())
}

/// The acceptance check finished: pass settles the checked session, fail sends the reasons back.
fn verdict(app: &AppHandle, vault: &Path, check: &SessionMeta, target: &str, events: &[Value]) -> Result<()> {
    let meta = session::meta(vault, target)?;
    let target_events = session::read_events(vault, target)?;
    // Only the check the target is waiting for counts: a later turn of this session (a follow-up
    // from the user) does not send the work back again.
    let waiting = target_events.iter().rev().find(|e| e["type"] == "marq_verify" && e["stage"] == "acceptance");
    if !waiting.is_some_and(|e| e["status"] == "running" && e["session"] == check.id.as_str()) {
        return Ok(());
    }
    let reply = session::last_result(events).unwrap_or("").trim().to_string();
    let passed = parse_verdict(&reply);
    let v = meta.verify.clone().unwrap_or_default();
    let attempt = v.attempt + failures(&target_events) + 1;
    let passed_bool = passed == Some(true);
    log(
        app,
        vault,
        target,
        json!({"type": "marq_verify", "stage": "acceptance", "passed": passed_bool, "session": check.id, "output": reply,
               "attempt": attempt, "of": v.retries + 1, "at": vault::now()}),
    )?;
    if passed_bool {
        return settle(app, vault, &meta, "passed", None);
    }
    let reasons: String = reply.lines().filter(|l| parse_verdict(l).is_none()).collect::<Vec<_>>().join("\n");
    let feedback = match passed {
        Some(_) => format!("A separate acceptance check found problems:\n\n{}", reasons.trim()),
        None => "The acceptance check gave no verdict; check the work against the task again.".to_string(),
    };
    retry(app, vault, &meta, &v, attempt, &feedback)
}

/// The session's work is over for now: records the outcome on the request, moves a phased request on,
/// and tells `automation`.
fn settle(app: &AppHandle, vault: &Path, meta: &SessionMeta, outcome: &str, note: Option<&str>) -> Result<()> {
    if let Some(path) = session::find_origin(vault, meta) {
        let text = std::fs::read_to_string(&path)?;
        let is_request = vault::fm_get(&text, "type").as_deref() == Some("request");
        if is_request && meta.verify.is_some() && outcome != "done" {
            std::fs::write(&path, vault::fm_set(&text, "verified", outcome))?;
            let _ = app.emit("vault://changed", json!({"path": path}));
        }
        if is_request && outcome != "failed" && meta.phase.is_some() && next_phase_of(app, vault, meta, &path)? {
            return Ok(());
        }
    }
    let _ = app.emit("workflow://settled", json!({"session_id": meta.id, "outcome": outcome, "note": note}));
    Ok(())
}

// ---- phases ----

pub fn phases_of(text: &str) -> Vec<String> {
    vault::fm_list(text, "phases").into_iter().map(|p| p.trim().to_lowercase()).filter(|p| !p.is_empty()).collect()
}

/// The phase a new session on the request works on: `phase:`, else the first.
pub fn current_phase(text: &str) -> Option<String> {
    let phases = phases_of(text);
    let set = vault::fm_get(text, "phase").map(|p| p.trim().to_lowercase()).filter(|p| phases.contains(p));
    set.or_else(|| phases.first().cloned())
}

pub fn is_last_phase(text: &str, phase: &str) -> bool {
    phases_of(text).last().map(String::as_str) == Some(phase)
}

/// Where a phase's reply is kept, relative to the vault.
fn phase_doc(request: &Path, phase: &str) -> String {
    let stem = request.file_stem().unwrap_or_default().to_string_lossy();
    format!("phases/{stem}-{}.md", vault::slug(phase))
}

/// What a session on `phase` is told, with the replies of the phases before it.
pub fn phase_prompt(vault: &Path, request: &Path, text: &str, phase: &str) -> String {
    let phases = phases_of(text);
    let all = phases.join(" → ");
    let last = is_last_phase(text, phase);
    let what = match (phase, last) {
        ("research", false) => "Investigate only: read the code, the notes and earlier sessions to learn what the task needs. \
            Do not change any files. End your reply with the findings the next phase needs: the relevant files and how they \
            work, constraints, risks and open questions."
            .to_string(),
        ("plan", false) => "Plan only: using what the earlier phases found, write a step-by-step plan with the files to change \
            and how, in order, and how to check the result. Do not change any files. End your reply with the plan."
            .to_string(),
        (_, false) => format!("Do only the {phase} part of the task. End your reply with what the next phase needs."),
        (_, true) => "Finish the task, building on what the earlier phases found.".to_string(),
    };
    let mut out = format!(
        "\n\n<phase name=\"{phase}\" of=\"{all}\">\nThis task is done in phases, each in a new session: {all}. This session \
         is the {phase} phase. {what}{}\n</phase>",
        if last { "" } else { " Your reply is saved and given to the next phase." }
    );
    for p in phases.iter().take_while(|p| *p != phase) {
        let rel = phase_doc(request, p);
        if let Ok(doc) = std::fs::read_to_string(vault.join(&rel)) {
            let body = vault::split_frontmatter(&doc).1.trim();
            out.push_str(&format!("\n\n<context source=\"{rel}\" phase=\"{p}\">\n{body}\n</context>"));
        }
    }
    out
}

/// After a phase that is not the last: saves its reply and points the request at the next phase,
/// starting it when `phase_gate: auto`. Returns true when a new session took over.
fn next_phase_of(app: &AppHandle, vault: &Path, meta: &SessionMeta, path: &Path) -> Result<bool> {
    let Some(phase) = &meta.phase else { return Ok(false) };
    let text = std::fs::read_to_string(path)?;
    let phases = phases_of(&text);
    let Some(i) = phases.iter().position(|p| p == phase) else { return Ok(false) };
    let Some(next) = phases.get(i + 1) else { return Ok(false) };
    let events = session::read_events(vault, &meta.id)?;
    let Some(reply) = session::last_result(&events).filter(|r| !r.trim().is_empty()) else { return Ok(false) };

    let title = vault::fm_get(&text, "title").unwrap_or_default();
    let rel = phase_doc(path, phase);
    std::fs::create_dir_all(vault.join("phases"))?;
    let req = vault::DocWrite { title: &format!("{title} — {phase}"), content: reply, folder: Some("phases"), path: Some(&rel), tags: &[] };
    let doc = vault::write_doc(vault, req, &meta.id, &meta.origin)?;
    log(app, vault, &meta.id, json!({"type": "marq_doc", "path": doc.rel, "title": doc.title, "created": doc.created}))?;

    // A later turn of an earlier phase updates its document but does not move the request on again.
    if current_phase(&text).as_deref() != Some(phase.as_str()) {
        return Ok(false);
    }
    std::fs::write(path, vault::fm_set(&text, "phase", next))?;
    let auto = vault::fm_get(&text, "phase_gate").as_deref() == Some("auto");
    log(app, vault, &meta.id, json!({"type": "marq_phase", "done": phase, "next": next, "auto": auto, "at": vault::now()}))?;
    let _ = app.emit("vault://changed", json!({"path": path}));
    if !auto {
        return Ok(false);
    }
    let rel = path.strip_prefix(vault).unwrap_or(path).to_string_lossy().into_owned();
    let opts = RunOptions {
        worktree: Some(meta.worktree.is_some()),
        reuse: meta.worktree.clone(),
        reuse_dirs: Some(meta.dirs.clone()),
        ..Default::default()
    };
    let started = crate::start_from_note(app.clone(), &vault.to_string_lossy(), &rel, 0, opts)?;
    handoff(app, vault, &meta.id, &started.session_id, "phase")?;
    Ok(true)
}

/// The request's latest session whose directory is still there, so a later phase works where it did.
pub fn last_run(vault: &Path, text: &str) -> Option<SessionMeta> {
    vault::fm_list(text, "sessions")
        .iter()
        .rev()
        .filter_map(|s| session::meta(vault, s).ok())
        .filter(|m| m.verifies.is_none())
        .find(|m| vault::expand_home(&m.cwd).is_dir())
}

// ---- specs ----

pub const SPEC_FOLDER: &str = "specs";

/// A new spec note's text.
pub fn spec_template(id: &str, title: &str, now: &str) -> String {
    format!(
        "---\nid: {id}\ntype: spec\ntitle: {}\ncreated: {now}\nstatus: draft\nproject: \"\"\nverify: \"\"\nsandbox: \"\"\n---\n\
# {title}\n\n\
## Requirements\n\n\
<!-- What the change must do, one testable statement each, e.g. WHEN the user … THE app SHALL … -->\n\n\
## Design\n\n\
<!-- How: the parts to change, data and interfaces, decisions and why. -->\n\n\
## Tasks\n\n\
<!-- One checklist item per piece of work an agent can do in one session. Break down puts them on a board. -->\n\
- [ ] \n\n\
## Acceptance\n\n\
<!-- How to tell it is done. Not shown to the agents doing the tasks: a separate session checks their work against it. -->\n",
        serde_json::to_string(title).unwrap()
    )
}

/// Writes `specs/<title>.md` from the template.
pub fn new_spec(vault: &Path, title: &str) -> Result<PathBuf> {
    let title = title.trim();
    if title.is_empty() {
        return Err(Error::Other("a spec needs a title".into()));
    }
    let rel = vault::unique_path(vault, SPEC_FOLDER, title);
    std::fs::create_dir_all(vault.join(SPEC_FOLDER))?;
    let path = vault.join(rel);
    std::fs::write(&path, spec_template(&vault::new_id(), title, &vault::now()))?;
    Ok(path)
}

/// Saves a spec an agent wrote (`content` is the body: Requirements, Design, Tasks, Acceptance). With
/// `path`, revises that spec, keeping its frontmatter. Returns the vault-relative path.
pub fn write_spec(vault: &Path, title: &str, content: &str, path: Option<&str>, project: &str, verify: Option<&str>) -> Result<String> {
    let body = vault::split_frontmatter(&format!("{}\n", content.trim())).1.trim().to_string();
    for needed in ["Requirements", "Tasks"] {
        if !h2_sections(&body).iter().any(|(h, ..)| h.eq_ignore_ascii_case(needed)) {
            return Err(Error::Other(format!("a spec needs a ## {needed} section")));
        }
    }
    if let Some(p) = path.filter(|p| !p.trim().is_empty()) {
        let full = vault::resolve(vault, p)?;
        let old = std::fs::read_to_string(&full)?;
        if vault::fm_get(&old, "type").as_deref() != Some("spec") {
            return Err(Error::Other(format!("{p} is not a spec")));
        }
        let fm = vault::split_frontmatter(&old).0.unwrap_or_default();
        std::fs::write(&full, format!("---\n{fm}\n---\n{body}\n"))?;
        return Ok(full.strip_prefix(vault).unwrap_or(&full).to_string_lossy().into_owned());
    }
    let title = title.trim();
    if title.is_empty() {
        return Err(Error::Other("a spec needs a title".into()));
    }
    let rel = vault::unique_path(vault, SPEC_FOLDER, title);
    std::fs::create_dir_all(vault.join(SPEC_FOLDER))?;
    let q = |s: &str| serde_json::to_string(s.trim()).unwrap();
    let body = if body.starts_with("# ") { body } else { format!("# {title}\n\n{body}") };
    let text = format!(
        "---\nid: {}\ntype: spec\ntitle: {}\ncreated: {}\nstatus: draft\nproject: {}\nverify: {}\n---\n{body}\n",
        vault::new_id(),
        q(title),
        vault::now(),
        q(project),
        q(verify.unwrap_or_default()),
    );
    std::fs::write(vault.join(&rel), text)?;
    Ok(rel)
}

/// The top-level checklist items under `## Tasks`: (checked, text).
pub fn spec_tasks(text: &str) -> Vec<(bool, String)> {
    let Some(tasks) = section(vault::split_frontmatter(text).1, "Tasks") else { return vec![] };
    tasks
        .lines()
        .filter_map(|l| {
            let rest = l.strip_prefix("- ").or_else(|| l.strip_prefix("* "))?;
            let (done, t) = match rest.get(..4) {
                Some("[ ] ") => (false, &rest[4..]),
                Some("[x] " | "[X] ") => (true, &rest[4..]),
                _ => (false, rest),
            };
            let t = t.trim();
            (!t.is_empty()).then(|| (done, t.to_string()))
        })
        .collect()
}

/// Puts the spec's open tasks on its board (`board:` in the spec, else a new `boards/<title>.md`)
/// as cards linking back to the spec. Tasks already on the board are skipped. Returns the board
/// and how many cards were added.
pub fn spec_to_board(vault: &Path, spec: &Path) -> Result<(PathBuf, usize)> {
    let text = std::fs::read_to_string(spec)?;
    if vault::fm_get(&text, "type").as_deref() != Some("spec") {
        return Err(Error::Other("not a spec note (type: spec)".into()));
    }
    let tasks: Vec<String> = spec_tasks(&text).into_iter().filter(|(done, _)| !done).map(|(_, t)| t).collect();
    if tasks.is_empty() {
        return Err(Error::Other("the spec has no open items under ## Tasks".into()));
    }
    let title = vault::fm_get(&text, "title").unwrap_or_else(|| spec.file_stem().unwrap_or_default().to_string_lossy().into_owned());
    let existing = vault::fm_get(&text, "board").filter(|b| !b.is_empty()).and_then(|b| vault::resolve(vault, &b).ok()).filter(|p| p.exists());
    let board = match existing {
        Some(p) => p,
        None => {
            let mut name = vault::slug(&title);
            let mut n = 2;
            while vault.join(format!("boards/{name}.md")).exists() {
                name = format!("{}-{n}", vault::slug(&title));
                n += 1;
            }
            let p = boards::create(vault, &name, &[])?;
            let rel = p.strip_prefix(vault).unwrap_or(&p).to_string_lossy().into_owned();
            std::fs::write(spec, vault::fm_set(&std::fs::read_to_string(spec)?, "board", &rel))?;
            p
        }
    };
    let b = boards::read(&board)?;
    let have: Vec<String> = b.lists.iter().flat_map(|l| l.cards.iter().map(|c| c.title.to_lowercase())).collect();
    let board_rel = board.strip_prefix(vault).unwrap_or(&board).to_string_lossy().into_owned();
    let spec_rel = spec.strip_prefix(vault).unwrap_or(spec).to_string_lossy().into_owned();
    let link = crate::automation::link(&board_rel, &format!("Spec: {title}"), &spec_rel);
    let first = b.lists.first().map(|l| l.name.clone());
    let mut added = 0;
    for t in tasks.iter().filter(|t| !have.contains(&t.to_lowercase())) {
        boards::add(&board, t, first.as_deref(), None, Some(&link))?;
        added += 1;
    }
    Ok((board, added))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUEST: &str = "---\ntype: request\nverify: pnpm check\nverify_retries: 3\nverify_retry: fresh\nverify_timeout: 5m\n\
phases: [research, plan, implement]\n---\n## Request\n\nAdd hover types.\n\n```md\n## Acceptance\nnot a heading\n```\n\n\
## Acceptance\n\n- hovering a name shows its type\n\n## Result\n\nold\n";

    #[test]
    fn reads_the_check() {
        let v = verify_of(REQUEST).unwrap();
        assert_eq!(v.command.as_deref(), Some("pnpm check"));
        assert_eq!((v.retries, v.fresh, v.timeout_secs), (3, true, 300));
        assert_eq!(v.acceptance.as_deref(), Some("- hovering a name shows its type"));
        assert_eq!(verify_of("---\ntype: request\n---\n## Request\n\nx\n"), None);
        assert_eq!(verify_of("---\nverify: make\n---\nx\n").unwrap().retries, DEFAULT_RETRIES);
    }

    #[test]
    fn hides_acceptance_from_the_task() {
        let task = task_text(REQUEST);
        assert!(task.contains("Add hover types."));
        assert!(task.contains("not a heading"), "fenced headings stay");
        assert!(!task.contains("hovering a name"));
        assert!(!task.contains("old"));
    }

    #[test]
    fn verdicts() {
        assert_eq!(parse_verdict("all good\n\nVERDICT: PASS"), Some(true));
        assert_eq!(parse_verdict("- x fails\n**VERDICT: FAIL**\n"), Some(false));
        assert_eq!(parse_verdict("VERDICT: FAIL\nthen fixed\nverdict: pass"), Some(true));
        assert_eq!(parse_verdict("no verdict"), None);
    }

    #[test]
    fn durations() {
        assert_eq!(parse_secs("90"), Some(90));
        assert_eq!(parse_secs("10m"), Some(600));
        assert_eq!(parse_secs("1h"), Some(3600));
        assert_eq!(parse_secs("0"), None);
        assert_eq!(parse_secs("1d"), None);
    }

    #[test]
    fn phases() {
        assert_eq!(phases_of(REQUEST), ["research", "plan", "implement"]);
        assert_eq!(current_phase(REQUEST).as_deref(), Some("research"));
        let later = vault::fm_set(REQUEST, "phase", "plan");
        assert_eq!(current_phase(&later).as_deref(), Some("plan"));
        assert_eq!(current_phase(&vault::fm_set(REQUEST, "phase", "nope")).as_deref(), Some("research"));
        assert!(is_last_phase(REQUEST, "implement"));
        let dir = std::env::temp_dir().join(format!("marq-phases-{}", vault::new_id()));
        std::fs::create_dir_all(dir.join("phases")).unwrap();
        std::fs::write(dir.join("phases/r-research.md"), "---\ntype: doc\n---\nfound things\n").unwrap();
        let p = phase_prompt(&dir, &dir.join("requests/r.md"), &later, "plan");
        assert!(p.contains("This session is the plan phase"));
        assert!(p.contains("found things"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn spec_tasks_and_context() {
        let spec = spec_template("s1", "Hover", "2026-11-05T10:00:00+09:00")
            .replace("- [ ] \n", "- [ ] Parse types\n- [x] Done already\n- Show popup\n")
            .replace("verify: \"\"", "verify: cargo test");
        let tasks = spec_tasks(&spec);
        assert_eq!(tasks, [(false, "Parse types".into()), (true, "Done already".into()), (false, "Show popup".into())]);
        let dir = std::env::temp_dir().join(format!("marq-spec-{}", vault::new_id()));
        std::fs::create_dir_all(dir.join("specs")).unwrap();
        let path = dir.join("specs/hover.md");
        std::fs::write(&path, spec.replace("<!-- How to tell it is done. Not shown to the agents doing the tasks: a separate session checks their work against it. -->", "- types show on hover")).unwrap();
        let (board, added) = spec_to_board(&dir, &path).unwrap();
        assert_eq!(added, 2);
        let b = boards::read(&board).unwrap();
        assert_eq!(b.lists[0].cards.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(), ["Parse types", "Show popup"]);
        assert!(b.lists[0].cards[0].notes[0].contains("../specs/hover.md"));
        // Again: nothing new, same board.
        assert_eq!(spec_to_board(&dir, &path).unwrap(), (board, 0));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn runs_checks() {
        let dir = std::env::temp_dir().join(format!("marq-check-{}", vault::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let t = Duration::from_secs(20);
        assert_eq!(run_check("echo fine", &dir, &[], t, false), (true, "fine".to_string()));
        let (ok, out) = run_check("echo broken >&2; exit 3", &dir, &[], t, false);
        assert!(!ok && out.contains("broken"));
        let (ok, out) = run_check("sleep 5", &dir, &[], Duration::from_secs(1), false);
        assert!(!ok && out.contains("did not finish"));
        if cfg!(target_os = "macos") {
            assert!(run_check("echo x > inside.txt", &dir, &[], t, true).0, "writes in the directory are allowed");
            let outside = dirs::home_dir().unwrap().join(format!(".marq-sandbox-test-{}", vault::new_id()));
            let (ok, _) = run_check(&format!("echo x > {}", outside.display()), &dir, &[], t, true);
            assert!(!ok && !outside.exists(), "writes outside the directory are not");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sandbox_values() {
        assert_eq!(sandbox_of("---\nsandbox: strict\n---\n").as_deref(), Some("strict"));
        assert_eq!(sandbox_of("---\nsandbox: true\n---\n").as_deref(), Some("on"));
        assert_eq!(sandbox_of("---\nsandbox: \"\"\n---\n"), None);
    }
}
