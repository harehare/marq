import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { ChevronRight, FolderGit2, FolderPlus, FolderSearch, GitCompare, Layers, Loader2, Save, Sparkles, Users, X } from "lucide-react";
import { api, type AgentInfo, type DirSpec, type TaskChecks, type Workspace } from "./api";
import { SlashTextarea } from "./SlashTextarea";
import { usePastes } from "./pastes";
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
const SANDBOX_KEY = "marq.lastSandbox";
const WORKSPACE_KEY = "marq.lastWorkspace";
/** The verify command is per project: `marq.verify:<project>`. */
const VERIFY_KEY = "marq.verify:";
const RPI = ["research", "plan", "implement"];

export const SANDBOXES = [
  { value: "", label: "Off", hint: "Commands run with your permissions, as Claude Code's settings allow." },
  { value: "on", label: "On", hint: "Bash runs in Claude Code's OS sandbox: writes only in the working directory, network through its allowlist. A command that fails there may ask to run outside it." },
  { value: "strict", label: "Strict", hint: "The sandbox, with no way out: commands that need more fail instead of asking." },
];

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
  const [phased, setPhased] = useState(false);
  const [verify, setVerify] = useState("");
  const [fresh, setFresh] = useState(false);
  const [acceptance, setAcceptance] = useState("");
  const [sandbox, setSandbox] = useState(() => stored(SANDBOX_KEY, ""));
  // A workspace fills in the project and the other directories; changing either leaves it as a one-off set.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wsRel, setWsRel] = useState("");
  const [dirs, setDirs] = useState<DirSpec[]>([]);
  const [savingAs, setSavingAs] = useState<string | null>(null);
  const pickWorkspace = (rel: string, list = workspaces) => {
    const ws = list.find((w) => w.rel === rel);
    setWsRel(ws ? rel : "");
    if (!ws) return setDirs([]);
    if (ws.project) setProject(ws.project);
    setDirs(ws.directories);
  };
  useEffect(() => {
    api.listWorkspaces(vault).then((list) => {
      setWorkspaces(list);
      const last = stored(WORKSPACE_KEY, "");
      if (last) pickWorkspace(last, list);
    }, () => {});
  }, [vault]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = workspaces.find((w) => w.rel === wsRel);
  // Still exactly the workspace: the request refers to it, so later edits to the workspace apply.
  const asChosen = !!chosen && (chosen.project ?? project) === project && JSON.stringify(chosen.directories) === JSON.stringify(dirs);
  const setDir = (i: number, d: Partial<DirSpec>) => setDirs(dirs.map((x, j) => (j === i ? { ...x, ...d } : x)));
  const addDir = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") setDirs([...dirs, { path: dir.replace(/^\/Users\/[^/]+/, "~"), worktree: true }]);
  };
  const saveWorkspace = async () => {
    if (!savingAs?.trim()) return;
    try {
      const path = await api.createWorkspace(vault, savingAs.trim(), project, dirs.filter((d) => d.path.trim()));
      const list = await api.listWorkspaces(vault);
      setWorkspaces(list);
      const made = list.find((w) => w.path === path);
      if (made) setWsRel(made.rel);
      setSavingAs(null);
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => setVerify(stored(VERIFY_KEY + project, "")), [project]);
  // With mq results from several files: one session for all of them, or one per file.
  const [perFile, setPerFile] = useState(!!context?.perFile);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  // The prompt fills the left column (see .task-main), so it is not sized to its text.
  const promptRef = useRef<HTMLTextAreaElement>(null);

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
  const checks: TaskChecks = {
    verify: verify.trim() || undefined,
    verifyRetry: verify.trim() && fresh ? "fresh" : undefined,
    acceptance: acceptance.trim() || undefined,
    sandbox: other ? undefined : sandbox || undefined,
    phases: phased ? RPI : undefined,
    workspace: asChosen ? wsRel : undefined,
    directories: asChosen ? undefined : dirs.filter((d) => d.path.trim()),
  };

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
        localStorage.setItem(SANDBOX_KEY, sandbox);
        localStorage.setItem(WORKSPACE_KEY, asChosen ? wsRel : "");
        localStorage.setItem(VERIFY_KEY + project, verify.trim());
      } catch {}
      if (team) {
        const c = await api.newCrew(vault, {
          title: derivedTitle, prompt: withContext(prompt), project, autoTitle: !title.trim(),
          workspace: checks.workspace, directories: checks.directories,
        });
        onStartedCrew(c.rel, c.title);
        onClose();
        return;
      }
      if (comparing) {
        const r = await api.newTaskCompare(
          vault,
          { title: derivedTitle, prompt: withContext(prompt), project, permissionMode: mode, carryChanges: carry, worktree, autoTitle: !title.trim(), ...checks },
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
            carryChanges: carry, worktree, autoTitle: false, ...checks,
          });
          first ??= t;
        }
        if (first) onStarted(first.session_id, first.title);
        onClose();
        return;
      }
      const started = await api.newTask(vault, {
        title: derivedTitle, prompt: withContext(prompt), project, permissionMode: mode, ...runOn, carryChanges: carry, worktree, autoTitle: !title.trim(), ...checks,
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
        title: derivedTitle, prompt: withContext(prompt), project, permissionMode: mode, ...runOn, carryChanges: carry, worktree, autoTitle: !title.trim(), ...checks,
      });
      onSaved(rel);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
      setStage(null);
    }
  };

  // One line per group, so a closed group still says what it is set to.
  const modelLabel = (m: string) => (m ? m.replace(/^ollama:/, "").replace(/^\w/, (c) => c.toUpperCase()) : "Default model");
  const runSummary = team
    ? "Set per member in the crew note"
    : [
        other ? agents.find((a) => a.id === agent)?.label ?? agent : comparing ? [model, ...extra].map(modelLabel).join(" vs ") : modelLabel(model),
        MODES.find((m) => m.value === mode)?.label,
        worktree ? (carry ? "worktree + my changes" : "worktree") : "in the project",
      ].join(" · ");
  const checksSummary = [
    phased && "research → plan → implement",
    verify.trim() && `${verify.trim()}${fresh ? " (fresh retries)" : ""}`,
    acceptance.trim() && "acceptance",
  ].filter(Boolean).join(" · ") || "None";
  const sandboxSummary = SANDBOXES.find((m) => m.value === sandbox)?.label ?? "Off";
  const whereSummary = [asChosen ? chosen?.title : null, project.trim() || "the vault", dirs.length ? `+${dirs.length}` : null].filter(Boolean).join(" · ");

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal task-modal" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="modal-head">
          <h3><Sparkles size={16} /> New task</h3>
          <button className="icon" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="task-body">
          <div className="task-main">
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
            <div className="modes">
              <button className={`mode ${!team ? "on" : ""}`} onClick={() => setTeam(false)}
                title="One agent session. If the task turns out to be large, it can suggest handing it to a crew, and you approve it.">
                <Sparkles size={13} /> One session
              </button>
              <button className={`mode ${team ? "on" : ""}`} onClick={() => setTeam(true)}
                title="Starts a crew: a lead forms the team (e.g. impl, reviewer, tester), they agree on a plan, and build, review and test together. Saved in crews/.">
                <Users size={13} /> Team
              </button>
            </div>
          </div>

          <aside className="task-side">
            <Section id="where" title="Where" summary={whereSummary} defaultOpen>
              {workspaces.length > 0 && (
                <div className="project-row">
                  <Layers size={14} className="muted" />
                  <select className="model-select" value={asChosen ? wsRel : ""} onChange={(e) => pickWorkspace(e.target.value)} title="Workspace">
                    <option value="">{chosen && !asChosen ? `${chosen.title} (changed)` : "No workspace"}</option>
                    {workspaces.map((w) => <option key={w.rel} value={w.rel}>{w.title}</option>)}
                  </select>
                </div>
              )}
              <div className="project-row">
                <FolderGit2 size={14} className="muted" />
                <input list="marq-projects" value={project} onChange={(e) => setProject(e.target.value)} {...pathInput()}
                  placeholder="Project (empty: the vault)" title={project || "Where the agent runs"} />
                <datalist id="marq-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
                <button className="icon" onClick={browse} title="Browse for the project"><FolderSearch size={14} /></button>
              </div>
              {dirs.map((d, i) => (
                <div className="project-row dir-row" key={i}>
                  <input value={d.path} onChange={(e) => setDir(i, { path: e.target.value })} {...pathInput()}
                    placeholder="~/dev/git/another-repo" spellCheck={false} title={d.path} />
                  <label className="check" title={team
                    ? "Members with their own worktree get one in this repository; the others use it as it is"
                    : "This git repository gets its own worktree on the task's branch, shown in the Changes panel"}>
                    <input type="checkbox" checked={d.worktree} onChange={(e) => setDir(i, { worktree: e.target.checked })} /> wt
                  </label>
                  <button className="icon" onClick={() => setDirs(dirs.filter((_, j) => j !== i))} title="Remove"><X size={13} /></button>
                </div>
              ))}
              {savingAs === null ? (
                <div className="dir-actions">
                  <button className="link" onClick={addDir} title="Let the agent read and edit another directory too"><FolderPlus size={13} /> Add a directory</button>
                  <button className="link" onClick={() => setSavingAs("")} disabled={!project.trim() && !dirs.length}
                    title="Save the project and these directories as a workspace note, to pick them again"><Save size={13} /> Save as workspace</button>
                </div>
              ) : (
                <div className="project-row">
                  <input autoFocus value={savingAs} onChange={(e) => setSavingAs(e.target.value)} placeholder="Workspace name"
                    onKeyDown={(e) => { if (e.key === "Enter") saveWorkspace(); if (e.key === "Escape") { e.stopPropagation(); setSavingAs(null); } }} />
                  <button className="primary" onClick={saveWorkspace} disabled={!savingAs.trim()}>Save</button>
                </div>
              )}
            </Section>

            <Section id="run" title="Run" summary={runSummary} disabled={team}>
              {agents.length > 1 && (
                <select className="model-select" value={agent} onChange={(e) => setAgent(e.target.value)}
                  title="Agents other than Claude run over ACP on their own default model. Add or change them under [agents] in config.toml.">
                  {agents.map((a) => (
                    <option key={a.id} value={a.id} disabled={!a.installed && a.id !== agent}>
                      {a.label}{a.installed ? "" : ` (not found: ${a.command})`}
                    </option>
                  ))}
                </select>
              )}
              {!other && <ModelSelect value={model} onChange={setModel} />}
              {worktree && !other && extra.map((m, i) => (
                <div key={i} className="compare-row">
                  <ModelSelect value={m} onChange={(v) => setExtra(extra.map((x, j) => (j === i ? v : x)))} />
                  <button className="icon" onClick={() => setExtra(extra.filter((_, j) => j !== i))} title="Remove"><X size={13} /></button>
                </div>
              ))}
              {worktree && !other && extra.length < 3 && (
                <button className="link compare-add" onClick={() => setExtra([...extra, model])}
                  title="Run the same task once per model, each in its own worktree, compare the results side by side and keep one">
                  <GitCompare size={13} /> Compare with another model
                </button>
              )}
              <div className="modes">
                {MODES.map((m) => (
                  <button key={m.value} className={`mode ${mode === m.value ? "on" : ""}`} onClick={() => setMode(m.value)} title={m.hint}>
                    {m.label}
                  </button>
                ))}
              </div>
              <label className="check" title="A git repository gets its own worktree and branch from HEAD, so tasks can run in parallel">
                <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
                Work in a new worktree
              </label>
              {worktree && (
                <label className="check">
                  <input type="checkbox" checked={carry} onChange={(e) => setCarry(e.target.checked)} />
                  Include my uncommitted changes
                </label>
              )}
            </Section>

            <Section id="checks" title="Checks" summary={checksSummary}>
              <label className="check"
                title="Each phase is a new session on the same worktree and gets the earlier phases' replies. After each one the request waits in review; Start on it runs the next (or phase_gate: auto in the note).">
                <input type="checkbox" checked={phased} onChange={(e) => setPhased(e.target.checked)} />
                In phases: research → plan → implement
              </label>
              <div className="project-row">
                <input value={verify} onChange={(e) => setVerify(e.target.value)} spellCheck={false}
                  placeholder="After each turn, e.g. pnpm check"
                  title="Runs in the session's directory when a turn ends. A failure goes back to the agent with its output, up to 2 times (verify_retries in the note for more)." />
              </div>
              {verify.trim() && (
                <label className="check">
                  <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />
                  Retry in a new session (fresh context)
                </label>
              )}
              <textarea className="acceptance" rows={2} value={acceptance} onChange={(e) => setAcceptance(e.target.value)}
                placeholder="Acceptance criteria (optional)"
                title="Not shown to the agent: a separate session checks the work against them" />
            </Section>

            {!team && !other && (
              <Section id="sandbox" title="Sandbox" summary={sandboxSummary}>
                <div className="modes">
                  {SANDBOXES.map((m) => (
                    <button key={m.value} className={`mode ${sandbox === m.value ? "on" : ""}`} onClick={() => setSandbox(m.value)} title={m.hint}>
                      {m.label}
                    </button>
                  ))}
                </div>
                <p className="muted small">{SANDBOXES.find((m) => m.value === sandbox)?.hint}</p>
              </Section>
            )}

            {/* Choices with a catch are spelled out; the rest is in the tooltips. */}
            {!team && !worktree && (
              <p className="task-warn small">Works directly in the project: tasks in the same project can get in each other's way.</p>
            )}
            {!team && mode === "default" && (
              <p className="task-warn small">Ask: edits and commands wait in the session until you approve them.</p>
            )}
            {team && dirs.length > 0 && (
              <p className="muted small">Members with their own worktree get one in each repository marked wt; the others use them as they are.</p>
            )}
          </aside>
        </div>
        {error && <div className="banner error">{error}</div>}
        <div className="modal-foot">
          {busy && stage ? (
            <span className="stage small"><Loader2 size={13} className="spin" /> {stage}</span>
          ) : (
            <span className="muted small">{team ? "Saved as a crew note in crews/" : "Saved as a request note in requests/"}</span>
          )}
          <span>
            {!team && !comparing && (
              <button onClick={save} disabled={!prompt.trim() || busy} title="Save as a request note in the vault and start it later">
                Save for later
              </button>
            )}
            <button className="primary" onClick={start} disabled={!prompt.trim() || busy}>
              <Sparkles size={14} /> {comparing ? `Start ${extra.length + 1} runs` : splitting ? `Start ${context?.files} sessions` : "Start"} ⌘↵
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * A path field that shows the end of a long path (the directory's own name) while it is not being
 * edited; the start is what directories have in common.
 */
function pathInput() {
  const toEnd = (el: HTMLInputElement | null) => {
    if (el && document.activeElement !== el) el.scrollLeft = el.scrollWidth;
  };
  return {
    // A new callback each render, so it also runs after the value changes (a picked workspace or folder).
    ref: (el: HTMLInputElement | null) => {
      requestAnimationFrame(() => toEnd(el));
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => toEnd(e.currentTarget),
  };
}

const SECTION_KEY = "marq.taskSection.";

/** A group of settings: its title and a one-line summary, opened to change them. Remembers whether it was open. */
function Section({ id, title, summary, defaultOpen = false, disabled = false, children }: {
  id: string; title: string; summary: string; defaultOpen?: boolean; disabled?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => stored(SECTION_KEY + id, String(defaultOpen)) === "true");
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(SECTION_KEY + id, String(!open));
    } catch {}
  };
  const shown = open && !disabled;
  return (
    <section className={`task-section ${shown ? "open" : ""} ${disabled ? "disabled" : ""}`}>
      <button className="task-section-head" onClick={toggle} disabled={disabled} aria-expanded={shown}>
        <ChevronRight size={13} className="chev" />
        <span className="field-label">{title}</span>
        {!shown && <span className="task-section-summary" title={summary}>{summary}</span>}
      </button>
      {shown && <div className="task-section-body">{children}</div>}
    </section>
  );
}
