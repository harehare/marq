import { useEffect, useState } from "react";
import { FolderGit2, Layers, ListTodo, Timer, X } from "lucide-react";
import { api, Board, FileEntry, Queue, Workspace } from "./api";
import { composing } from "./keys";
import { ModelSelect } from "./ModelSelect";
import { MODES, SANDBOXES } from "./NewTaskDialog";

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
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  useEffect(() => {
    api.listWorkspaces(vault).then(setWorkspaces, () => {});
  }, [vault]);
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
        {(workspaces.length > 0 || q.workspace) && <>
          <label className="field-label">Workspace</label>
          <div className="project-row">
            <Layers size={14} className="muted" />
            <select className="model-select" value={q.workspace ?? ""} onChange={(e) => set({ workspace: e.target.value || null })}>
              <option value="">None</option>
              {workspaces.map((w) => <option key={w.rel} value={w.rel}>{w.title}</option>)}
            </select>
          </div>
          <p className="muted small">Each card's session also gets the workspace's directories, and its project when the field above is empty.</p>
        </>}
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
        <label className="field-label">Check</label>
        <div className="project-row">
          <input value={q.verify ?? ""} onChange={(e) => set({ verify: e.target.value || null })} spellCheck={false}
            placeholder="After each card's turn, e.g. pnpm check (empty: a linked spec's, or none)" />
        </div>
        <p className="muted small">
          A card moves to the review list only once its check passes or gives up; failures go back to the agent first.
          A card linked to a spec also gets the spec's acceptance check.
        </p>
        <label className="field-label">Sandbox</label>
        <div className="modes">
          {SANDBOXES.map((m) => (
            <button key={m.value} className={`mode ${(q.sandbox ?? "") === m.value ? "on" : ""}`} title={m.hint}
              onClick={() => set({ sandbox: m.value || null })}>{m.label}</button>
          ))}
        </div>
        <p className="muted small">{SANDBOXES.find((m) => m.value === (q.sandbox ?? ""))?.hint} Empty uses a linked spec's, then <code>[sandbox] unattended</code> in config.toml.</p>
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
export function ScheduleDialog({ vault, queries, onCreated, onClose }: {
  vault: string; queries: FileEntry[]; onCreated: (path: string) => void; onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("1h");
  const [prompt, setPrompt] = useState("");
  const [project, setProject] = useState("");
  // A saved query: the agent starts only when it finds something, and gets the results.
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // With a query, the prompt may stay empty: the query's own agent prompt is used.
  const ready = !!title.trim() && (!!prompt.trim() || !!query) && !busy;
  const ok = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      onCreated(await api.scheduleCreate(vault, title, when, prompt, project, query || undefined));
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
        {queries.length > 0 && <>
          <label className="field-label">Only when a query has results</label>
          <select value={query} onChange={(e) => setQuery(e.target.value)}>
            <option value="">Always run</option>
            {queries.map((f) => <option key={f.path} value={f.rel}>{f.title ?? f.rel}</option>)}
          </select>
          {query && <p className="muted small">The query runs first. With no results nothing starts; otherwise the prompt above goes to the agent with the results (empty: the query's agent prompt).</p>}
        </>}
        <label className="field-label">Project</label>
        <ProjectInput vault={vault} value={project} onChange={setProject} />
        <p className="muted small">Saved as a note in schedules/: edit it there to change the prompt, timing, model or permission_mode.</p>
        {error && <div className="banner error">{error}</div>}
        <div className="modal-foot">
          <span />
          <button className="primary" onClick={ok} disabled={!ready}>Create</button>
        </div>
      </div>
    </div>
  );
}
