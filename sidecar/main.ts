// marq sidecar: runs Claude sessions with the Agent SDK and talks to the Tauri app over stdio.
// Each line on stdin is a command from the app, each line on stdout is an event.
import { createInterface } from "node:readline";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKMessage, SDKUserMessage, PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

type Command =
  | {
      op: "start"; id: string; cwd: string; prompt: string; resume: boolean; permissionMode?: string; model?: string | null;
      claudePath?: string; system?: string;
      /** A crew member gets the crew tools and read access to the other members' directories. */
      crew?: boolean; additionalDirectories?: string[];
    }
  | { op: "send"; id: string; text: string }
  | { op: "interrupt"; id: string }
  | { op: "stop"; id: string }
  | { op: "approval"; requestId: string; allow: boolean; always?: boolean; message?: string }
  | { op: "summarize"; reqId: string; id: string; cwd: string; instruction: string; model?: string | null; claudePath?: string }
  | { op: "commands"; reqId: string; id?: string; cwd: string; claudePath?: string }
  | { op: "title"; reqId: string; text: string; model?: string | null; claudePath?: string }
  | { op: "ollama_models"; reqId: string }
  | { op: "probe_url"; reqId: string; url: string }
  | { op: "rpc_result"; reqId: string; result?: unknown; error?: string };

// ---- models ----

/** Ollama's URL from OLLAMA_HOST, as the ollama CLI reads it. */
function ollamaUrl() {
  const h = process.env.OLLAMA_HOST?.trim() || "127.0.0.1:11434";
  const url = /^https?:\/\//.test(h) ? h : `http://${h}`;
  return url.replace("0.0.0.0", "127.0.0.1").replace(/\/$/, "");
}

const BASE_ENV = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "marq/0.1" };

/** Model and env for a session's `model`; `ollama:<name>` routes everything to Ollama. */
function backend(model?: string | null): { model?: string; env: Record<string, string | undefined> } {
  if (!model?.startsWith("ollama:")) return { model: model || undefined, env: BASE_ENV };
  const name = model.slice("ollama:".length);
  return {
    model: name,
    env: {
      ...BASE_ENV,
      ANTHROPIC_BASE_URL: ollamaUrl(),
      ANTHROPIC_AUTH_TOKEN: "ollama",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_DEFAULT_OPUS_MODEL: name,
      ANTHROPIC_DEFAULT_SONNET_MODEL: name,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: name,
      CLAUDE_CODE_SUBAGENT_MODEL: name,
    },
  };
}

/** Whether a page may be shown in an iframe: X-Frame-Options and CSP frame-ancestors. */
async function probeUrl(c: Extract<Command, { op: "probe_url" }>) {
  try {
    const res = await fetch(c.url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(4000) });
    const xfo = res.headers.get("x-frame-options")?.toLowerCase() ?? "";
    const csp = res.headers.get("content-security-policy")?.toLowerCase() ?? "";
    const ancestors = csp.match(/frame-ancestors([^;]*)/)?.[1]?.trim() ?? "";
    const blocked = /deny|sameorigin/.test(xfo) || (ancestors !== "" && !ancestors.split(/\s+/).includes("*"));
    void res.body?.cancel();
    emit({ ev: "reply", reqId: c.reqId, result: { status: res.status, frameable: !blocked } });
  } catch (e) {
    emit({ ev: "reply", reqId: c.reqId, error: e instanceof Error ? e.message : String(e) });
  }
}

async function ollamaModels(c: Extract<Command, { op: "ollama_models" }>) {
  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
    const body = (await res.json()) as { models?: { name: string }[] };
    emit({ ev: "reply", reqId: c.reqId, result: (body.models ?? []).map((m) => `ollama:${m.name}`) });
  } catch (e) {
    emit({ ev: "reply", reqId: c.reqId, error: `Ollama is not reachable at ${ollamaUrl()}: ${e instanceof Error ? e.message : String(e)}` });
  }
}

