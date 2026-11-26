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
//! review: on                  # an independent adversarial review after the checks (default: `[verify] review` in config.toml, off)
//! playbook: bug-fix           # a note in playbooks/ whose sections are the phases and what each is told
//! phases: [research, plan, implement]   # or the phases themselves
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

use crate::vault::PathSlash;
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
    /// `review: on|off` of the request or environment note; None leaves it to `[verify] review` in config.toml.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<bool>,
}

impl Verify {
    /// Whether the independent adversarial review runs: the note's `review:` wins over the config.
    pub fn review_enabled(&self) -> bool {
        self.review.unwrap_or_else(review_default)
    }
}

/// `[verify] review = "on"` in config.toml; off by default.
pub fn review_default() -> bool {
    crate::config::read().ok().is_some_and(|c| review_flag(c["verify"]["review"].as_str()) == Some(true))
}

/// `on`/`off` (and the usual spellings); None for anything else.
fn review_flag(v: Option<&str>) -> Option<bool> {
    match v.map(|s| s.trim().to_lowercase()).as_deref() {
        Some("on" | "true" | "yes") => Some(true),
        Some("off" | "false" | "no") => Some(false),
        _ => None,
    }
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
    verify_with(text, None)
}

/// The check a request asks for. What the request leaves out comes from `default`, the project's
/// environment note, if that is trusted. `verify: off` in the request turns the default command off.
pub fn verify_with(text: &str, default: Option<&Verify>) -> Option<Verify> {
    let get = |k: &str| vault::fm_get(text, k).filter(|v| !v.trim().is_empty());
    let raw = get("verify");
    let off = raw.as_deref().is_some_and(|c| matches!(c.trim().to_lowercase().as_str(), "off" | "none" | "false" | "no"));
    let command = if off { None } else { raw.or_else(|| default.and_then(|d| d.command.clone())) };
    let acceptance = section(vault::split_frontmatter(text).1, "Acceptance");
    if command.is_none() && acceptance.is_none() {
        return None;
    }
    let d = default.cloned().unwrap_or(Verify { retries: DEFAULT_RETRIES, timeout_secs: DEFAULT_TIMEOUT, ..Default::default() });
    Some(Verify {
        command,
        acceptance,
        retries: get("verify_retries").and_then(|v| v.parse().ok()).map_or(d.retries, |n: u32| n.min(MAX_RETRIES)),
        fresh: get("verify_retry").map_or(d.fresh, |v| v == "fresh"),
        timeout_secs: get("verify_timeout").and_then(|v| parse_secs(&v)).unwrap_or(d.timeout_secs),
        model: get("verify_model").or(d.model),
        attempt: 0,
        review: get("review").and_then(|v| review_flag(Some(&v))).or(d.review),
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

/// Called when a session's turn ends. Checks the work, starts the next phase
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
        None => checks_passed(app, vault, &meta, &v),
    }
}

/// The command and acceptance checks passed: an adversarial review follows when it is on,
/// otherwise the session settles as passed.
fn checks_passed(app: &AppHandle, vault: &Path, meta: &SessionMeta, v: &Verify) -> Result<()> {
    if v.review_enabled() {
        start_review(app, vault, meta, v)
    } else {
        settle(app, vault, meta, "passed", None)
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
    let rel = origin.strip_prefix(vault).unwrap_or(&origin).to_slash();
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
        workspace: meta.workspace.clone(),
        fields: meta.fields.clone(),
        ..Default::default()
    };
    let check_id = check.id.clone();
    log(app, vault, &meta.id, json!({"type": "marq_verify", "stage": "acceptance", "status": "running", "session": check_id, "at": vault::now()}))?;
    app.state::<Runner>().start(app.clone(), vault.to_path_buf(), check, prompt, Turn::New)?;
    let _ = app.emit("sessions://changed", &check_id);
    Ok(())
}

/// The adversary's brief: break the change, and prove every finding with a run.
fn review_prompt(task: &str, branch: &str) -> String {
    format!(
        "You are an adversary reviewing another agent's work. Your job is to break it, not to praise it. Its work is in \
         the current directory{branch}.\n\nThe task it was given (the intent):\n\n<task>\n{task}\n</task>\n\n\
         Read the changes (git diff against the base) and try to make them fail against the real code: run the tests and \
         the program, feed it edge cases, bad input and the paths the change did not think of. Do not change any files; \
         write scratch work only to a temporary directory.\n\n\
         Report only a finding you have proven: the exact command you ran, the output it printed, and the output the \
         intent requires. Run each command a second time and drop the finding if it does not reproduce. Leave out style, \
         naming and speculative risks; findings with the same root cause are one finding. \"No findings\" is a valid \
         result.\n\nGive the findings as one fenced `json` block holding an array of objects with the keys `title`, \
         `command`, `output` and `expected` (`[]` when there are none), and add a short note for each dropped finding \
         saying why. End your reply with one line: `{VERDICT_PASS}` when no proven finding remains, otherwise \
         `{VERDICT_FAIL}`."
    )
}

/// Starts a separate read-only session that tries to break the change.
fn start_review(app: &AppHandle, vault: &Path, meta: &SessionMeta, v: &Verify) -> Result<()> {
    let note = session::find_origin(vault, meta).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let branch = meta.worktree.as_ref().map(|w| format!(" (branch {})", w.branch)).unwrap_or_default();
    let prompt = review_prompt(&task_text(&note), &branch);
    let review = SessionMeta {
        id: vault::new_id(),
        title: format!("{} · review", meta.title),
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
        workspace: meta.workspace.clone(),
        fields: meta.fields.clone(),
        ..Default::default()
    };
    let review_id = review.id.clone();
    log(app, vault, &meta.id, json!({"type": "marq_verify", "stage": "review", "status": "running", "session": review_id, "at": vault::now()}))?;
    app.state::<Runner>().start(app.clone(), vault.to_path_buf(), review, prompt, Turn::New)?;
    let _ = app.emit("sessions://changed", &review_id);
    Ok(())
}

/// A check session finished (acceptance or review): pass settles the checked session, fail sends the reasons back.
fn verdict(app: &AppHandle, vault: &Path, check: &SessionMeta, target: &str, events: &[Value]) -> Result<()> {
    let meta = session::meta(vault, target)?;
    let target_events = session::read_events(vault, target)?;
    // Only the check the target is waiting for counts: a later turn of this session (a follow-up
    // from the user) does not send the work back again.
    let waiting = target_events.iter().rev().find(|e| e["type"] == "marq_verify" && matches!(e["stage"].as_str(), Some("acceptance" | "review")));
    if !waiting.is_some_and(|e| e["status"] == "running" && e["session"] == check.id.as_str()) {
        return Ok(());
    }
    let stage = if waiting.is_some_and(|e| e["stage"] == "review") { "review" } else { "acceptance" };
    let reply = session::last_result(events).unwrap_or("").trim().to_string();
    let passed = parse_verdict(&reply);
    let v = meta.verify.clone().unwrap_or_default();
    let attempt = v.attempt + failures(&target_events) + 1;
    let passed_bool = passed == Some(true);
    log(
        app,
        vault,
        target,
        json!({"type": "marq_verify", "stage": stage, "passed": passed_bool, "session": check.id, "output": reply,
               "attempt": attempt, "of": v.retries + 1, "at": vault::now()}),
    )?;
    if passed_bool {
        // An acceptance pass moves on to the review when it is on; a review pass settles.
        return if stage == "acceptance" { checks_passed(app, vault, &meta, &v) } else { settle(app, vault, &meta, "passed", None) };
    }
    let reasons: String = reply.lines().filter(|l| parse_verdict(l).is_none()).collect::<Vec<_>>().join("\n");
    let feedback = match (passed, stage) {
        (Some(_), "review") => format!("A separate adversarial review broke the change:\n\n{}", reasons.trim()),
        (Some(_), _) => format!("A separate acceptance check found problems:\n\n{}", reasons.trim()),
        (None, "review") => "The adversarial review gave no result; try to break the change again and prove what you find.".to_string(),
        (None, _) => "The acceptance check gave no verdict; check the work against the task again.".to_string(),
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

/// What a session on `phase` is told, with the replies of the phases before it. A playbook's
/// section for the phase replaces the built-in instructions.
pub fn phase_prompt(vault: &Path, request: &Path, text: &str, phase: &str) -> String {
    let phases = phases_of(text);
    let all = phases.join(" → ");
    let last = is_last_phase(text, phase);
    let saved = if last { "" } else { " Your reply is saved and given to the next phase." };
    let custom = playbook_of(vault, text).and_then(|b| b.phase(phase).map(|p| p.instructions.clone())).filter(|i| !i.is_empty());
    let what = match (custom, phase, last) {
        (Some(c), _, false) => format!("Do only this phase's part of the task.{saved}\n\n{c}"),
        (Some(c), _, true) => format!("This is the last phase.\n\n{c}"),
        (None, "research", false) => format!(
            "Investigate only: read the code, the notes and earlier sessions to learn what the task needs. \
             Do not change any files. End your reply with the findings the next phase needs: the relevant files and how they \
             work, constraints, risks and open questions.{saved}"
        ),
        (None, "plan", false) => format!(
            "Plan only: using what the earlier phases found, write a step-by-step plan with the files to change \
             and how, in order, and how to check the result. Do not change any files. End your reply with the plan.{saved}"
        ),
        (None, _, false) => format!("Do only the {phase} part of the task. End your reply with what the next phase needs.{saved}"),
        (None, _, true) => "Finish the task, building on what the earlier phases found.".to_string(),
    };
    let mut out = format!(
        "\n\n<phase name=\"{phase}\" of=\"{all}\">\nThis task is done in phases, each in a new session: {all}. This session \
         is the {phase} phase. {what}\n</phase>"
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
    // The request's own gate, else its playbook's.
    let gate = vault::fm_get(&text, "phase_gate").filter(|g| !g.is_empty()).or_else(|| playbook_of(vault, &text).and_then(|b| b.gate));
    let auto = gate.as_deref() == Some("auto");
    log(app, vault, &meta.id, json!({"type": "marq_phase", "done": phase, "next": next, "auto": auto, "at": vault::now()}))?;
    let _ = app.emit("vault://changed", json!({"path": path}));
    if !auto {
        return Ok(false);
    }
    let rel = path.strip_prefix(vault).unwrap_or(path).to_slash();
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

// ---- playbooks ----

pub const PLAYBOOK_FOLDER: &str = "playbooks";

/// Playbooks that come with marq. A note of the same name in `playbooks/` replaces one.
const BUILTIN_PLAYBOOKS: &[(&str, &str)] =
    &[
        ("plan-first", include_str!("playbooks/plan-first.md")),
        ("bug-fix", include_str!("playbooks/bug-fix.md")),
        ("refactor", include_str!("playbooks/refactor.md")),
        ("organize", include_str!("playbooks/organize.md")),
    ];

/// How a kind of task is done: a note in `playbooks/` (`type: playbook`) whose `## ` sections are
/// the phases, in order. A request names one with `playbook:`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Playbook {
    /// The file's name without `.md`: what a request's `playbook:` says.
    pub name: String,
    pub title: String,
    pub description: String,
    /// The text above the first phase, given to every phase.
    pub rules: String,
    pub phases: Vec<PlaybookPhase>,
    /// `phase_gate:` for requests that do not set their own.
    pub gate: Option<String>,
    /// Comes with marq; false for a note in the vault.
    pub builtin: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PlaybookPhase {
    pub name: String,
    /// What the phase's session is told.
    pub instructions: String,
    /// `model:` and `effort:` lines at the top of the section, for this phase's session.
    pub model: Option<String>,
    pub effort: Option<String>,
}

impl Playbook {
    pub fn phase(&self, name: &str) -> Option<&PlaybookPhase> {
        self.phases.iter().find(|p| p.name == name)
    }
}

/// The text without `<!-- -->` comments, which the template uses for hints.
fn without_comments(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        rest = rest[start..].find("-->").map_or("", |end| &rest[start + end + 3..]);
    }
    out.push_str(rest);
    out.trim().to_string()
}

fn parse_phase(name: &str, text: &str) -> PlaybookPhase {
    let mut phase = PlaybookPhase { name: name.trim().to_lowercase(), ..Default::default() };
    let text = without_comments(text);
    let mut lines = text.lines().peekable();
    while let Some(l) = lines.peek() {
        let l = l.trim().trim_start_matches("- ").trim();
        let value = |v: &str| Some(v.trim().trim_matches(['"', '\'', '`']).to_string()).filter(|v| !v.is_empty());
        if let Some(v) = l.strip_prefix("model:") {
            phase.model = value(v);
        } else if let Some(v) = l.strip_prefix("effort:") {
            phase.effort = value(v);
        } else if !l.is_empty() {
            break;
        }
        lines.next();
    }
    phase.instructions = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    phase
}

fn parse_playbook(name: &str, text: &str, builtin: bool) -> Playbook {
    let body = vault::split_frontmatter(text).1;
    let lines: Vec<&str> = body.lines().collect();
    let sections = h2_sections(body);
    let first = sections.first().map_or(lines.len(), |(_, start, _)| *start);
    let rules: Vec<&str> = lines[..first].iter().filter(|l| !l.starts_with("# ")).copied().collect();
    let get = |k: &str| vault::fm_get(text, k).filter(|v| !v.is_empty());
    Playbook {
        name: name.to_string(),
        title: get("title").unwrap_or_else(|| name.to_string()),
        description: get("description").unwrap_or_default(),
        rules: without_comments(&rules.join("\n")),
        phases: sections.iter().map(|(h, start, end)| parse_phase(h, &lines[start + 1..*end].join("\n"))).collect(),
        gate: get("phase_gate"),
        builtin,
    }
}

/// The playbook called `name` (`bug-fix`, `Bug fix` or `playbooks/bug-fix.md`): the vault's, else marq's own.
pub fn playbook(vault: &Path, name: &str) -> Option<Playbook> {
    let stem = name.trim().trim_end_matches(".md").rsplit('/').next().unwrap_or_default();
    [stem.to_string(), vault::slug(stem)].iter().find_map(|n| {
        let own = std::fs::read_to_string(vault.join(PLAYBOOK_FOLDER).join(format!("{n}.md"))).ok();
        own.map(|t| parse_playbook(n, &t, false)).or_else(|| BUILTIN_PLAYBOOKS.iter().find(|(b, _)| b == n).map(|(b, t)| parse_playbook(b, t, true)))
    })
}

/// The playbook a request names with `playbook:`.
pub fn playbook_of(vault: &Path, text: &str) -> Option<Playbook> {
    playbook(vault, &vault::fm_get(text, "playbook").filter(|p| !p.is_empty())?)
}

/// Every playbook a request can name: the vault's, then marq's own that the vault does not replace.
pub fn playbooks(vault: &Path) -> Vec<Playbook> {
    let mut names: Vec<String> = std::fs::read_dir(vault.join(PLAYBOOK_FOLDER))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| Some(e.file_name().to_string_lossy().strip_suffix(".md")?.to_string()))
        .collect();
    names.sort();
    let own: Vec<String> = BUILTIN_PLAYBOOKS.iter().map(|(b, _)| b.to_string()).filter(|b| !names.contains(b)).collect();
    names.extend(own);
    names.iter().filter_map(|n| playbook(vault, n)).collect()
}

/// A request that names a playbook, with the playbook's phases written into `phases:` unless the
/// request lists its own. The list is fixed from then on, so editing the playbook does not move a
/// request that is under way.
pub fn with_playbook_phases(vault: &Path, text: &str) -> Result<String> {
    let Some(name) = vault::fm_get(text, "playbook").filter(|p| !p.is_empty()) else { return Ok(text.to_string()) };
    let book = playbook(vault, &name).ok_or_else(|| Error::Other(format!("there is no playbook named {name} in {PLAYBOOK_FOLDER}/")))?;
    if book.phases.is_empty() || !phases_of(text).is_empty() {
        return Ok(text.to_string());
    }
    let names: Vec<&str> = book.phases.iter().map(|p| p.name.as_str()).collect();
    Ok(vault::fm_set(text, "phases", &format!("[{}]", names.join(", "))))
}

/// The playbook's rules, for every session on a request that names it.
pub fn playbook_prompt(vault: &Path, text: &str) -> String {
    match playbook_of(vault, text).filter(|b| !b.rules.is_empty()) {
        Some(b) => format!("\n\n<playbook name=\"{}\">\n{}\n</playbook>", b.name, b.rules),
        None => String::new(),
    }
}

/// A new playbook note's text.
fn playbook_template(title: &str) -> String {
    format!(
        "---\ntype: playbook\ntitle: {}\ndescription: \"\"\n---\n\
# {title}\n\n\
<!-- Rules for every phase go here, above the first phase. -->\n\n\
## research\n\n\
<!-- Each \"## \" heading is a phase. They run in this order, each in a new session. Write what the session should do and \
what its reply must end with: the reply is saved and given to the later phases. A first line of \"model: opus\" or \
\"effort: high\" sets them for this phase. -->\n\n\
## implement\n\n\
<!-- The last phase finishes the task. The request's verify: command and ## Acceptance apply to it. -->\n",
        serde_json::to_string(title).unwrap()
    )
}

/// Writes `playbooks/<name>.md`: a copy of marq's own playbook of that name to edit, else the
/// template. An existing note is returned as it is.
pub fn new_playbook(vault: &Path, title: &str) -> Result<PathBuf> {
    let title = title.trim();
    if title.is_empty() {
        return Err(Error::Other("a playbook needs a name".into()));
    }
    let name = vault::slug(title);
    let path = vault.join(PLAYBOOK_FOLDER).join(format!("{name}.md"));
    if !path.exists() {
        std::fs::create_dir_all(vault.join(PLAYBOOK_FOLDER))?;
        let text = BUILTIN_PLAYBOOKS.iter().find(|(b, _)| *b == name).map_or_else(|| playbook_template(title), |(_, t)| t.to_string());
        std::fs::write(&path, text)?;
    }
    Ok(path)
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
        return Ok(full.strip_prefix(vault).unwrap_or(&full).to_slash());
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
            let rel = p.strip_prefix(vault).unwrap_or(&p).to_slash();
            std::fs::write(spec, vault::fm_set(&std::fs::read_to_string(spec)?, "board", &rel))?;
            p
        }
    };
    let b = boards::read(&board)?;
    let have: Vec<String> = b.lists.iter().flat_map(|l| l.cards.iter().map(|c| c.title.to_lowercase())).collect();
    let board_rel = board.strip_prefix(vault).unwrap_or(&board).to_slash();
    let spec_rel = spec.strip_prefix(vault).unwrap_or(spec).to_slash();
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

        // The project's default fills in what the request leaves out; `verify: off` turns the command off.
        let d = verify_of("---\nverify: pnpm check\nverify_retries: 5\nverify_retry: fresh\n---\n").unwrap();
        let v = verify_with("---\ntype: request\n---\nx\n", Some(&d)).unwrap();
        assert_eq!((v.command.as_deref(), v.retries, v.fresh), (Some("pnpm check"), 5, true));
        let v = verify_with("---\nverify: make\nverify_retries: 1\n---\nx\n", Some(&d)).unwrap();
        assert_eq!((v.command.as_deref(), v.retries), (Some("make"), 1));
        assert_eq!(verify_with("---\nverify: off\n---\nx\n", Some(&d)), None);
        let v = verify_with("---\nverify: off\n---\n## Acceptance\n\n- works\n", Some(&d)).unwrap();
        assert_eq!((v.command, v.acceptance.as_deref()), (None, Some("- works")));
        assert_eq!(verify_of("---\nverify: off\n---\nx\n"), None);
    }

    #[test]
    fn reads_the_review_switch() {
        let on = |t: &str, d: Option<&Verify>| verify_with(t, d).unwrap().review;
        assert_eq!(on("---\nverify: make\n---\nx\n", None), None);
        assert_eq!(on("---\nverify: make\nreview: on\n---\nx\n", None), Some(true));
        assert_eq!(on("---\nverify: make\nreview: off\n---\nx\n", None), Some(false));
        assert_eq!(on("---\nverify: make\nreview: maybe\n---\nx\n", None), None);
        // The environment's value is the default; the request's wins.
        let d = verify_of("---\nverify: make\nreview: on\n---\n").unwrap();
        assert_eq!(on("---\ntype: request\n---\nx\n", Some(&d)), Some(true));
        assert_eq!(on("---\nreview: off\n---\nx\n", Some(&d)), Some(false));
        // An explicit value beats the config; flags parse.
        assert!(Verify { review: Some(true), ..Default::default() }.review_enabled());
        assert!(!Verify { review: Some(false), ..Default::default() }.review_enabled());
        assert_eq!((review_flag(Some(" ON ")), review_flag(Some("off")), review_flag(None)), (Some(true), Some(false), None));
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
    fn review_prompt_asks_for_proof() {
        let p = review_prompt("do x", " (branch b)");
        assert!(p.contains("do x") && p.contains("(branch b)"));
        assert!(p.contains("`command`") && p.contains(VERDICT_PASS) && p.contains(VERDICT_FAIL));
        assert!(p.contains("Do not change any files"));
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
    fn playbooks_give_phases_and_instructions() {
        let dir = std::env::temp_dir().join(format!("marq-playbook-{}", vault::new_id()));
        std::fs::create_dir_all(dir.join("playbooks")).unwrap();
        let none: [&str; 0] = [];

        // marq's own, until the vault has one of the same name.
        let own = playbook(&dir, "bug-fix").unwrap();
        assert!(own.builtin);
        assert_eq!(own.phases.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["reproduce", "diagnose", "fix"]);
        assert!(own.rules.contains("smallest change") && !own.rules.contains("# Bug fix"));
        std::fs::write(
            dir.join("playbooks/bug-fix.md"),
            "---\ntype: playbook\ntitle: My fix\nphase_gate: auto\n---\n# My fix\n\nBe brief.\n<!-- a hint -->\n\n\
## Repro\n\n- model: haiku\neffort: low\n\nShow it failing.\n\n```md\n## not a phase\n```\n\n## Fix\n\n<!-- nothing yet -->\n",
        )
        .unwrap();
        let book = playbook(&dir, "playbooks/bug-fix.md").unwrap();
        assert_eq!((book.title.as_str(), book.rules.as_str(), book.gate.as_deref(), book.builtin), ("My fix", "Be brief.", Some("auto"), false));
        let repro = book.phase("repro").unwrap();
        assert_eq!((repro.model.as_deref(), repro.effort.as_deref()), (Some("haiku"), Some("low")));
        assert!(repro.instructions.starts_with("Show it failing.") && repro.instructions.contains("## not a phase"));
        assert_eq!(book.phase("fix").unwrap().instructions, "");
        assert_eq!(playbook(&dir, "Bug fix").unwrap().title, "My fix", "found by its title's slug");
        assert_eq!(playbooks(&dir).iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), ["bug-fix", "plan-first", "refactor", "organize"]);

        // A request takes the playbook's phases once, and keeps a list of its own.
        let request = with_playbook_phases(&dir, "---\ntype: request\nplaybook: bug-fix\n---\n## Request\n\nx\n").unwrap();
        assert_eq!(phases_of(&request), ["repro", "fix"]);
        let own_list = "---\ntype: request\nplaybook: bug-fix\nphases: [fix]\n---\nx\n";
        assert_eq!(with_playbook_phases(&dir, own_list).unwrap(), own_list);
        assert!(with_playbook_phases(&dir, "---\nplaybook: nope\n---\nx\n").is_err());
        assert_eq!(phases_of(&with_playbook_phases(&dir, REQUEST).unwrap()), ["research", "plan", "implement"]);

        let p = phase_prompt(&dir, &dir.join("requests/r.md"), &request, "repro");
        assert!(p.contains("Show it failing.") && p.contains("saved and given to the next phase"));
        // A phase the playbook says nothing about gets the built-in instructions.
        assert!(phase_prompt(&dir, &dir.join("requests/r.md"), &request, "fix").contains("Finish the task"));
        assert_eq!(playbook_prompt(&dir, &request), "\n\n<playbook name=\"bug-fix\">\nBe brief.\n</playbook>");
        assert_eq!(playbook_prompt(&dir, REQUEST), "");

        // New: a copy of marq's own to edit, else the template, whose hints are not instructions.
        assert_eq!(new_playbook(&dir, "Bug fix").unwrap(), dir.join("playbooks/bug-fix.md"));
        assert_eq!(playbook(&dir, "bug-fix").unwrap().title, "My fix", "an existing note is kept");
        assert!(std::fs::read_to_string(new_playbook(&dir, "refactor").unwrap()).unwrap().contains("## baseline"));
        new_playbook(&dir, "Release notes").unwrap();
        let fresh = playbook(&dir, "release-notes").unwrap();
        assert_eq!((fresh.title.as_str(), fresh.rules.as_str()), ("Release notes", ""));
        assert_eq!(fresh.phases.iter().map(|p| (p.name.as_str(), p.instructions.as_str())).collect::<Vec<_>>(), [("research", ""), ("implement", "")]);
        assert_eq!(phases_of("---\nphases: []\n---\n"), none);
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
        // cmd.exe has no `;` separator and no `sleep`.
        let (fail, slow) = if cfg!(windows) { ("echo broken 1>&2 & exit 3", "ping -n 6 127.0.0.1 >nul") } else { ("echo broken >&2; exit 3", "sleep 5") };
        let (ok, out) = run_check(fail, &dir, &[], t, false);
        assert!(!ok && out.contains("broken"));
        let (ok, out) = run_check(slow, &dir, &[], Duration::from_secs(1), false);
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
