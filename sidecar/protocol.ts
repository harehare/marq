// The stdio protocol between the app and the sidecar, and the session events every agent backend reports.

export type Command =
  | {
      op: "start"; id: string; cwd: string; prompt: string; resume: boolean; permissionMode?: string; model?: string | null;
      /** The agent backend to run; `claude` when left out. */
      agent?: string;
      /** The agent's executable, when the app resolved one, and its arguments. */
      executable?: string; args?: string[];
      /** The agent's own id for the conversation, for agents whose ids are not marq's (ACP). */
      agentSession?: string;
      system?: string;
      /** A crew member gets the crew tools and read access to the other members' directories. */
      crew?: boolean; additionalDirectories?: string[];
      /** `on` or `strict`: run Bash in Claude Code's OS sandbox. Only the Claude backend has one. */
      sandbox?: string | null;
    }
  | { op: "send"; id: string; text: string; model?: string | null }
  | { op: "interrupt"; id: string }
  | { op: "stop"; id: string }
  | { op: "approval"; requestId: string; allow: boolean; always?: boolean; message?: string; answers?: Record<string, string> }
  | { op: "commands"; reqId: string; id?: string; cwd: string; agent?: string; executable?: string }
  | { op: "title"; reqId: string; text: string; model?: string | null; agent?: string; executable?: string }
  | { op: "ollama_models"; reqId: string }
  | { op: "rpc_result"; reqId: string; result?: unknown; error?: string };

/** What a tool does, so the app can show and count calls without knowing each agent's tool names (ACP's tool kinds). */
export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";

/**
 * A session event in marq's own shape. Backends translate their agent's messages into these; the app logs them
 * in `sessions/.raw/<id>.jsonl` and renders from them, so it never reads an agent's native format.
 */
export type AgentEvent =
  /** `session`: the agent's own id for the conversation, when it is not marq's; resuming passes it back. */
  | { type: "init"; agent: string; model?: string; session?: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; kind: ToolKind; input: unknown }
  | { type: "tool_result"; id: string; output: string; is_error?: boolean }
  /** The end of a turn. `result` is the final reply, written back into the origin note. */
  | { type: "turn_end"; result: string; is_error: boolean; cost_usd?: number; duration_ms?: number; num_turns?: number };

export const emit = (ev: Record<string, unknown>) => process.stdout.write(JSON.stringify(ev) + "\n");
export const log = (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n");
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- calls back into the app (vault tools need mq and the vault, which live in Rust) ----

let rpcSeq = 0;
const rpcWaiters = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

export function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const reqId = `r${++rpcSeq}`;
  emit({ ev: "rpc", reqId, method, params });
  return new Promise((resolve, reject) => rpcWaiters.set(reqId, { resolve, reject }));
}

export function rpcResult(c: Extract<Command, { op: "rpc_result" }>) {
  const w = rpcWaiters.get(c.reqId);
  if (!w) return;
  rpcWaiters.delete(c.reqId);
  if (c.error) w.reject(new Error(c.error));
  else w.resolve(c.result);
}