const emit = (ev: Record<string, unknown>) => process.stdout.write(JSON.stringify(ev) + "\n");
const log = (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n");

/** Pushes user turns into a running query, so the session process stays alive between turns. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter?: (r: IteratorResult<SDKUserMessage>) => void;
  private closed = false;

  push(text: string) {
    const msg: SDKUserMessage = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    if (this.waiter) {
      this.waiter({ value: msg, done: false });
      this.waiter = undefined;
    } else this.items.push(msg);
  }

  close() {
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

// An idle session's process is closed after this long. The next message resumes it.
const IDLE_MS = 10 * 60_000;

type Active = { q: Query; input: InputQueue; alwaysAllow: Set<string>; idle?: NodeJS.Timeout; stopping?: boolean };
const active = new Map<string, Active>();

// ---- calls back into the app (vault tools need mq and the vault, which live in Rust) ----

let rpcSeq = 0;
const rpcWaiters = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const reqId = `r${++rpcSeq}`;
  emit({ ev: "rpc", reqId, method, params });
  return new Promise((resolve, reject) => rpcWaiters.set(reqId, { resolve, reject }));
}

const text = (t: unknown) => ({ content: [{ type: "text" as const, text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });

/** Tools only crew members get. Messages go through the app, which delivers them between turns. */
function crewTools(sessionId: string) {
  return [
    tool("crew_members", "List the members of your crew: role, status (idle, running, waiting), unread mail, working directory and branch.",
      {}, async () => text(await rpc("crew_members", { session: sessionId }))),
    tool("crew_send",
      "Send a message to crew members. to: a role, \"user\", \"all\" (every other member) or roles separated by commas; " +
        "leave it out with reply_to to answer everyone in that thread (how discussions work). " +
        "kind: \"ask\" when you need an answer, \"reply\" (with reply_to, the id of the message you answer), \"tell\" otherwise. " +
        "It is delivered when each recipient finishes its current turn. Do not wait for an answer: finish your turn and it arrives as a new message.",
      { to: z.string().optional(), text: z.string(), kind: z.enum(["tell", "ask", "reply"]).optional(), reply_to: z.string().optional() },
      async (a) => text(await rpc("crew_send", { ...a, session: sessionId }))),
    tool("task_list", "The crew's shared task list: id, title, status (todo, doing, review, blocked, done), owner and notes.",
      {}, async () => text(await rpc("task_list", { session: sessionId }))),
    tool("task_add", "Add a task to the crew's task list. With owner (a role), that member is told and can start on it.",
      { title: z.string(), owner: z.string().optional(), note: z.string().optional() },
      async (a) => text(await rpc("task_add", { ...a, session: sessionId }))),
    tool("task_update",
      "Update a task: status (todo, doing, review, blocked, done), owner (a role, or empty to unassign) or a note " +
        "(e.g. branch, commit, what is left). Setting doing takes the task; it fails if another member is already doing it.",
      { id: z.string(), status: z.enum(["todo", "doing", "review", "blocked", "done"]).optional(), owner: z.string().optional(), note: z.string().optional() },
      async (a) => text(await rpc("task_update", { ...a, session: sessionId }))),
    tool("crew_decide",
      "Record a decision the crew has made (approach, task split, who does what, a changed plan) in the crew note's Decisions " +
        "section, and tell every member. Use it to close a discussion.",
      { decision: z.string() }, async (a) => text(await rpc("crew_decide", { ...a, session: sessionId }))),
    tool("crew_add_member",
      "Add a member to the crew. role is one word (e.g. impl, reviewer, tester). instructions say what it owns, how it hands " +
        "work on and who checks it. worktree (default true) gives it its own git worktree and branch; use false for members " +
        "that only read, review or test. permission_mode: auto (default), default, acceptEdits or plan. The user approves it.",
      { role: z.string(), instructions: z.string(), worktree: z.boolean().optional(), permission_mode: z.string().optional() },
      async (a) => text(await rpc("crew_add_member", { ...a, session: sessionId }))),
  ];
}

/** For sessions outside a crew: hand a large task to a new crew. The user approves it. */
function startCrew(sessionId: string) {
  return tool("start_crew",
    "Hand a large task to a crew: a team of Claude sessions (a lead who forms the team, then e.g. impl, reviewer, tester) " +
      "working on this project together in their own tab. goal is the full task: what to build, constraints, and how to " +
      "know it is done; include what you have learned so far. Use it only when the work clearly benefits from several " +
      "members in parallel. The user approves it.",
    { title: z.string(), goal: z.string() }, async (a) => text(await rpc("start_crew", { ...a, session: sessionId })));
}

/** Kanban boards in the vault. `board` is a name, title or path; empty for the only board. */
function boardTools(sessionId: string) {
  const board = z.string().optional().describe("Board name, title or path; omit when there is only one");
  return [
    tool("list_boards", "List the user's kanban boards (task management) with their lists and card counts.",
      {}, async () => text(await rpc("list_boards", { session: sessionId }))),
    tool("read_board", "Read a kanban board: its lists in order, each with cards (id, title, done, owner, notes).",
      { board }, async (a) => text(await rpc("read_board", { ...a, session: sessionId }))),
    tool("board_add_card", "Add a card (task) to a board, in `list` (default: the first list).",
      { board, title: z.string(), list: z.string().optional(), owner: z.string().optional(), note: z.string().optional() },
      async (a) => text(await rpc("board_add_card", { ...a, session: sessionId }))),
    tool("board_update_card",
      "Update a card: move it to another `list` (e.g. Doing, Done), set owner, title or done, or append a note.",
      { board, id: z.string(), list: z.string().optional(), owner: z.string().optional(), title: z.string().optional(),
        done: z.boolean().optional(), note: z.string().optional() },
      async (a) => text(await rpc("board_update_card", { ...a, session: sessionId }))),
    tool("open_preview",
      "Show a page to the user in a browser tab inside Marq, e.g. the dev server you started (http://localhost:5173) " +
        "or an HTML file you wrote (absolute path). Calling it again for this session reloads the same tab.",
      { url: z.string().describe("http(s) URL or absolute file path"), title: z.string().optional() },
      async (a) => text(await rpc("open_preview", { ...a, session: sessionId }))),
    tool("board_add_list", "Add a list (column) to the end of a board.",
      { board, name: z.string() }, async (a) => text(await rpc("board_add_list", { ...a, session: sessionId }))),
  ];
}

function vaultServer(sessionId: string, crew: boolean) {
  return createSdkMcpServer({
    name: "marq",
    version: "0.1.0",
    tools: [
      ...(crew ? crewTools(sessionId) : [startCrew(sessionId)]),
      ...boardTools(sessionId),
      tool("search_notes", "Search the user's notes (Markdown knowledge base) by text. Returns matching paths and lines.",
        { text: z.string() }, async (a) => text(await rpc("search_notes", { ...a, session: sessionId }))),
      tool("query_notes", "Run an mq query (jq-like language for Markdown) over notes matching a glob relative to the vault, e.g. glob 'sessions/*.md' and query 'section::find(\"Learnings\") | section::body()'. aggregate defaults to true (mq -A).",
        { query: z.string(), glob: z.string(), aggregate: z.boolean().optional() }, async (a) => text(await rpc("query_notes", { ...a, session: sessionId }))),
      tool("read_note", "Read a note by its id (frontmatter id) or vault-relative path.",
        { note: z.string() }, async (a) => text(await rpc("read_note", { ...a, session: sessionId }))),
      tool("write_doc",
        "Save a document for the user (report, plan, design, investigation, summary, how-to, meeting notes) in their vault. " +
          "Use this instead of writing such documents into the working directory. content is Markdown without frontmatter. " +
          "folder defaults to 'docs'. To revise a document saved earlier, pass its path; only documents written this way can be updated.",
        { title: z.string(), content: z.string(), folder: z.string().optional(), path: z.string().optional() },
        async (a) => text(await rpc("write_doc", { ...a, session: sessionId }))),
      tool("append_learning", "Record a reusable learning (a gotcha, decision or fact worth remembering) in this session's notes.",
        { text: z.string() }, async (a) => text(await rpc("append_learning", { ...a, session: sessionId }))),
      tool("list_notes", "List folders and notes in the user's vault (path, title, type, status). folder narrows it to one folder.",
        { folder: z.string().optional() }, async (a) => text(await rpc("list_notes", { ...a, session: sessionId }))),
      tool("create_folder", "Create a folder in the vault (parents too). path is relative to the vault.",
        { path: z.string() }, async (a) => text(await rpc("create_folder", { ...a, session: sessionId }))),
      tool("move_note",
        "Move or rename a note or folder in the vault. to may be a folder to move into (or end with /). " +
          "Relative links in and to moved notes are rewritten. Existing files are never overwritten. The user approves moves.",
        { from: z.string(), to: z.string() }, async (a) => text(await rpc("move_note", { ...a, session: sessionId }))),
      tool("trash_note", "Move a note or folder in the vault to the Trash. The user approves each one.",
        { path: z.string() }, async (a) => text(await rpc("trash_note", { ...a, session: sessionId }))),
      tool("list_sessions", "List the user's other Claude sessions in Marq (id, title, status, working directory), most recent first.",
        {}, async () => text(await rpc("list_sessions", { session: sessionId }))),
      tool("read_session", "Read another session's latest result and status, to coordinate with it or reuse its findings.",
        { session_id: z.string() }, async (a) => text(await rpc("read_session", { ...a, session: sessionId }))),
      tool("send_to_session",
        "Send a message to another session, e.g. to hand over findings or ask it to do part of the work. " +
          "It runs after that session's current turn, and resumes it if it has stopped. The user approves each send.",
        { session_id: z.string(), text: z.string() },
        async (a) => text(await rpc("send_to_session", { ...a, session: sessionId }))),
    ],
  });
}

// Pre-approved: they only read the vault and sessions, or write Marq's own files in the vault.
// send_to_session is left out so each send goes through the approval card.
// move_note and trash_note change the user's notes, so they ask too.
// Crew messages are pre-approved too: the crew's hop limit, not an approval card, keeps them in check.
// crew_add_member asks, since every member is another Claude session to pay for.
const VAULT_TOOLS = ["search_notes", "query_notes", "read_note", "write_doc", "append_learning", "list_sessions", "read_session",
  "list_notes", "create_folder", "crew_members", "crew_send", "crew_decide", "task_list", "task_add", "task_update",
  "list_boards", "read_board", "board_add_card", "board_update_card", "board_add_list", "open_preview"]
  .map((t) => `mcp__marq__${t}`);

// ---- approvals ----

let approvalSeq = 0;
const approvals = new Map<string, { sessionId: string; toolName: string; resolve: (r: PermissionResult) => void; input: Record<string, unknown> }>();

function canUseTool(sessionId: string) {
  return (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal; title?: string; decisionReason?: string; blockedPath?: string }) => {
    const entry = active.get(sessionId);
    if (entry?.alwaysAllow.has(toolName)) return Promise.resolve<PermissionResult>({ behavior: "allow", updatedInput: input });
    const requestId = `a${++approvalSeq}`;
    emit({ ev: "approval_request", id: sessionId, requestId, toolName, input, title: opts.title, reason: opts.decisionReason, blockedPath: opts.blockedPath });
    return new Promise<PermissionResult>((resolve) => {
      approvals.set(requestId, { sessionId, toolName, resolve, input });
      opts.signal.addEventListener("abort", () => {
        if (approvals.delete(requestId)) {
          emit({ ev: "approval_cancelled", id: sessionId, requestId });
          resolve({ behavior: "deny", message: "Cancelled" });
        }
      });
    });
  };
}

