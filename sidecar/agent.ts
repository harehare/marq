// The interface an agent backend implements. main.ts owns what is the same for every agent (the session table,
// approvals, the idle timeout and how a session ends); a backend only runs its agent and translates its messages.
import type { AgentEvent } from "./protocol.ts";

export type StartOptions = {
  id: string;
  /** The agent's id, e.g. `gemini`. */
  agent?: string;
  cwd: string;
  prompt: string;
  /** Continue the conversation with this id rather than start one. */
  resume: boolean;
  permissionMode?: string;
  model?: string | null;
  executable?: string;
  args?: string[];
  /** The agent's own id for the conversation (from an earlier `init`), when it differs from marq's. */
  agentSession?: string;
  /** Appended to the agent's system prompt. */
  system?: string;
  crew: boolean;
  additionalDirectories?: string[];
  /** `on` or `strict`: run Bash in Claude Code's OS sandbox. */
  sandbox?: string | null;
};

export type ApprovalRequest = {
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  reason?: string;
  blockedPath?: string;
};

export type ApprovalDecision = { allow: true } | { allow: false; message: string; interrupt?: boolean };

/** What a running session reports back to main.ts. */
export interface SessionHost {
  event(e: AgentEvent): void;
  /** Asks the user. Resolves when they answer, or with a denial when `signal` aborts or the session stops. */
  approve(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
}

export interface AgentSession {
  /** Queues a user turn. `model` is the session's model for it; backends that can switch between turns do. */
  send(text: string, model?: string | null): void;
  interrupt(): Promise<void>;
  /** Ends the agent's process; `done` settles once it has. */
  close(): void;
  /** Settles when the process ends: rejects with the reason it failed. */
  readonly done: Promise<void>;
  /** Slash commands and skills, when the agent has them. */
  commands?(): Promise<unknown>;
}

export interface AgentBackend {
  start(opts: StartOptions, host: SessionHost): AgentSession;
  /** One turn on a fork of the conversation `id`, without changing the session. Resolves with the reply. */
  summarize(o: {
    id: string; cwd: string; instruction: string; model?: string | null; executable?: string; args?: string[];
    agentSession?: string; transcript?: string;
  }): Promise<string>;
  /** A one-turn answer from a small model, for naming a task. */
  title(o: { prompt: string; model?: string | null; executable?: string }): Promise<string>;
  /** Slash commands and skills available in `cwd`, without a running session. */
  commands(o: { cwd: string; executable?: string }): Promise<unknown>;
}
