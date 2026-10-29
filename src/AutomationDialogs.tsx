import { useEffect, useState } from "react";
import { FolderGit2, ListTodo, Timer, X } from "lucide-react";
import { api, Board, Queue } from "./api";
import { composing } from "./keys";
import { ModelSelect } from "./ModelSelect";
import { MODES } from "./NewTaskDialog";

function useProjects(vault: string) {
  const [projects, setProjects] = useState<string[]>([]);
  useEffect(() => {
    api.recentProjects(vault).then(setProjects, () => {});
  }, [vault]);
  return projects;
}

function ProjectInput({ vault, value, onChange }: { vault: string; value: string; onChange: (v: string) => void }) {
  const projects = useProjects(vault);
  return (
    <div className="project-row">
      <FolderGit2 size={14} className="muted" />
      <input list="marq-auto-projects" value={value} onChange={(e) => onChange(e.target.value)}
        placeholder="~/dev/git/your-repo (empty: run in the vault)" />
      <datalist id="marq-auto-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
    </div>
  );
}

/** Sets up or turns off a board's queue list. */
export function QueueDialog({ vault, path, board, onClose }: { vault: string; path: string; board: Board; onClose: () => void }) {
  const names = board.lists.map((l) => l.name);
  const pick = (want: string, fallback: string) => names.find((n) => n.toLowerCase() === want.toLowerCase()) ?? fallback;
  const [q, setQ] = useState<Queue>(board.queue ?? {
    list: pick("Agent", "Agent"), doing: pick("Doing", "Doing"), review: pick("Review", "Review"),
    max: 1, project: "", model: null, permission_mode: "acceptEdits", worktree: true,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (c: Partial<Queue>) => setQ({ ...q, ...c });
  const save = (queue: Queue | null) =>
    api.boardSetQueue(vault, path, queue).then(onClose, (e) => setError(String(e)));
  const listInput = (key: "list" | "doing" | "review", label: string) => (
    <label className="queue-field">
      <span className="field-label">{label}</span>
      <input list="queue-lists" value={q[key]} onChange={(e) => set({ [key]: e.target.value })} />
    </label>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="modal-head">
          <h3><ListTodo size={16} /> Queue</h3>
          <button className="icon" onClick={onClose}><X size={15} /></button>
        </div>
        <p className="muted small">
          While Marq runs, each card you put in the queue list starts a session, from the top. The card moves to the
          working list, and to the review list when the session's turn ends, so you can check the result. Lists that
          do not exist yet are added.
        </p>
        <datalist id="queue-lists">{names.map((n) => <option key={n} value={n} />)}</datalist>
        <div className="queue-lists">
          {listInput("list", "Queue")}
          {listInput("doing", "Working")}
          {listInput("review", "Review")}
          <label className="queue-field narrow">
            <span className="field-label">At once</span>
            <input type="number" min={1} max={8} value={q.max} onChange={(e) => set({ max: Math.max(1, Number(e.target.value) || 1) })} />
          </label>
        </div>
        <label className="field-label">Project</label>
        <ProjectInput vault={vault} value={q.project} onChange={(project) => set({ project })} />
        <label className="check">
          <input type="checkbox" checked={q.worktree} onChange={(e) => set({ worktree: e.target.checked })} />
          Each card in its own worktree
        </label>
        <label className="field-label">Permissions</label>
        <div className="modes">
          {MODES.map((m) => (
            <button key={m.value} className={`mode ${(q.permission_mode ?? "default") === m.value ? "on" : ""}`} title={m.hint}
              onClick={() => set({ permission_mode: m.value })}>{m.label}</button>
          ))}
        </div>
        <p className="muted small">Nobody watches these sessions as they start, so Ask leaves them waiting for you until you approve.</p>
        <label className="field-label">Model</label>
        <ModelSelect value={q.model ?? ""} onChange={(v) => set({ model: v || null })} />
        {error && <div className="banner error">{error}</div>}
        <div className="modal-foot">
          {board.queue ? <button className="danger" onClick={() => save(null)}>Turn off</button> : <span />}
          <button className="primary" onClick={() => save(q)} disabled={!q.list.trim()}>{board.queue ? "Save" : "Turn on"}</button>
        </div>
      </div>
    </div>
  );
}

/** Creates a schedule note in schedules/. */
export function ScheduleDialog({ vault, onCreated, onClose }: { vault: string; onCreated: (path: string) => void; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("1h");
  const [prompt, setPrompt] = useState("");
  const [project, setProject] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = async () => {
    if (!title.trim() || !prompt.trim() || busy) return;
    setBusy(true);
    try {
      onCreated(await api.scheduleCreate(vault, title, when, prompt, project));
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="modal-head">
          <h3><Timer size={16} /> New schedule</h3>
          <button className="icon" onClick={onClose}><X size={15} /></button>
        </div>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name, e.g. Morning triage" />
        <label className="field-label">When</label>
        <div className="project-row">
          <input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="30m, 2h, 1d or 09:00" />
          <div className="modes">
            {["30m", "1h", "1d", "09:00"].map((w) => (
              <button key={w} className={`mode ${when === w ? "on" : ""}`} onClick={() => setWhen(w)}>{w === "09:00" ? "Daily 09:00" : `Every ${w}`}</button>
            ))}
          </div>
        </div>
        <p className="muted small">An interval counts from the last run; a time runs once a day. Runs missed while Marq was closed are made up once.</p>
        <textarea className="task-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder="What the agent does each time, e.g. Go through the Todo list on boards/sprint.md, pick what is ready and put it in the Agent list."
          onKeyDown={(e) => !composing(e) && (e.metaKey || e.ctrlKey) && e.key === "Enter" && ok()} />
        <label className="field-label">Project</label>
        <ProjectInput vault={vault} value={project} onChange={setProject} />
        <p className="muted small">Saved as a note in schedules/: edit it there to change the prompt, timing, model or permission_mode.</p>
        {error && <div className="banner error">{error}</div>}
        <div className="modal-foot">
          <span />
          <button className="primary" onClick={ok} disabled={!title.trim() || !prompt.trim() || busy}>Create</button>
        </div>
      </div>
    </div>
  );
}
