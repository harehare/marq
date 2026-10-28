import { useEffect, useState } from "react";
import { BookOpen, ChevronRight, FolderGit2, ListChecks, SearchCheck, Sparkles, Wand2, X } from "lucide-react";
import { api } from "./api";
import { ModelSelect } from "./ModelSelect";
import { composing } from "./keys";

export type Intent = "do" | "review" | "plan" | "explain";

export type AskOptions = {
  intent: Intent;
  instruction: string;
  /** Present only when the options were opened; otherwise the note's frontmatter applies. */
  project?: string;
  worktree?: boolean;
  model?: string;
  excerpt?: { text: string; from: number; to: number };
};

const INTENTS: { key: Intent; label: string; icon: typeof Wand2; hint: string }[] = [
  { key: "do", label: "Do it", icon: Wand2, hint: "Claude does what the section says" },
  { key: "review", label: "Review", icon: SearchCheck, hint: "Problems, risks and suggestions; no file changes" },
  { key: "plan", label: "Plan", icon: ListChecks, hint: "A step-by-step plan in plan mode; no file changes" },
  { key: "explain", label: "Explain", icon: BookOpen, hint: "Investigate and answer; no file changes" },
];

const INTENT_KEY = "marq.lastIntent";

/** Frontmatter `key: value`, unquoted. */
const fm = (text: string, key: string) => {
  const v = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"))?.[1]?.trim() ?? "";
  return v.startsWith('"') ? (JSON.parse(v) as string) : v;
};

/** Ask Claude about a section or a selection: what to do, a short instruction, and (⌥) run options. */
export function AskDialog({ vault, note, excerpt, showOptions = false, onRun, onClose }: {
  vault: string;
  note: string;
  excerpt?: AskOptions["excerpt"];
  showOptions?: boolean;
  onRun: (o: AskOptions) => Promise<void>;
  onClose: () => void;
}) {
  const [intent, setIntent] = useState<Intent>(() => {
    try {
      return (localStorage.getItem(INTENT_KEY) as Intent) || "do";
    } catch {
      return "do";
    }
  });
  const [instruction, setInstruction] = useState("");
  const [options, setOptions] = useState(showOptions);
  const [project, setProject] = useState(() => fm(note, "project"));
  const [worktree, setWorktree] = useState(() => fm(note, "worktree") !== "false");
  const [model, setModel] = useState(() => fm(note, "model"));
  const [projects, setProjects] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (options) api.recentProjects(vault).then(setProjects);
  }, [vault, options]);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      localStorage.setItem(INTENT_KEY, intent);
    } catch {}
    try {
      await onRun({ intent, instruction, excerpt, ...(options ? { project: project.trim(), worktree, model } : {}) });
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal ask" onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        // ⌘1-4 pick the intent without leaving the text box.
        if ((e.metaKey || e.ctrlKey) && /^[1-4]$/.test(e.key)) {
          e.preventDefault();
          setIntent(INTENTS[Number(e.key) - 1].key);
        }
      }}>
        <div className="modal-head">
          <h3><Sparkles size={16} /> Ask Claude {excerpt ? `about lines ${excerpt.from + 1}-${excerpt.to + 1}` : "about this section"}</h3>
          <button className="icon" onClick={onClose}><X size={15} /></button>
        </div>
        {excerpt && <blockquote className="ask-excerpt">{excerpt.text.length > 400 ? `${excerpt.text.slice(0, 400)}…` : excerpt.text}</blockquote>}
        <div className="modes">
          {INTENTS.map((i, n) => (
            <button key={i.key} className={`mode ${intent === i.key ? "on" : ""}`} onClick={() => setIntent(i.key)} title={`${i.hint} (⌘${n + 1})`}>
              <i.icon size={13} /> {i.label}
            </button>
          ))}
        </div>
        <p className="muted small">{INTENTS.find((i) => i.key === intent)?.hint}</p>
        <textarea autoFocus className="ask-input" value={instruction} onChange={(e) => setInstruction(e.target.value)}
          placeholder="Anything to add? e.g. focus on error handling  (optional, ↵ to start, ⇧↵ for a new line)"
          onKeyDown={(e) => {
            if (composing(e)) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              run();
            }
          }} />
        <button className="ask-more" onClick={() => setOptions(!options)}>
          <ChevronRight size={12} className={`chev ${options ? "open" : ""}`} /> Project, worktree and model
        </button>
        {options && (
          <div className="ask-options">
            <div className="project-row">
              <FolderGit2 size={14} className="muted" />
              <input list="ask-projects" value={project} onChange={(e) => setProject(e.target.value)}
                placeholder="~/dev/your-repo (empty: run in the vault)" />
              <datalist id="ask-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
            </div>
            <label className="check">
              <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
              Work in a new worktree (git repositories)
            </label>
            <ModelSelect value={model} onChange={setModel} />
            <p className="muted small">Only for this run; the note keeps its settings.</p>
          </div>
        )}
        {error && <div className="banner error">{error}</div>}
        <div className="modal-foot">
          <span className="spacer" />
          <button className="primary" onClick={run} disabled={busy}><Sparkles size={14} /> Start ↵</button>
        </div>
      </div>
    </div>
  );
}
