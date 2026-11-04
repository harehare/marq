import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { FolderGit2, FolderSearch, GitCompare, Loader2, Sparkles, Users, X } from "lucide-react";
import { api, type AgentInfo } from "./api";
import { SlashTextarea } from "./SlashTextarea";
import { usePastes } from "./pastes";
import { useAutoGrow } from "./useAutoGrow";
import { ModelSelect } from "./ModelSelect";
import { QueryContext } from "./queryContext";

type Props = {
  vault: string;
  onClose: () => void;
  onStarted: (sessionId: string, title: string) => void;
  /** A task started as a crew (Team). */
  onStartedCrew: (rel: string, title: string) => void;
  /** A task saved as a request note without running it. */
  onSaved: (rel: string) => void;
  /** A task run on several models; the session ids to compare. */
  onStartedCompare: (ids: string[], title: string) => void;
  initialPrompt?: string;
  /** mq results to give the agent along with the prompt, in one session or one per file. */
  context?: QueryContext;
};

/** More sessions than this in one go is more likely a mistake than a plan. */
const MAX_FANOUT = 10;

export const MODES = [
  { value: "auto", label: "Auto", hint: "A classifier reviews each action instead of you" },
  { value: "default", label: "Ask", hint: "Edits and commands wait for your approval in the session" },
  { value: "acceptEdits", label: "Accept edits", hint: "File edits run without asking; commands still ask" },
  { value: "plan", label: "Plan only", hint: "The agent plans but does not change files" },
];

const PROJECT_KEY = "marq.lastProject";
const AGENT_KEY = "marq.lastAgent";
const MODEL_KEY = "marq.lastModel";
const MODE_KEY = "marq.lastMode";
const TEAM_KEY = "marq.lastTeam";
const WORKTREE_KEY = "marq.lastWorktree";