function cancelApprovals(sessionId: string) {
  for (const [requestId, a] of approvals) {
    if (a.sessionId !== sessionId) continue;
    approvals.delete(requestId);
    a.resolve({ behavior: "deny", message: "The session was stopped", interrupt: true });
    emit({ ev: "approval_cancelled", id: sessionId, requestId });
  }
}

// ---- sessions ----

const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);

function start(c: Extract<Command, { op: "start" }>) {
  if (active.has(c.id)) {
    send({ op: "send", id: c.id, text: c.prompt });
    return;
  }
  const input = new InputQueue();
  input.push(c.prompt);
  const mode = (c.permissionMode && PERMISSION_MODES.has(c.permissionMode) ? c.permissionMode : "auto") as PermissionMode;
  const q = query({
    prompt: input,
    options: {
      cwd: c.cwd,
      // marq's id is the Claude session id, so the first turn sets it and later ones resume it.
      ...(c.resume ? { resume: c.id } : { sessionId: c.id }),
      permissionMode: mode,
      canUseTool: canUseTool(c.id),
      allowedTools: VAULT_TOOLS,
      mcpServers: { marq: vaultServer(c.id, !!c.crew) },
      additionalDirectories: c.additionalDirectories,
      systemPrompt: { type: "preset", preset: "claude_code", append: c.system },
      settingSources: ["user", "project", "local"],
      pathToClaudeCodeExecutable: c.claudePath,
      ...backend(c.model),
      stderr: (d: string) => log(`[${c.id.slice(-8)}]`, d.trimEnd()),
    },
  });
  const entry: Active = { q, input, alwaysAllow: new Set() };
  active.set(c.id, entry);
  void consume(c.id, entry);
}

