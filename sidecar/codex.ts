// Codex, through its app-server (https://developers.openai.com/codex/app-server): `codex app-server` runs as a child
// process and talks JSON-RPC over its stdio, the interface OpenAI offers for embedding Codex in another product.
// It needs only the `codex` the user has installed and logged in to. marq starts or resumes a thread, sends turns,
// answers approval requests and translates the thread's items into marq's events.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentBackend, AgentSession, SessionHost, StartOptions } from "./agent.ts";
import { Connection, RpcError } from "./jsonrpc.ts";
import { mcpUrl } from "./mcp-http.ts";
import { log, message, planEvents, type ModelOption, type ToolKind } from "./protocol.ts";

// The parts of the app-server's messages marq reads. Everything else is passed over.
type FileChange = { path: string; kind?: { type?: string }; diff?: string };
type Item = {
  id: string;
  type: string;
  text?: string;
  summary?: string[];
  content?: string[];
  command?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  status?: string;
  changes?: FileChange[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: { type?: string; text?: string }[]; structuredContent?: unknown } | null;
  error?: { message?: string } | null;
  query?: string;
};
type Turn = { id: string; status: "completed" | "interrupted" | "failed" | "inProgress"; error?: { message?: string } | null };

/** marq's permission modes as Codex's approval policy and sandbox. */
function policy(mode?: string): { approvalPolicy: string; sandbox: string } {
  switch (mode) {
    case "bypassPermissions":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    case "plan":
      return { approvalPolicy: "on-request", sandbox: "read-only" };
    default:
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  }
}

const text = (s: string) => [{ type: "text", text: s, text_elements: [] }];

