import { useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  Play, Inbox, Lightbulb, Terminal, FileText, AlertCircle, ListTodo, Columns3, Heading, Link2, MessageSquareWarning, NotebookPen, Code2,
  Save, Trash2, Bookmark,
} from "lucide-react";
import { api, FileEntry, FileResult, INBOX_QUERY } from "./api";
import { Md } from "./markdown/Md";
import { composing } from "./keys";

type Query = { query: string; glob: string; aggregate: boolean };

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
  return { query, glob: glob.startsWith('"') ? JSON.parse(glob) : glob, aggregate: fm("aggregate") !== "false" };
}

type Props = { vault: string; saved: FileEntry[]; onOpenNote: (path: string) => void };

export function QueryView({ vault, saved, onOpenNote }: Props) {
  const [query, setQuery] = useState(PRESETS[0].query);
  const [glob, setGlob] = useState(PRESETS[0].glob);
  const [aggregate, setAggregate] = useState(true);
  const [raw, setRaw] = useState(false);
  const [results, setResults] = useState<FileResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string>(PRESETS[0].name);
  const [saving, setSaving] = useState<string | null>(null);

  const run = async (q: Query = { query, glob, aggregate }) => {
    try {
      setError(null);
      setResults(await api.mqEval(vault, q.query, { glob: q.glob, aggregate: q.aggregate }));
    } catch (e) {
      setError(String(e));
      setResults(null);
    }
  };

  /** Loads a query into the form and runs it. */
  const pick = (name: string, q: Query) => {
    setCurrent(name);
    setQuery(q.query);
    setGlob(q.glob);
    setAggregate(q.aggregate);
    run(q);
  };

  const openSaved = async (f: FileEntry) => {
    const q = parseSaved(await api.readNote(vault, f.path));
    if (q) pick(f.title ?? f.rel, q);
    else setError(`No mq block in ${f.rel}`);
  };

  const save = async (name: string) => {
    try {
      await api.saveQuery(vault, name, query, glob, aggregate);
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
            <button className="primary" onClick={() => run()}><Play size={13} /> Run</button>
          </div>
        </div>
        {error && <div className="banner error"><AlertCircle size={14} /><pre>{error}</pre></div>}
        {results && <div className="muted small result-count">{count} results in {results.length} files</div>}
        <div className="query-results">
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
