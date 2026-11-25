// The Claude backend: runs Claude Code with the Agent SDK and translates its messages into marq's session events.
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKMessage, SDKUserMessage, PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend, AgentSession, SessionHost, StartOptions, TurnOptions } from "./agent.ts";
import { ollamaUrl } from "./ollama.ts";
import { log, type AgentEvent, type ToolKind } from "./protocol.ts";
import { checkRules, type Rules } from "./rules.ts";
import { VAULT_TOOLS, vaultServer } from "./tools.ts";

const BASE_ENV = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "marq/0.1" };

/** Model and env for a session's `model`; `ollama:<name>` routes everything to Ollama. */
function backend(model?: string | null, extra: Record<string, string> = {}): { model?: string; env: Record<string, string | undefined> } {
  if (!model?.startsWith("ollama:")) return { model: model || undefined, env: { ...BASE_ENV, ...extra } };
  const name = model.slice("ollama:".length);
  return {
    model: name,
    env: {
      ...BASE_ENV,
      ...extra,
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

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read", Edit: "edit", Write: "edit", MultiEdit: "edit", NotebookEdit: "edit", Bash: "execute",
  Grep: "search", Glob: "search", WebFetch: "fetch", WebSearch: "fetch",
};

function toolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
}

/** What the main loop's latest request held, to say how full the context is when the turn ends. */
export type ContextSeen = { tokens?: number; model?: string };

/**
 * marq's events for one SDK message. Messages marq does not show (stream events, hooks, status…) yield none.
 * `seen` is kept between the messages of a session.
 */
export function* toEvents(m: SDKMessage, seen: ContextSeen = {}): Generator<AgentEvent> {
  if (m.type === "system" && m.subtype === "init") {
    yield { type: "init", agent: "claude", model: m.model };
  } else if (m.type === "assistant") {
    const u = m.message.usage;
    // Subagents have their own context.
    if (u && !m.parent_tool_use_id) {
      seen.tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
      seen.model = m.message.model;
    }
    for (const c of m.message.content) {
      if (c.type === "text") yield { type: "text", text: c.text };
      else if (c.type === "thinking" && c.thinking) yield { type: "thinking", text: c.thinking };
      else if (c.type === "tool_use") yield { type: "tool_call", id: c.id, name: c.name, kind: TOOL_KINDS[c.name] ?? "other", input: c.input };
    }
  } else if (m.type === "user" && Array.isArray(m.message.content)) {
    for (const c of m.message.content) {
      if (c.type === "tool_result") yield { type: "tool_result", id: c.tool_use_id, output: toolOutput(c.content), is_error: c.is_error };
    }
  } else if (m.type === "result") {
    const used = Object.entries(m.modelUsage ?? {});
    const window = (used.find(([k]) => k === seen.model) ?? used.find(([k]) => !!seen.model && (k.startsWith(seen.model) || seen.model.startsWith(k))))?.[1].contextWindow;
    yield {
      type: "turn_end",
      result: m.subtype === "success" ? m.result : "",
      is_error: m.is_error,
      cost_usd: m.total_cost_usd,
      duration_ms: m.duration_ms,
      num_turns: m.num_turns,
      context: seen.tokens && window ? Math.min(1, seen.tokens / window) : undefined,
    };
  }
}

/** Skills marq ships for its workflows (specs, retros), loaded into every session as the `marq` plugin. */
// A bundled app has no `plugin` folder next to the sidecar, so the app passes where its resources are.
const PLUGIN = process.env.MARQ_PLUGIN ?? fileURLToPath(new URL("./plugin", import.meta.url));

/**
 * Claude Code's OS sandbox for Bash. `on` lets a command that fails in the sandbox ask to run outside it;
 * `strict` does not. Either way it fails rather than running unsandboxed when the sandbox is unavailable.
 */
function sandbox(mode?: string | null) {
  if (mode !== "on" && mode !== "strict") return {};
  return { sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: mode === "on", failIfUnavailable: true } };
}

/**
 * A PreToolUse hook for the environment note's `ask` and `deny`. It runs whatever the permission mode,
 * so even Auto, where a classifier decides, stops at a command the project wants to be asked about.
 */
export function ruleHooks(rules?: Rules) {
  if (!rules || (!rules.ask.length && !rules.deny.length)) return {};
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            async (input: { hook_event_name: string; tool_input?: unknown }) => {
              if (input.hook_event_name !== "PreToolUse") return {};
              const command = (input.tool_input as { command?: unknown } | undefined)?.command;
              const v = typeof command === "string" ? checkRules(command, rules) : null;
              return v
                ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: v.decision, permissionDecisionReason: v.reason } }
                : {};
            },
          ],
        },
      ],
    },
  };
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);

class ClaudeSession implements AgentSession {
  readonly done: Promise<void>;
  private q: Query;
  private input = new InputQueue();
  private model?: string | null;
  private mode?: string;
  private effort = "";

