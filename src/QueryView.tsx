import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  Play, Inbox, Lightbulb, Terminal, FileText, AlertCircle, ListTodo, Columns3, Heading, Link2, MessageSquareWarning, NotebookPen, Code2,
  Save, Trash2, Bookmark, Loader2, Sparkles,
} from "lucide-react";
import { api, FileEntry, FileResult, INBOX_QUERY } from "./api";
import { Md } from "./markdown/Md";
import { composing } from "./keys";
import { fmValue, queryContext, runAgent } from "./queryContext";

type Query = { query: string; glob: string; aggregate: boolean; agent?: string; agentEach?: boolean };

const OPEN_ITEMS = "select(.list.checked == false)";

const PRESETS: (Query & { name: string; icon: typeof Inbox })[] = [
  { name: "Inbox", icon: Inbox, query: INBOX_QUERY, glob: "requests/*.md", aggregate: true },
  { name: "Open tasks", icon: ListTodo, query: OPEN_ITEMS, glob: "**/*.md", aggregate: false },
  { name: "Board cards", icon: Columns3, query: OPEN_ITEMS, glob: "boards/*.md", aggregate: false },
  { name: "TODO mentions", icon: MessageSquareWarning, query: 'select(contains("TODO"))', glob: "**/*.md", aggregate: false },
  { name: "Outline", icon: Heading, query: ".h", glob: "notes/**/*.md", aggregate: false },
  { name: "Links", icon: Link2, query: ".link.url", glob: "**/*.md", aggregate: false },
  { name: "Code blocks", icon: Code2, query: ".code", glob: "notes/**/*.md", aggregate: false },
  { name: "Summaries", icon: NotebookPen, query: 'import "section" | nodes | section::find("Summary") | section::body()', glob: "sessions/*.md", aggregate: true },
  { name: "Learnings", icon: Lightbulb, query: 'import "section" | nodes | section::find("Learnings") | section::body()', glob: "sessions/*.md", aggregate: true },
  { name: "Bash commands", icon: Terminal, query: 'select(.code.lang == "tool:Bash") | .code.value', glob: "sessions/*.md", aggregate: false },
];

/** A saved query note: glob and aggregate from the frontmatter, the query from its mq block. */
function parseSaved(text: string): Query | null {
  const fm = (k: string) => text.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1]?.trim();
  const query = text.match(/```mq[^\n]*\n([\s\S]*?)\n```/)?.[1];
  if (!query) return null;
  const glob = fm("glob") ?? "**/*.md";
  return {
    query, glob: glob.startsWith('"') ? JSON.parse(glob) : glob, aggregate: fm("aggregate") !== "false",
    agent: fmValue(text, "agent"), agentEach: fm("agent_each") === "true",
  };
}

type Props = { vault: string; saved: FileEntry[]; onOpenNote: (path: string) => void };

