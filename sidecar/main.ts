// marq sidecar: runs agent sessions and talks to the Tauri app over stdio.
// Each line on stdin is a command from the app, each line on stdout is an event.
// Agents plug in as backends (agent.ts); this file holds what is the same for all of them.
import { createInterface } from "node:readline";
import type { AgentBackend, AgentSession, ApprovalDecision, ApprovalRequest, SessionHost } from "./agent.ts";
import { acp } from "./acp.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { ollamaModels } from "./ollama.ts";
import { emit, log, message, rpcResult, type Command } from "./protocol.ts";

const BACKENDS: Record<string, AgentBackend> = { claude, codex };

/** Agents without a backend of their own talk ACP. */
function backendFor(agent?: string): AgentBackend {
  return BACKENDS[agent ?? "claude"] ?? acp;
}

/** Answers a request-reply command with `run`'s result or error. */
async function reply(reqId: string, run: () => Promise<unknown>, ev = "reply", key = "result") {
  try {
    emit({ ev, reqId, [key]: await run() });
  } catch (e) {
    emit({ ev, reqId, error: message(e) });
  }
}

// An idle session's process is closed after this long. The next message resumes it.
const IDLE_MS = 10 * 60_000;

type Active = { session: AgentSession; alwaysAllow: Set<string>; idle?: NodeJS.Timeout; stopping?: boolean };
const active = new Map<string, Active>();

// ---- approvals ----

let approvalSeq = 0;
const approvals = new Map<string, { sessionId: string; toolName: string; resolve: (d: ApprovalDecision) => void }>();

function approve(sessionId: string, req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
  if (active.get(sessionId)?.alwaysAllow.has(req.toolName)) return Promise.resolve({ allow: true });
  const requestId = `a${++approvalSeq}`;
  emit({ ev: "approval_request", id: sessionId, requestId, ...req });
  return new Promise((resolve) => {
    approvals.set(requestId, { sessionId, toolName: req.toolName, resolve });
    signal?.addEventListener("abort", () => {
      if (approvals.delete(requestId)) {
        emit({ ev: "approval_cancelled", id: sessionId, requestId });
        resolve({ allow: false, message: "Cancelled" });
      }
    });
  });
}

function answer(c: Extract<Command, { op: "approval" }>) {
  const a = approvals.get(c.requestId);
  if (!a) return;
  approvals.delete(c.requestId);
  if (c.allow && c.always) active.get(a.sessionId)?.alwaysAllow.add(a.toolName);
  a.resolve(c.allow ? { allow: true, answers: c.answers } : { allow: false, message: c.message || "The user denied this action." });
}

function cancelApprovals(sessionId: string) {
  for (const [requestId, a] of approvals) {
    if (a.sessionId !== sessionId) continue;
    approvals.delete(requestId);
    a.resolve({ allow: false, message: "The session was stopped", interrupt: true });
    emit({ ev: "approval_cancelled", id: sessionId, requestId });
  }
}

// ---- sessions ----

function start(c: Extract<Command, { op: "start" }>) {
  if (active.has(c.id)) {
    send({ op: "send", id: c.id, text: c.prompt, model: c.model });
    return;
  }
  const host: SessionHost = {
    event(e) {
      emit({ ev: "event", id: c.id, event: e });
      if (e.type === "turn_end") {
        clearTimeout(entry.idle);
        entry.idle = setTimeout(() => stop(c.id), IDLE_MS);
      }
    },
    approve: (req, signal) => approve(c.id, req, signal),
  };
  let entry: Active;
  try {
    // A sandbox the agent cannot provide must not be dropped silently: the user asked for it.
    if (c.sandbox && c.agent && c.agent !== "claude") throw new Error(`the sandbox is only available for Claude sessions, not ${c.agent}`);
    entry = { session: backendFor(c.agent).start({ ...c, crew: !!c.crew }, host), alwaysAllow: new Set() };
  } catch (e) {
    emit({ ev: "exit", id: c.id, status: "error", error: message(e) });
    return;
  }
  active.set(c.id, entry);
  void entry.session.done.then(
    () => ended(c.id, entry),
    (e) => ended(c.id, entry, message(e)),
  );
}

function ended(id: string, entry: Active, error?: string) {
  clearTimeout(entry.idle);
  cancelApprovals(id);
  active.delete(id);
  emit({ ev: "exit", id, status: error ? "error" : entry.stopping ? "stopped" : "done", error });
}

function send(c: Extract<Command, { op: "send" }>) {
  const entry = active.get(c.id);
  if (!entry || entry.stopping) {
    emit({ ev: "not_running", id: c.id, text: c.text });
    return;
  }
  clearTimeout(entry.idle);
  entry.session.send(c.text, c.model);
}

function stop(id: string) {
  const entry = active.get(id);
  if (!entry) return;
  entry.stopping = true;
  cancelApprovals(id);
  entry.session.close();
}

/** Slash commands and skills, from the running session if there is one. */
function commands(c: Extract<Command, { op: "commands" }>) {
  const running = c.id ? active.get(c.id)?.session : undefined;
  if (running?.commands) return running.commands();
  return backendFor(c.agent).commands({ cwd: c.cwd, executable: c.executable });
}

/** A short title for a task, from a small model in one turn with no tools. */
function title(c: Extract<Command, { op: "title" }>) {
  const prompt = `Write a short title for this task: at most 40 characters, in the same language as the task, ` +
    `naming what is to be done. Reply with the title only.\n\n<task>\n${c.text.slice(0, 4000)}\n</task>`;
  return backendFor(c.agent).title({ prompt, model: c.model, executable: c.executable });
}

function handle(c: Command) {
  switch (c.op) {
    case "start":
      return start(c);
    case "send":
      return send(c);
    case "interrupt":
      return void active.get(c.id)?.session.interrupt().catch((e) => log("interrupt failed:", e));
    case "stop":
      return stop(c.id);
    case "approval":
      return answer(c);
    case "commands":
      return void reply(c.reqId, () => commands(c));
    case "title":
      return void reply(c.reqId, () => title(c));
    case "ollama_models":
      return void reply(c.reqId, ollamaModels);
    case "rpc_result":
      return rpcResult(c);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (e) {
    log("bad command:", e, line);
  }
}).on("close", () => {
  for (const id of active.keys()) stop(id);
  setTimeout(() => process.exit(0), 2000).unref();
});

emit({ ev: "ready" });