  constructor(c: StartOptions, host: SessionHost) {
    this.model = c.model;
    this.mode = c.permissionMode ?? "auto";
    this.effort = c.effort ?? "";
    this.input.push(c.prompt);
    const mode = (c.permissionMode && PERMISSION_MODES.has(c.permissionMode) ? c.permissionMode : "auto") as PermissionMode;
    const q = (this.q = query({
      prompt: this.input,
      options: {
        cwd: c.cwd,
        // marq's id is the Claude session id, so the first turn sets it and later ones resume it.
        ...(c.resume ? { resume: c.id } : { sessionId: c.id }),
        permissionMode: mode,
        canUseTool: async (toolName, input, opts): Promise<PermissionResult> => {
          const d = await host.approve(
            { toolName, input, title: opts.title, reason: opts.decisionReason, blockedPath: opts.blockedPath },
            opts.signal,
          );
          if (!d.allow) return { behavior: "deny", message: d.message, interrupt: d.interrupt };
          // AskUserQuestion reads the user's choices from `answers` in its input; without them the agent gets no answer.
          return { behavior: "allow", updatedInput: d.answers ? { ...input, answers: d.answers } : input };
        },
        allowedTools: VAULT_TOOLS,
        mcpServers: { marq: vaultServer(c.id) },
        additionalDirectories: c.additionalDirectories,
        systemPrompt: { type: "preset", preset: "claude_code", append: c.system },
        settingSources: ["user", "project", "local"],
        plugins: [{ type: "local", path: PLUGIN }],
        ...sandbox(c.sandbox),
        ...ruleHooks(c.rules),
        pathToClaudeCodeExecutable: c.executable,
        ...backend(c.model, c.env),
        ...(c.effort && EFFORTS.has(c.effort) ? { effort: c.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
        stderr: (d: string) => log(`[${c.id.slice(-8)}]`, d.trimEnd()),
      },
    }));
    this.done = (async () => {
      const seen: ContextSeen = {};
      for await (const m of q) for (const e of toEvents(m, seen)) host.event(e);
    })();
  }

  send(text: string, model?: string | null, opts?: TurnOptions) {
    const mode = opts?.permissionMode;
    if (mode && PERMISSION_MODES.has(mode) && mode !== this.mode) {
      this.mode = mode;
      void this.q.setPermissionMode(mode as PermissionMode).catch((e) => log("setPermissionMode failed:", e));
    }
    const effort = opts?.effort ?? "";
    if (opts && effort !== this.effort && (!effort || EFFORTS.has(effort))) {
      this.effort = effort;
      void this.q.applyFlagSettings({ effortLevel: (effort || undefined) as "low" | "medium" | "high" | "xhigh" | "max" | undefined }).catch((e) => log("setEffort failed:", e));
    }
    // The model was switched between turns. Ollama sessions keep theirs: its env is set at start.
    const next = model ?? null;
    if (model !== undefined && next !== (this.model ?? null) && !next?.startsWith("ollama:") && !this.model?.startsWith("ollama:")) {
      this.model = next;
      // The prompt goes in after the switch, so its turn runs on the new model.
      void this.q.setModel(next ?? undefined).catch((e) => log("setModel failed:", e)).then(() => this.input.push(text));
      return;
    }
    this.input.push(text);
  }

  async interrupt() {
    await this.q.interrupt();
  }

  close() {
    this.input.close();
    this.q.close();
  }

  commands() {
    return this.q.supportedCommands();
  }
}

/** The reply of a one-turn query with no tools. */
async function oneTurn(q: Query, what: string): Promise<string> {
  let result = "";
  for await (const m of q) {
    if (m.type === "result") {
      if (m.subtype !== "success") throw new Error(`${what} failed: ${m.subtype}`);
      result = m.result;
    }
  }
  return result;
}

export const claude: AgentBackend = {
  start: (c, host) => new ClaudeSession(c, host),

  title: (c) =>
    oneTurn(
      query({
        prompt: c.prompt,
        options: {
          tools: [],
          maxTurns: 1,
          settingSources: [],
          persistSession: false,
          pathToClaudeCodeExecutable: c.executable,
          // Ollama tasks are named by their own model.
          ...backend(c.model?.startsWith("ollama:") ? c.model : "haiku"),
        },
      }),
      "title",
    ),

  /** The models Claude Code offers for this login, from a query that is opened only to ask and closed again. */
  async models(c) {
    const input = new InputQueue();
    const q = query({
      prompt: input,
      options: { cwd: process.cwd(), settingSources: ["user"], pathToClaudeCodeExecutable: c.executable, env: BASE_ENV },
    });
    try {
      return (await q.supportedModels()).map((m) => ({
        value: m.value,
        label: m.displayName,
        description: m.description,
        efforts: m.supportsEffort ? m.supportedEffortLevels : undefined,
        default: m.value === "default",
      }));
    } finally {
      input.close();
      q.close();
    }
  },

  /** A query opened just to initialize (no prompt is sent, so there is no model call) and closed again. */
  async commands(c) {
    const input = new InputQueue();
    const q = query({
      prompt: input,
      options: {
        cwd: c.cwd, settingSources: ["user", "project", "local"], plugins: [{ type: "local", path: PLUGIN }],
        pathToClaudeCodeExecutable: c.executable, env: BASE_ENV,
      },
    });
    try {
      return await q.supportedCommands();
    } finally {
      input.close();
      q.close();
    }
  },
};