function stored(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Starts a task. It is saved as a request note first, so the task stays in the knowledge base. */
export function NewTaskDialog({ vault, onClose, onStarted, onStartedCrew, onSaved, onStartedCompare, initialPrompt = "", context }: Props) {
  const [prompt, setPrompt] = useState(initialPrompt || context?.prompt || "");
  const pastes = usePastes();
  const [title, setTitle] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState(() => stored(PROJECT_KEY, ""));
  const [mode, setMode] = useState(() => stored(MODE_KEY, "auto"));
  const [model, setModel] = useState(() => stored(MODEL_KEY, ""));
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agent, setAgent] = useState(() => stored(AGENT_KEY, "claude"));
  const [carry, setCarry] = useState(false);
  // More models to run the same task on, to compare the results.
  const [extra, setExtra] = useState<string[]>([]);
  const [worktree, setWorktree] = useState(() => stored(WORKTREE_KEY, "true") === "true");
  // One session that may hand large work to a crew, or a crew from the start.
  const [team, setTeam] = useState(() => stored(TEAM_KEY, "") === "true");
  // With mq results from several files: one session for all of them, or one per file.
  const [perFile, setPerFile] = useState(!!context?.perFile);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(promptRef, prompt, 420);

  useEffect(() => {
    const un = listen<string>("task://progress", (e) => setStage(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    api.recentProjects(vault).then(setProjects);
    api.listAgents().then((list) => {
      setAgents(list);
      // An agent removed from config.toml since it was last used.
      setAgent((a) => (list.some((x) => x.id === a) ? a : "claude"));
    }, () => {});
    promptRef.current?.focus();
  }, [vault]);

  const browse = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") setProject(dir);
  };

  // Teams, model choice and comparisons are Claude's; other agents (ACP) run one session on their own model.
  const other = !team && agent !== "claude";
  const comparing = worktree && !team && !other && extra.length > 0;
  const runOn = other ? { agent, model: undefined } : { model };
  const canSplit = !!context && context.files > 1 && context.files <= MAX_FANOUT && !team && !comparing;
  const splitting = canSplit && perFile;
  // The agent gets the instruction, then the results; a saved request keeps both.
  const withContext = (text: string, results = context?.all) => {
    const full = pastes.expand(text);
    return results ? `${full.trim()}\n\n${results}` : full;
  };
  const derivedTitle = title.trim() || pastes.expand(prompt).trim().split("\n")[0].slice(0, 60);

  const start = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setStage("Saving the request…");
    try {
      try {
        localStorage.setItem(PROJECT_KEY, project);
        localStorage.setItem(MODE_KEY, mode);
        localStorage.setItem(MODEL_KEY, model);
        localStorage.setItem(AGENT_KEY, agent);
        localStorage.setItem(TEAM_KEY, String(team));
        localStorage.setItem(WORKTREE_KEY, String(worktree));
      } catch {}
      if (team) {
        const c = await api.newCrew(vault, { title: derivedTitle, prompt: withContext(prompt), project, autoTitle: !title.trim() });
        onStartedCrew(c.rel, c.title);
        onClose();
        return;
      }
      if (comparing) {
        const r = await api.newTaskCompare(
          vault,
          { title: derivedTitle, prompt: withContext(prompt), project, permissionMode: mode, carryChanges: carry, worktree, autoTitle: !title.trim() },
          [model, ...extra],
        );
        onStartedCompare(r.sessions.map((x) => x.session_id), r.sessions[0]?.title ?? derivedTitle);
        onClose();
        return;
      }
      if (splitting && context) {
        let first: { session_id: string; title: string } | undefined;
        for (const [i, each] of context.each.entries()) {
          setStage(`Starting session ${i + 1} of ${context.each.length}…`);
          const t = await api.newTask(vault, {
            title: `${derivedTitle} · ${context.names[i]}`, prompt: withContext(prompt, each), project, permissionMode: mode, ...runOn,
            carryChanges: carry, worktree, autoTitle: false,
          });
          first ??= t;
        }
        if (first) onStarted(first.session_id, first.title);
        onClose();
        return;
      }
      const started = await api.newTask(vault, {
        title: derivedTitle, prompt: withContext(prompt), project, permissionMode: mode, ...runOn, carryChanges: carry, worktree, autoTitle: !title.trim(),
      });
      onStarted(started.session_id, started.title);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
      setStage(null);
    }
  };

  const save = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setStage("Saving the request…");
    try {
      const rel = await api.saveTask(vault, {
        title: derivedTitle, prompt: withContext(prompt), project, permissionMode: mode, ...runOn, carryChanges: carry, worktree, autoTitle: !title.trim(),
      });
      onSaved(rel);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
      setStage(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="modal-head">
          <h3><Sparkles size={16} /> New task</h3>
          <button className="icon" onClick={onClose}><X size={15} /></button>
        </div>
        <SlashTextarea
          ref={promptRef}
          className="task-prompt"
          value={prompt}
          onChange={setPrompt}
          pastes={pastes}
          vault={vault}
          cwd={project.trim() || undefined}
          placement="below"
          placeholder={context ? "What should the agent do with these results?  Type / for skills and commands" : "Describe the task…  Type / for skills and commands"}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") start();
          }}
        />
        {context && (
          <div className="query-context">
            <p className="muted small">
              <Sparkles size={12} /> {context.items} mq result{context.items === 1 ? "" : "s"} from {context.files} file{context.files === 1 ? "" : "s"} go to the agent after your prompt.
            </p>
            {context.files > 1 && (
              <div className="modes">
                <button className={`mode ${!splitting ? "on" : ""}`} onClick={() => setPerFile(false)}>One session</button>
                <button className={`mode ${splitting ? "on" : ""}`} onClick={() => setPerFile(true)} disabled={!canSplit}
                  title={canSplit ? "" : `Up to ${MAX_FANOUT} files, and not for a team or a comparison`}>
                  One session per file ({context.files})
                </button>
              </div>
            )}
          </div>
        )}
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (empty: named automatically)" />
        <label className="field-label">Project</label>
        <div className="project-row">
          <FolderGit2 size={14} className="muted" />
          <input list="marq-projects" value={project} onChange={(e) => setProject(e.target.value)}
            placeholder="~/dev/git/your-repo (empty: run in the vault)" />
          <datalist id="marq-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
          <button onClick={browse}><FolderSearch size={14} /> Browse</button>
        </div>
        <label className="field-label">Who works on it</label>
        <div className="modes">
          <button className={`mode ${!team ? "on" : ""}`} onClick={() => setTeam(false)}>
            <Sparkles size={13} /> One session
          </button>
          <button className={`mode ${team ? "on" : ""}`} onClick={() => setTeam(true)}>
            <Users size={13} /> Team
          </button>
        </div>
        <p className="muted small">
          {team
            ? "Starts a crew: a lead forms the team (e.g. impl, reviewer, tester), they agree on a plan, and build, review and test together. Saved in crews/."
            : "One agent session. If the task turns out to be large, it can suggest handing it to a crew, and you approve it."}
        </p>
        {!team && <>
        <label className="check">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
          Work in a new worktree
        </label>
        <p className="muted small">
          {worktree
            ? "A git repository gets its own worktree and branch from HEAD, so tasks can run in parallel. Rename the branch later from the Changes panel."
            : "The agent works directly in the project, on whatever is checked out. Tasks in the same project can get in each other's way."}
        </p>
        {worktree && (
          <label className="check">
            <input type="checkbox" checked={carry} onChange={(e) => setCarry(e.target.checked)} />
            Include my uncommitted changes and untracked files
          </label>
        )}

        {!team && agents.length > 1 && <>
          <label className="field-label">Agent</label>
          <select className="model-select" value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.installed && a.id !== agent}>
                {a.label}{a.installed ? "" : ` (not found: ${a.command})`}
              </option>
            ))}
          </select>
          {other && <p className="muted small">Runs over ACP on the agent's own default model. Add or change agents under [agents] in config.toml.</p>}
        </>}
        {!other && <>
        <label className="field-label">Model</label>
        <ModelSelect value={model} onChange={setModel} />
        </>}
        {worktree && !other && extra.map((m, i) => (
          <div key={i} className="compare-row">
            <ModelSelect value={m} onChange={(v) => setExtra(extra.map((x, j) => (j === i ? v : x)))} />
            <button className="icon" onClick={() => setExtra(extra.filter((_, j) => j !== i))} title="Remove"><X size={13} /></button>
          </div>
        ))}
        {worktree && !other && extra.length < 3 && (
          <button className="compare-add" onClick={() => setExtra([...extra, model])}>
            <GitCompare size={13} /> Compare with another model
          </button>
        )}
        {comparing && <p className="muted small">Runs the same task once per model, each in its own worktree. You compare the results side by side and keep one.</p>}

        <label className="field-label">Permissions</label>
        <div className="modes" title={MODES.find((m) => m.value === mode)?.hint}>
          {MODES.map((m) => (
            <button key={m.value} className={`mode ${mode === m.value ? "on" : ""}`} onClick={() => setMode(m.value)} title={m.hint}>
              {m.label}
            </button>
          ))}
        </div>
        <p className="muted small">{MODES.find((m) => m.value === mode)?.hint}</p>
        </>}
        {error && <div className="banner error">{error}</div>}
        <div className="modal-foot">
          {busy && stage ? (
            <span className="stage small"><Loader2 size={13} className="spin" /> {stage}</span>
          ) : (
            <span className="muted small">{team ? "Saved as a crew note in crews/" : "Saved as a request note in requests/"}</span>
          )}
          {!team && !comparing && (
            <button onClick={save} disabled={!prompt.trim() || busy} title="Save as a request note in the Inbox and start it later">
              Save for later
            </button>
          )}
          <button className="primary" onClick={start} disabled={!prompt.trim() || busy}>
            <Sparkles size={14} /> {comparing ? `Start ${extra.length + 1} runs` : splitting ? `Start ${context!.files} sessions` : "Start"} ⌘↵
          </button>
        </div>
      </div>
    </div>
  );
}