/** Runs `codex app-server` and initializes the connection. `exited` settles with the process. */
function launch(
  o: { executable?: string; args?: string[]; cwd: string; tag: string; env?: Record<string, string> },
  onRequest: (method: string, params: any) => Promise<unknown>,
  onNotification: (method: string, params: any) => void,
) {
  if (!o.executable) throw new Error("no command for this agent");
  const child = spawn(o.executable, o.args?.length ? o.args : ["app-server"], { cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...o.env } });
  const conn = new Connection(child, onRequest, onNotification);
  const stderr: string[] = [];
  createInterface({ input: child.stderr! }).on("line", (l) => {
    log(`[${o.tag}]`, l);
    stderr.push(l);
    if (stderr.length > 20) stderr.shift();
  });
  const exited = new Promise<{ code: number | null; error?: Error; stderr: string[] }>((resolve) => {
    child.on("error", (error) => resolve({ code: null, error, stderr }));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
  void exited.then((r) => conn.fail(r.error ?? new Error(`codex exited${r.code ? ` with code ${r.code}` : ""}`)));
  const initialized = conn.request("initialize", { clientInfo: { name: "marq", title: "Marq", version: "0.1.0" } }).then(() => conn.notify("initialized", {}));
  return { child, conn, exited, initialized };
}

/** What a finished tool item printed: command output, MCP result text, or the error. */
function itemOutput(i: Item): string {
  if (i.type === "commandExecution") return i.aggregatedOutput ?? "";
  if (i.type === "fileChange") return (i.changes ?? []).map((c) => `${c.kind?.type === "add" ? "Wrote" : c.kind?.type === "delete" ? "Deleted" : "Edited"} ${c.path}`).join("\n");
  if (i.type === "mcpToolCall") {
    if (i.error?.message) return i.error.message;
    const parts = (i.result?.content ?? []).map((c) => c.text ?? "").filter(Boolean);
    return parts.length ? parts.join("\n") : i.result?.structuredContent ? JSON.stringify(i.result.structuredContent) : "";
  }
  return "";
}

const failed = (i: Item) => i.status === "failed" || i.status === "declined" || (i.type === "commandExecution" && !!i.exitCode);

/** The tool call an item starts, or null for items that are not tools. */
function toolCall(i: Item): { name: string; kind: ToolKind; input: unknown } | null {
  switch (i.type) {
    case "commandExecution":
      return { name: "Bash", kind: "execute", input: { command: i.command } };
    case "fileChange": {
      const first = i.changes?.[0];
      const kind: ToolKind = first?.kind?.type === "delete" ? "delete" : "edit";
      return { name: "Edit", kind, input: { file_path: first?.path, files: i.changes?.map((c) => c.path) } };
    }
    case "mcpToolCall":
      return { name: `${i.server}.${i.tool}`, kind: "other", input: i.arguments ?? {} };
    case "webSearch":
      return { name: "WebSearch", kind: "fetch", input: { query: i.query } };
    default:
      return null;
  }
}

class CodexSession implements AgentSession {
  readonly done: Promise<void>;
  private conn: Connection;
  private child: ChildProcess;
  private threadId?: string;
  private turnId?: string;
  private turnDone?: (t: Turn) => void;
  private queue: string[] = [];
  private busy = false;
  private closing = false;
  private lastText = "";
  private asking = new Set<AbortController>();
  /** File changes of the items in flight, which an approval request names only by item id. */
  private items = new Map<string, Item>();
  private model?: string | null;
  private closeMcp?: () => void;
  private c: StartOptions;
  private host: SessionHost;

  constructor(c: StartOptions, host: SessionHost) {
    this.c = c;
    this.host = host;
    this.model = c.model;
    const l = launch(
      { executable: c.executable, args: c.args, cwd: c.cwd, tag: c.id.slice(-8), env: c.env },
      (method, params) => this.request(method, params),
      (method, params) => this.notification(method, params),
    );
    this.conn = l.conn;
    this.child = l.child;
    this.queue.push(c.prompt);
    this.done = (async () => {
      let failure: unknown;
      const setup = this.setup(l.initialized).catch((e) => {
        failure = e;
        this.child.kill();
      });
      const exit = await l.exited;
      await setup;
      this.closeMcp?.();
      if (this.closing) return;
      if (failure) throw failure;
      if (exit.error) throw exit.error;
      if (exit.code) throw new Error(exit.stderr.slice(-3).join("\n") || `codex exited with code ${exit.code}`);
    })();
  }

  private async setup(initialized: Promise<unknown>) {
    const c = this.c;
    await initialized;
    const m = await mcpUrl(c.id, c.crew);
    this.closeMcp = m.close;
    const params = {
      cwd: c.cwd,
      ...policy(c.permissionMode),
      model: c.model ?? undefined,
      developerInstructions: c.system,
      config: { "mcp_servers.marq": { url: m.url } },
    };
    let r: { thread: { id: string }; model?: string };
    if (c.resume && c.agentSession) {
      r = await this.conn.request("thread/resume", { ...params, threadId: c.agentSession }).catch((e) => {
        log(`[${c.id.slice(-8)}] cannot resume the earlier conversation (${message(e)}); starting a new one`);
        return this.conn.request("thread/start", params);
      });
    } else {
      r = await this.conn.request("thread/start", params);
    }
    this.threadId = r.thread.id;
    this.model = r.model ?? this.model;
    this.host.event({ type: "init", agent: c.agent ?? "codex", model: this.model ?? undefined, session: this.threadId });
    void this.pump();
  }

  /** Sends queued messages one turn at a time. */
  private async pump() {
    if (this.busy || this.closing || !this.threadId) return;
    const prompt = this.queue.shift();
    if (prompt === undefined) return;
    this.busy = true;
    this.lastText = "";
    try {
      const finished = new Promise<Turn>((resolve) => (this.turnDone = resolve));
      const r = await this.conn.request<{ turn: Turn }>("turn/start", {
        threadId: this.threadId,
        input: text(prompt),
        model: this.model ?? undefined,
        effort: this.c.effort || undefined,
      });
      this.turnId = r.turn.id;
      const turn = await finished;
      this.host.event({
        type: "turn_end",
        result: turn.status === "failed" ? turn.error?.message ?? "the turn failed" : this.lastText,
        is_error: turn.status === "failed",
      });
    } catch (e) {
      if (this.closing) return;
      log(`[${this.c.id.slice(-8)}] turn failed:`, e);
      this.host.event({ type: "turn_end", result: message(e), is_error: true });
    } finally {
      this.busy = false;
      this.turnId = undefined;
      this.turnDone = undefined;
      this.items.clear();
    }
    void this.pump();
  }

  private notification(method: string, p: any) {
    if (p?.threadId !== this.threadId) return;
    switch (method) {
      case "item/started":
        return this.started(p.item);
      case "item/completed":
        return this.completed(p.item);
      case "turn/completed":
        return this.turnDone?.(p.turn);
      case "turn/plan/updated": {
        const steps = Array.isArray(p.plan) ? p.plan : [];
        const status = (s: string) => (s === "completed" ? "completed" : s === "inProgress" ? "in_progress" : "pending");
        if (steps.length) for (const e of planEvents(`plan-${++this.plans}`, steps.map((x: any) => ({ content: String(x.step ?? ""), status: status(x.status) })))) this.host.event(e);
        return;
      }
    }
  }
  private plans = 0;

  private started(i: Item) {
    const t = toolCall(i);
    if (!t) return;
    this.items.set(i.id, i);
    this.host.event({ type: "tool_call", id: i.id, name: t.name, kind: t.kind, input: t.input });
  }

  private completed(i: Item) {
    switch (i.type) {
      case "agentMessage":
        if (i.text?.trim()) {
          this.lastText = i.text;
          this.host.event({ type: "text", text: i.text });
        }
        return;
      case "plan":
        if (i.text?.trim()) this.host.event({ type: "text", text: i.text });
        return;
      case "reasoning": {
        const t = [...(i.summary ?? []), ...(i.content ?? [])].join("\n").trim();
        if (t) this.host.event({ type: "thinking", text: t });
        return;
      }
    }
    if (!toolCall(i)) return;
    // A tool that never started (not announced) still gets its call, so the result has one to belong to.
    if (!this.items.has(i.id)) this.started(i);
    this.items.delete(i.id);
    this.host.event({ type: "tool_result", id: i.id, output: itemOutput(i), is_error: failed(i) });
  }

  /** Requests from codex: approvals. Everything else it may ask a client for is not offered. */
  private async request(method: string, params: any): Promise<unknown> {
    if (method === "item/commandExecution/requestApproval") {
      return this.ask("execute", { command: params.command, cwd: params.cwd }, params.command ?? "Run a command", params.reason);
    }
    if (method === "item/fileChange/requestApproval") {
      const changes = this.items.get(params.itemId)?.changes ?? [];
      const input = { file_path: changes[0]?.path, files: changes.map((c) => c.path), grant_root: params.grantRoot };
      return this.ask("edit", input, changes.length ? `Edit ${changes.map((c) => c.path).join(", ")}` : "Edit files", params.reason);
    }
    return Promise.reject(new RpcError(-32601, `marq does not support ${method}`));
  }

  private async ask(toolName: string, input: Record<string, unknown>, title: string, reason?: string | null) {
    const mode = this.c.permissionMode;
    if (mode === "bypassPermissions" || (mode === "acceptEdits" && toolName === "edit")) return { decision: "accept" };
    const ac = new AbortController();
    this.asking.add(ac);
    try {
      const d = await this.host.approve({ toolName, input, title, reason: reason ?? undefined }, ac.signal);
      if (ac.signal.aborted) return { decision: "cancel" };
      if (!d.allow && d.interrupt) void this.interrupt();
      return { decision: d.allow ? "accept" : "decline" };
    } finally {
      this.asking.delete(ac);
    }
  }

  send(prompt: string, model?: string | null) {
    if (model) this.model = model;
    this.queue.push(prompt);
    void this.pump();
  }

  async interrupt() {
    for (const ac of this.asking) ac.abort();
    if (this.threadId && this.turnId) {
      await this.conn.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch((e) => log("codex: interrupt failed:", e));
    }
  }

  close() {
    this.closing = true;
    for (const ac of this.asking) ac.abort();
    this.child.stdin?.end();
    this.child.kill();
  }
}

/** One turn in a throwaway thread with no tools, for a title. Resolves with the reply. */
async function oneTurn(o: { executable?: string; args?: string[]; cwd: string; model?: string | null }, prompt: string): Promise<string> {
  let threadId: string | undefined;
  let reply = "";
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const l = launch(
    { ...o, tag: "codex" },
    // Nothing is approved: the turn should only answer.
    async () => ({ decision: "cancel" }),
    (method, p) => {
      if (p?.threadId !== threadId) return;
      if (method === "item/completed" && p.item?.type === "agentMessage") reply = p.item.text ?? reply;
      if (method === "turn/completed") finish();
    },
  );
  try {
    await l.initialized;
    const t = await l.conn.request<{ thread: { id: string } }>("thread/start", {
      cwd: o.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      model: o.model ?? undefined,
    });
    threadId = t.thread.id;
    await l.conn.request("turn/start", { threadId, input: text(prompt) });
    await Promise.race([finished, l.exited.then((r) => Promise.reject(r.error ?? new Error("codex exited")))]);
    return reply.trim();
  } finally {
    l.child.stdin?.end();
    l.child.kill();
  }
}

export const codex: AgentBackend = {
  start: (c, host) => new CodexSession(c, host),

  title: (c) => oneTurn({ ...c, cwd: process.cwd() }, c.prompt),

  commands: async () => [],

  /** The app-server's own model list; the ones hidden from Codex's picker are left out. */
  async models(c) {
    const l = launch({ ...c, cwd: process.cwd(), tag: "codex" }, async () => ({}), () => {});
    try {
      await Promise.race([l.initialized, l.exited.then((r) => Promise.reject(r.error ?? new Error("codex exited")))]);
      const out: ModelOption[] = [];
      let cursor: string | null = null;
      do {
        const r: { data: any[]; nextCursor: string | null } = await l.conn.request("model/list", { cursor, limit: 100 });
        for (const m of r.data) {
          out.push({
            value: m.model,
            label: m.displayName || m.model,
            description: m.description || undefined,
            efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort),
            default: !!m.isDefault,
          });
        }
        cursor = r.nextCursor;
      } while (cursor);
      return out;
    } finally {
      l.child.stdin?.end();
      l.child.kill();
    }
  },
};
