// Agents that speak ACP (Agent Client Protocol, https://agentclientprotocol.com): Gemini CLI, Codex (codex-acp),
// OpenCode and others. The agent runs as a child process and talks JSON-RPC over its stdio; marq is the client.
// It starts or loads a session, sends prompts, answers permission requests and translates the agent's
// session/update notifications into marq's events.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentBackend, AgentSession, SessionHost, StartOptions } from "./agent.ts";
import { mcpUrl } from "./mcp-http.ts";
import { log, message, type ToolKind } from "./protocol.ts";

const PROTOCOL_VERSION = 1;

// The parts of ACP's messages marq reads. Everything else is passed over.
type ContentBlock = { type: string; text?: string };
type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };
type ToolCall = {
  toolCallId: string; title?: string; kind?: string; status?: string; rawInput?: unknown; rawOutput?: unknown;
  content?: ToolCallContent[]; locations?: { path: string; line?: number }[];
};
type SessionUpdate =
  | ({ sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk"; content: ContentBlock })
  | ({ sessionUpdate: "tool_call" | "tool_call_update" } & ToolCall)
  | { sessionUpdate: "available_commands_update"; availableCommands: { name: string; description?: string; input?: { hint?: string } }[] }
  | { sessionUpdate: string };
type PermissionOption = { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" };
type SessionSetup = {
  sessionId?: string;
  modes?: { currentModeId: string; availableModes: { id: string }[] } | null;
  models?: { currentModelId: string; availableModels: { modelId: string }[] } | null;
};
type Initialized = { protocolVersion: number; agentCapabilities?: { loadSession?: boolean; mcpCapabilities?: { http?: boolean } } };

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, msg: string) {
    super(msg);
    this.code = code;
  }
}

/** JSON-RPC 2.0 over newline-delimited JSON on a child's stdio, both ways. */
class Connection {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private child: ChildProcess;
  private onRequest: (method: string, params: any) => Promise<unknown>;
  private onNotification: (method: string, params: any) => void;

  constructor(
    child: ChildProcess,
    onRequest: (method: string, params: any) => Promise<unknown>,
    onNotification: (method: string, params: any) => void,
  ) {
    this.child = child;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    createInterface({ input: child.stdout! }).on("line", (line) => this.receive(line));
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Rejects every request still waiting, e.g. once the process is gone. */
  fail(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private write(m: unknown) {
    if (this.child.stdin?.writable) this.child.stdin.write(JSON.stringify(m) + "\n");
  }

  private receive(line: string) {
    if (!line.trim()) return;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      log("acp: not JSON:", line);
      return;
    }
    if (typeof m.method === "string" && m.id !== undefined) {
      this.onRequest(m.method, m.params).then(
        (result) => this.write({ jsonrpc: "2.0", id: m.id, result: result ?? null }),
        (e) => this.write({ jsonrpc: "2.0", id: m.id, error: { code: e instanceof RpcError ? e.code : -32603, message: message(e) } }),
      );
    } else if (typeof m.method === "string") {
      this.onNotification(m.method, m.params);
    } else {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${m.error.message ?? "error"}${m.error.data ? `: ${JSON.stringify(m.error.data)}` : ""}`));
      else p.resolve(m.result);
    }
  }
}

/** Runs the agent and initializes the connection. `exited` settles with the process, with its last stderr lines. */
function launch(
  o: { executable?: string; args?: string[]; cwd: string; tag: string },
  onRequest: (method: string, params: any) => Promise<unknown>,
  onNotification: (method: string, params: any) => void,
) {
  if (!o.executable) throw new Error("no command for this agent");
  const child = spawn(o.executable, o.args ?? [], { cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
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
  void exited.then((r) => conn.fail(r.error ?? new Error(`the agent exited${r.code ? ` with code ${r.code}` : ""}`)));
  const initialized = conn.request<Initialized>("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    // marq does not offer its files or terminals: the agent uses its own.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "marq", version: "0.1.0" },
  });
  return { child, conn, exited, initialized };
}

const notSupported = (method: string) => Promise.reject(new RpcError(-32601, `marq does not support ${method}`));

const TOOL_KINDS = new Set<string>(["read", "edit", "delete", "move", "search", "execute", "think", "fetch"]);
const toolKind = (k?: string): ToolKind => (k && TOOL_KINDS.has(k) ? (k as ToolKind) : "other");

/** A tool call's output as text: its text content, what it changed, or the raw output. */
function toolOutput(t: ToolCall): string {
  const parts = (t.content ?? []).map((c) =>
    c.type === "content" ? c.content.text ?? "" : c.type === "diff" ? `${c.oldText == null ? "Wrote" : "Edited"} ${c.path}` : "");
  const text = parts.filter(Boolean).join("\n");
  if (text) return text;
  if (t.rawOutput === undefined || t.rawOutput === null) return "";
  return typeof t.rawOutput === "string" ? t.rawOutput : JSON.stringify(t.rawOutput);
}

/** The tool's input, with the file it works on as `file_path` like Claude's tools, which the session note lists. */
function toolInput(t: ToolCall): unknown {
  const input = t.rawInput && typeof t.rawInput === "object" ? (t.rawInput as Record<string, unknown>) : {};
  const path = t.locations?.[0]?.path;
  return path && !("file_path" in input) ? { ...input, file_path: path } : input;
}

class AcpSession implements AgentSession {
  readonly done: Promise<void>;
  private conn: Connection;
  private child: ChildProcess;
  private sessionId?: string;
  private queue: string[] = [];
  private busy = false;
  private closing = false;
  /** While session/load replays the conversation, which marq has logged already. */
  private loading = false;
  /** The system text still to send, ahead of the first prompt of a new conversation. */
  private preamble?: string;
  /** Streamed text or thinking, sent as one event when something else comes. */
  private buffer: { type: "text" | "thinking"; text: string } | null = null;
  private lastText = "";
  private finished = new Set<string>();
  private asking = new Set<AbortController>();
  private models: string[] = [];
  private model?: string | null;
  private nextModel?: string;
  private available: { name: string; description: string; argumentHint: string }[] = [];
  private closeMcp?: () => void;
  private c: StartOptions;
  private host: SessionHost;

  constructor(c: StartOptions, host: SessionHost) {
    this.c = c;
    this.host = host;
    const l = launch(
      { executable: c.executable, args: c.args, cwd: c.cwd, tag: c.id.slice(-8) },
      (method, params) => this.request(method, params),
      (method, params) => method === "session/update" && params?.sessionId === this.sessionId && this.update(params.update),
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
      if (exit.code) throw new Error(exit.stderr.slice(-3).join("\n") || `the agent exited with code ${exit.code}`);
    })();
  }

  private async setup(initialized: Promise<Initialized>) {
    const c = this.c;
    const caps = (await initialized).agentCapabilities ?? {};
    const mcpServers = [];
    if (caps.mcpCapabilities?.http) {
      const m = await mcpUrl(c.id, c.crew);
      this.closeMcp = m.close;
      mcpServers.push({ type: "http", name: "marq", url: m.url, headers: [] });
    } else {
      log(`[${c.id.slice(-8)}] the agent takes no HTTP MCP servers, so marq's tools are not available to it`);
    }
    let s: SessionSetup;
    if (c.resume && c.agentSession && caps.loadSession) {
      this.loading = true;
      try {
        s = await this.conn.request<SessionSetup>("session/load", { sessionId: c.agentSession, cwd: c.cwd, mcpServers });
      } finally {
        this.loading = false;
      }
      this.sessionId = c.agentSession;
    } else {
      if (c.resume) log(`[${c.id.slice(-8)}] the agent cannot load the earlier conversation; starting a new one`);
      s = await this.conn.request<SessionSetup>("session/new", { cwd: c.cwd, mcpServers });
      this.sessionId = s.sessionId;
      // ACP has no system prompt, so marq's instructions lead the first message instead.
      if (c.system) this.preamble = c.system;
    }
    await this.configure(s);
    this.host.event({ type: "init", agent: c.agent ?? "acp", model: this.model ?? undefined, session: this.sessionId });
    void this.pump();
  }

  /** Applies marq's permission mode and model where the agent offers ones with the same id. */
  private async configure(s: SessionSetup) {
    const sessionId = this.sessionId;
    const mode = this.c.permissionMode;
    if (mode && s.modes?.availableModes.some((m) => m.id === mode) && s.modes.currentModeId !== mode) {
      await this.conn.request("session/set_mode", { sessionId, modeId: mode }).catch((e) => log("acp: set_mode failed:", e));
    }
    this.models = s.models?.availableModels.map((m) => m.modelId) ?? [];
    this.model = s.models?.currentModelId;
    if (this.c.model && this.models.includes(this.c.model) && this.c.model !== this.model) {
      await this.conn.request("session/set_model", { sessionId, modelId: this.c.model }).then(
        () => (this.model = this.c.model),
        (e) => log("acp: set_model failed:", e),
      );
    }
  }

  /** Sends queued prompts one turn at a time. */
  private async pump() {
    if (this.busy || this.closing || !this.sessionId) return;
    const text = this.queue.shift();
    if (text === undefined) return;
    this.busy = true;
    this.lastText = "";
    try {
      if (this.nextModel) {
        const modelId = this.nextModel;
        this.nextModel = undefined;
        await this.conn.request("session/set_model", { sessionId: this.sessionId, modelId }).then(
          () => (this.model = modelId),
          (e) => log("acp: set_model failed:", e),
        );
      }
      const prompt = this.preamble ? `<instructions>\n${this.preamble}\n</instructions>\n\n${text}` : text;
      this.preamble = undefined;
      const r = await this.conn.request<{ stopReason: string }>("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      this.flush();
      this.host.event({ type: "turn_end", result: this.lastText, is_error: r.stopReason === "refusal" });
    } catch (e) {
      this.flush();
      if (this.closing) return;
      log(`[${this.c.id.slice(-8)}] prompt failed:`, e);
      this.host.event({ type: "turn_end", result: message(e), is_error: true });
    } finally {
      this.busy = false;
    }
    void this.pump();
  }

  private update(u: SessionUpdate) {
    if (u.sessionUpdate === "available_commands_update" && "availableCommands" in u) {
      this.available = u.availableCommands.map((c) => ({ name: c.name, description: c.description ?? "", argumentHint: c.input?.hint ?? "" }));
      return;
    }
    if (this.loading) return;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const block = (u as { content: ContentBlock }).content;
        if (block.type === "text" && block.text) this.append(u.sessionUpdate === "agent_message_chunk" ? "text" : "thinking", block.text);
        return;
      }
      case "tool_call": {
        const t = u as ToolCall;
        this.flush();
        this.host.event({ type: "tool_call", id: t.toolCallId, name: t.title || t.kind || "tool", kind: toolKind(t.kind), input: toolInput(t) });
        this.result(t);
        return;
      }
      case "tool_call_update":
        this.result(u as ToolCall);
        return;
    }
  }

  /** The tool's result, once it has completed or failed. */
  private result(t: ToolCall) {
    if ((t.status !== "completed" && t.status !== "failed") || this.finished.has(t.toolCallId)) return;
    this.finished.add(t.toolCallId);
    this.flush();
    this.host.event({ type: "tool_result", id: t.toolCallId, output: toolOutput(t), is_error: t.status === "failed" });
  }

  private append(type: "text" | "thinking", text: string) {
    if (this.buffer && this.buffer.type !== type) this.flush();
    this.buffer ??= { type, text: "" };
    this.buffer.text += text;
  }

  private flush() {
    const b = this.buffer;
    this.buffer = null;
    if (!b?.text.trim()) return;
    this.host.event({ type: b.type, text: b.text });
    if (b.type === "text") this.lastText = b.text;
  }

  /** Requests from the agent. Files and terminals are the agent's own, so only permissions are asked for. */
  private async request(method: string, params: any): Promise<unknown> {
    if (method !== "session/request_permission") return notSupported(method);
    const t: ToolCall = params.toolCall ?? {};
    const options: PermissionOption[] = params.options ?? [];
    const pick = (...kinds: PermissionOption["kind"][]) => options.find((o) => kinds.includes(o.kind));
    const selected = (o?: PermissionOption) => ({ outcome: o ? { outcome: "selected", optionId: o.optionId } : { outcome: "cancelled" } });
    const kind = toolKind(t.kind);
    if (this.autoAllowed(kind)) return selected(pick("allow_once", "allow_always"));
    const ac = new AbortController();
    this.asking.add(ac);
    try {
      // Always-allow is per kind of tool (edit, execute…), since ACP tools have no stable names.
      const d = await this.host.approve({ toolName: kind, input: toolInput(t) as Record<string, unknown>, title: t.title }, ac.signal);
      if (ac.signal.aborted) return { outcome: { outcome: "cancelled" } };
      if (!d.allow && d.interrupt) void this.interrupt();
      return selected(d.allow ? pick("allow_once", "allow_always") : pick("reject_once", "reject_always"));
    } finally {
      this.asking.delete(ac);
    }
  }

  /** marq's permission modes, for agents that ask anyway. */
  private autoAllowed(kind: ToolKind) {
    const mode = this.c.permissionMode;
    return mode === "bypassPermissions" || (mode === "acceptEdits" && (kind === "edit" || kind === "delete" || kind === "move"));
  }

  send(text: string, model?: string | null) {
    if (model && model !== this.model && this.models.includes(model)) this.nextModel = model;
    this.queue.push(text);
    void this.pump();
  }

  async interrupt() {
    // Permission requests still open are answered as cancelled, as ACP asks of a client that cancels.
    for (const ac of this.asking) ac.abort();
    if (this.sessionId) this.conn.notify("session/cancel", { sessionId: this.sessionId });
  }

  close() {
    this.closing = true;
    for (const ac of this.asking) ac.abort();
    this.child.stdin?.end();
    this.child.kill();
  }

  async commands() {
    return this.available;
  }
}

/** One prompt in a new conversation with no tools, for a title. Resolves with the reply. */
async function oneTurn(o: { executable?: string; args?: string[]; cwd: string }, prompt: string): Promise<string> {
  let sessionId: string | undefined;
  let reply = "";
  const l = launch(
    { ...o, tag: "acp" },
    // Nothing is approved: the turn should only answer.
    async (method) => (method === "session/request_permission" ? { outcome: { outcome: "cancelled" } } : notSupported(method)),
    (method, params) => {
      const u = params?.update;
      if (method === "session/update" && params.sessionId === sessionId && u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        reply += u.content.text;
      }
    },
  );
  try {
    await l.initialized;
    sessionId = (await l.conn.request<SessionSetup>("session/new", { cwd: o.cwd, mcpServers: [] })).sessionId;
    await l.conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
    return reply.trim();
  } finally {
    l.child.stdin?.end();
    l.child.kill();
  }
}

export const acp: AgentBackend = {
  start: (c, host) => new AcpSession(c, host),

  title: (c) => oneTurn({ ...c, cwd: process.cwd() }, c.prompt),

  /** Commands come with a running session (available_commands_update). */
  commands: async () => [],
};