async function consume(id: string, entry: Active) {
  let error: string | undefined;
  try {
    for await (const m of entry.q as AsyncIterable<SDKMessage>) {
      if (m.type === "stream_event") continue;
      emit({ ev: "message", id, msg: m });
      if (m.type === "result") {
        clearTimeout(entry.idle);
        entry.idle = setTimeout(() => stop(id), IDLE_MS);
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
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
  entry.input.push(c.text);
}

function stop(id: string) {
  const entry = active.get(id);
  if (!entry) return;
  entry.stopping = true;
  cancelApprovals(id);
  entry.input.close();
  entry.q.close();
}

/** Forks the conversation to write a summary, leaving the session itself untouched. */
async function summarize(c: Extract<Command, { op: "summarize" }>) {
  try {
    const q = query({
      prompt: c.instruction,
      options: {
        cwd: c.cwd,
        resume: c.id,
        forkSession: true,
        tools: [],
        maxTurns: 1,
        settingSources: [],
        pathToClaudeCodeExecutable: c.claudePath,
        ...backend(c.model),
      },
    });
    let result = "";
    for await (const m of q) {
      if (m.type === "result") {
        if (m.subtype !== "success") throw new Error(`summary failed: ${m.subtype}`);
        result = m.result;
      }
    }
    emit({ ev: "summary", reqId: c.reqId, text: result });
  } catch (e) {
    emit({ ev: "summary", reqId: c.reqId, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Slash commands and skills available in a directory, for completion in the app. A running session
 * answers from its own query; otherwise a query is opened just to initialize (no prompt is sent, so
 * there is no model call) and closed again.
 */
async function commands(c: Extract<Command, { op: "commands" }>) {
  try {
    const running = c.id ? active.get(c.id) : undefined;
    let list;
    if (running) {
      list = await running.q.supportedCommands();
    } else {
      const input = new InputQueue();
      const q = query({
        prompt: input,
        options: {
          cwd: c.cwd,
          settingSources: ["user", "project", "local"],
          pathToClaudeCodeExecutable: c.claudePath,
          env: BASE_ENV,
        },
      });
      try {
        list = await q.supportedCommands();
      } finally {
        input.close();
        q.close();
      }
    }
    emit({ ev: "reply", reqId: c.reqId, result: list });
  } catch (e) {
    emit({ ev: "reply", reqId: c.reqId, error: e instanceof Error ? e.message : String(e) });
  }
}

/** A short title for a task, from a small model in one turn with no tools. */
async function title(c: Extract<Command, { op: "title" }>) {
  try {
    const q = query({
      prompt: `Write a short title for this task: at most 40 characters, in the same language as the task, ` +
        `naming what is to be done. Reply with the title only.\n\n<task>\n${c.text.slice(0, 4000)}\n</task>`,
      options: {
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        pathToClaudeCodeExecutable: c.claudePath,
        // Ollama tasks are named by their own model.
        ...backend(c.model?.startsWith("ollama:") ? c.model : "haiku"),
      },
    });
    let result = "";
    for await (const m of q) {
      if (m.type === "result") {
        if (m.subtype !== "success") throw new Error(`title failed: ${m.subtype}`);
        result = m.result;
      }
    }
    emit({ ev: "reply", reqId: c.reqId, result });
  } catch (e) {
    emit({ ev: "reply", reqId: c.reqId, error: e instanceof Error ? e.message : String(e) });
  }
}

function handle(c: Command) {
  switch (c.op) {
    case "start":
      return start(c);
    case "send":
      return send(c);
    case "interrupt":
      return void active.get(c.id)?.q.interrupt().catch((e) => log("interrupt failed:", e));
    case "stop":
      return stop(c.id);
    case "approval": {
      const a = approvals.get(c.requestId);
      if (!a) return;
      approvals.delete(c.requestId);
      if (c.allow && c.always) active.get(a.sessionId)?.alwaysAllow.add(a.toolName);
      a.resolve(c.allow ? { behavior: "allow", updatedInput: a.input } : { behavior: "deny", message: c.message || "The user denied this action." });
      return;
    }
    case "summarize":
      return void summarize(c);
    case "commands":
      return void commands(c);
    case "title":
      return void title(c);
    case "ollama_models":
      return void ollamaModels(c);
    case "probe_url":
      return void probeUrl(c);
    case "rpc_result": {
      const w = rpcWaiters.get(c.reqId);
      if (!w) return;
      rpcWaiters.delete(c.reqId);
      if (c.error) w.reject(new Error(c.error));
      else w.resolve(c.result);
      return;
    }
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
