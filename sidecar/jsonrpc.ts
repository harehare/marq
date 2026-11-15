// JSON-RPC 2.0 over newline-delimited JSON on a child process's stdio, in both directions. Shared by the agents
// that talk it: ACP agents (acp.ts) and Codex's app-server (codex.ts).
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { log, message } from "./protocol.ts";

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, msg: string) {
    super(msg);
    this.code = code;
  }
}

/** JSON-RPC 2.0 over newline-delimited JSON on a child's stdio, both ways. */
export class Connection {
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
      log("not JSON:", line);
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
