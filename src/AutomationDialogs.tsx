import { useEffect, useState } from "react";
import { FolderGit2, Timer, X } from "lucide-react";
import { api, FileEntry } from "./api";
import { composing } from "./keys";

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