export function QueryView({ vault, saved, onOpenNote }: Props) {
  const [query, setQuery] = useState(PRESETS[0].query);
  const [glob, setGlob] = useState(PRESETS[0].glob);
  const [aggregate, setAggregate] = useState(true);
  const [raw, setRaw] = useState(false);
  // What an agent started from the results is told, saved with the query.
  const [agent, setAgent] = useState("");
  const [agentEach, setAgentEach] = useState(false);
  const [results, setResults] = useState<FileResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string>(PRESETS[0].name);
  const [saving, setSaving] = useState<string | null>(null);

  // When the running query started, and how long the last one took.
  const [started, setStarted] = useState<number | null>(null);
  const [took, setTook] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  // Only the latest run shows its results, when an earlier one finishes after it.
  const runId = useRef(0);
  useEffect(() => {
    if (started === null) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [started]);

  const run = async (q: Query = { query, glob, aggregate }) => {
    const id = ++runId.current;
    const t0 = Date.now();
    setStarted(t0);
    setNow(t0);
    setError(null);
    try {
      const r = await api.mqEval(vault, q.query, { glob: q.glob, aggregate: q.aggregate });
      if (id !== runId.current) return;
      setResults(r);
    } catch (e) {
      if (id !== runId.current) return;
      setError(String(e));
      setResults(null);
    }
    setTook(Date.now() - t0);
    setStarted(null);
  };
  const running = started !== null;

  /** Loads a query into the form and runs it. */
  const pick = (name: string, q: Query) => {
    setCurrent(name);
    setQuery(q.query);
    setGlob(q.glob);
    setAggregate(q.aggregate);
    setAgent(q.agent ?? "");
    setAgentEach(!!q.agentEach);
    run(q);
  };

  const openSaved = async (f: FileEntry) => {
    const q = parseSaved(await api.readNote(vault, f.path));
    if (q) pick(f.title ?? f.rel, q);
    else setError(`No mq block in ${f.rel}`);
  };

  const save = async (name: string) => {
    try {
      await api.saveQuery(vault, name, query, glob, aggregate, agent, agentEach);
      setCurrent(name);
      setSaving(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (f: FileEntry) => {
    if (!(await ask(`Delete the saved query ${f.rel}?`, { title: "Delete query", kind: "warning", okLabel: "Delete" }))) return;
    await api.deleteNote(vault, f.path).catch((e) => setError(String(e)));
  };

  const count = results?.reduce((n, r) => n + r.items.length, 0) ?? 0;
  const savedName = (f: FileEntry) => f.title ?? f.rel.replace(/^queries\//, "").replace(/\.md$/, "");

  return (
    <div className="query">
      <div className="query-inner">
        <h2>mq query</h2>
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.name} className={current === p.name ? "on" : ""} onClick={() => pick(p.name, p)}>
              <p.icon size={13} /> {p.name}
            </button>
          ))}
        </div>
        {saved.length > 0 && (
          <div className="presets saved">
            {saved.map((f) => (
              <span key={f.path} className={`saved-query ${current === savedName(f) ? "on" : ""}`}>
                <button onClick={() => openSaved(f)} title={f.rel}><Bookmark size={13} /> {savedName(f)}</button>
                <button className="icon" title="Open the query note" onClick={() => onOpenNote(f.path)}><FileText size={12} /></button>
                <button className="icon" title="Delete" onClick={() => remove(f)}><Trash2 size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="query-form">
          <textarea value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(); }} />
          <div className="row">
            <span className="glob"><FileText size={13} />
              <input value={glob} onChange={(e) => setGlob(e.target.value)} placeholder="glob, relative to the vault" />
            </span>
            <label className="check"><input type="checkbox" checked={aggregate} onChange={(e) => setAggregate(e.target.checked)} /> Aggregate (-A)</label>
            <label className="check"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> Raw</label>
            {saving === null ? (
              <button onClick={() => setSaving(PRESETS.some((p) => p.name === current) ? "" : current)} title="Save as queries/<name>.md">
                <Save size={13} /> Save
              </button>
            ) : (
              <span className="save-query">
                <input autoFocus value={saving} placeholder="e.g. open-bugs" onChange={(e) => setSaving(e.target.value)}
                  onBlur={() => setSaving(null)}
                  onKeyDown={(e) => {
                    if (composing(e)) return;
                    if (e.key === "Enter" && saving.trim()) save(saving.trim());
                    if (e.key === "Escape") setSaving(null);
                  }} />
              </span>
            )}
            <button onClick={() => results && runAgent(queryContext(vault, query, glob, results, { prompt: agent, perFile: agentEach }))}
              disabled={running || count === 0} title="Start an agent on these results">
              <Sparkles size={13} /> Run agent
            </button>
            <button className="primary" onClick={() => run()} disabled={running}>
              {running ? <Loader2 size={13} className="spin" /> : <Play size={13} />} {running ? "Running…" : "Run"}
            </button>
          </div>
        </div>
        <div className="query-agent">
          <Sparkles size={13} />
          <input value={agent} onChange={(e) => setAgent(e.target.value)}
            placeholder="Agent prompt for the results (saved with the query; scheduled runs use it too)" />
          <label className="check"><input type="checkbox" checked={agentEach} onChange={(e) => setAgentEach(e.target.checked)} /> One session per file</label>
        </div>
        {error && <div className="banner error"><AlertCircle size={14} /><pre>{error}</pre></div>}
        {running ? (
          <div className="muted small result-count query-running">
            <Loader2 size={12} className="spin" /> Running the query on {glob || "every note"}… {((now - started) / 1000).toFixed(1)}s
          </div>
        ) : results && (
          <div className="muted small result-count">{count} results in {results.length} files{took !== null && ` · ${(took / 1000).toFixed(1)}s`}</div>
        )}
        <div className={`query-results ${running ? "stale" : ""}`}>
          {results?.map((r, i) => (
            <div key={i} className="query-result">
              {r.file && <a className="query-file" onClick={() => onOpenNote(r.file!)}><FileText size={12} /> {r.file.replace(vault + "/", "")}</a>}
              {raw ? <pre>{r.items.join("\n")}</pre> : <Md>{r.items.join("\n\n")}</Md>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
