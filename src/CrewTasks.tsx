import { useState } from "react";
import { FileText, Plus } from "lucide-react";
import { api, CrewState, CrewTask } from "./api";
import { composing } from "./keys";

const STATUSES = ["doing", "review", "blocked", "todo", "done"] as const;

type Props = {
  vault: string;
  st: CrewState;
  color: (role: string) => string;
  onError: (e: string) => void;
  onChanged: () => void;
  onOpenNote: (path: string) => void;
};

/** The crew's shared task list. The file is the source of truth; this edits it as the user. */
export function CrewTasks({ vault, st, color, onError, onChanged, onOpenNote }: Props) {
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState("");

  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      onChanged();
    } catch (e) {
      onError(String(e));
    }
  };
  const add = () => {
    if (!title.trim()) return;
    run(() => api.crewTaskAdd(vault, st.id, title, owner || undefined)).then(() => setTitle(""));
  };
  const update = (t: CrewTask, change: { status?: string; owner?: string }) => run(() => api.crewTaskUpdate(vault, st.id, t.id, change));

  return (
    <div className="messages">
      <div className="messages-inner crew-tasks">
        <div className="crew-tasks-head">
          <span className="muted small">Members take tasks and update them as they work, so several run in parallel.</span>
          <span className="spacer" />
          <button onClick={() => onOpenNote(st.tasks_path)} title="Open the task list as a note"><FileText size={13} /> Open as note</button>
        </div>
        <div className="crew-task-add">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task…"
            onKeyDown={(e) => e.key === "Enter" && !composing(e) && add()} />
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">no owner</option>
            {st.members.map((m) => <option key={m.role} value={m.role}>@{m.role}</option>)}
          </select>
          <button onClick={add} disabled={!title.trim()}><Plus size={13} /> Add</button>
        </div>
        {st.tasks.length === 0 && <p className="muted small">No tasks yet. The lead adds them after the kickoff discussion.</p>}
        {STATUSES.map((status) => {
          const items = st.tasks.filter((t) => t.status === status);
          if (!items.length) return null;
          return (
            <section key={status} className="crew-task-group">
              <h4><span className={`pill status-${status === "doing" ? "running" : status === "blocked" ? "error" : status}`}>{status}</span>
                <span className="count">{items.length}</span></h4>
              {items.map((t) => (
                <div key={t.id} className={`crew-task ${status}`}>
                  <span className="crew-task-id mono">{t.id}</span>
                  <div className="crew-task-body">
                    <span className="crew-task-title">{t.title}</span>
                    {t.notes.map((n, i) => <span key={i} className="muted small">{n}</span>)}
                  </div>
                  <select className="crew-task-owner" value={t.owner ?? ""} style={{ color: t.owner ? color(t.owner) : undefined }}
                    onChange={(e) => update(t, { owner: e.target.value })}>
                    <option value="">no owner</option>
                    {st.members.map((m) => <option key={m.role} value={m.role}>@{m.role}</option>)}
                  </select>
                  <select value={t.status} onChange={(e) => update(t, { status: e.target.value })}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
