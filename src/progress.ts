import type { SessionEvent } from "./api";

export type Step = { text: string; status: "pending" | "in_progress" | "completed" };

const status = (s: unknown): Step["status"] => (s === "completed" || s === "done" ? "completed" : s === "in_progress" ? "in_progress" : "pending");

/**
 * The agent's todo list as of the last event. Claude's `TodoWrite` sends the whole list each time; its
 * `TaskCreate` / `TaskUpdate` (ids count up from 1) change it a step at a time. Codex and ACP plans arrive as `TodoWrite`.
 */
export function stepsOf(events: SessionEvent[]): Step[] {
  let steps: Step[] = [];
  for (const e of events) {
    if (e.type !== "tool_call") continue;
    const i = (e.input ?? {}) as Record<string, any>;
    if (e.name === "TodoWrite" && Array.isArray(i.todos)) {
      steps = i.todos.map((t: any) => ({ text: String(t.status === "in_progress" && t.activeForm ? t.activeForm : t.content ?? ""), status: status(t.status) }));
    } else if (e.name === "TaskCreate" && typeof i.subject === "string") {
      steps = [...steps, { text: i.subject, status: "pending" }];
    } else if (e.name === "TaskUpdate" && i.taskId != null) {
      const at = Number(i.taskId) - 1;
      if (steps[at]) {
        steps = steps.map((s, n) => (n === at ? { text: typeof i.subject === "string" ? i.subject : s.text, status: i.status === "deleted" ? "completed" : i.status ? status(i.status) : s.status } : s));
      }
    }
  }
  return steps;
}
