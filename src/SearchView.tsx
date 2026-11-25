import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Loader2, MessageSquare, Search } from "lucide-react";
import { api, FileEntry, SearchHit, SessionHit, SessionInfo } from "./api";
import { composing } from "./keys";

/** Marks every search word in `text`. */
function highlight(text: string, words: string[]) {
  if (!words.length) return text;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

type Scope = "notes" | "sessions";

/** `key:value` parts of a query that narrow it instead of being searched for; a value may be quoted. */
const FILTER = /(^|\s)(type|kind|status|project|workspace|ws|since|after|before|tag):("[^"]*"|\S+)/g;

/** The value of the first `key:` filter in `q`, without quotes. */
function filterOf(q: string, key: string) {
  for (const m of q.matchAll(FILTER)) if (m[2] === key) return m[3].replace(/^"|"$/g, "");
  return "";
}

/** `q` with its `key:` filters replaced by `key:value`, or dropped when `value` is empty. */
function withFilter(q: string, key: string, value: string) {
  const rest = q.replace(FILTER, (all, lead, k) => (k === key ? lead : all)).replace(/\s+/g, " ").trim();
  if (!value) return rest;
  return `${rest} ${key}:${/\s/.test(value) ? `"${value}"` : value}`.trim();
}

/** The last two parts of a path: enough to tell projects apart, and short enough to read in the query. */
const shortPath = (p: string) => p.split("/").filter(Boolean).slice(-2).join("/");

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();

const WHEN = [["today", "Today"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["90d", "Last 90 days"]];

/** One pull-down of the filter row. A value typed by hand that is not among the options is listed too. */
function FilterSelect({ label, value, options, onChange }: {
  label: string; value: string; options: (string | string[])[]; onChange: (v: string) => void;
}) {
  const opts = options.map((o) => (typeof o === "string" ? [o, o] : o));
  if (value && !opts.some(([v]) => v.toLowerCase() === value.toLowerCase())) opts.unshift([value, value]);
  const current = opts.find(([v]) => v.toLowerCase() === value.toLowerCase())?.[0] ?? "";
  return (
    <select className={current ? "on" : ""} value={current} onChange={(e) => onChange(e.target.value)} title={`Narrow by ${label.toLowerCase()}`}>
      <option value="">{label}: any</option>
      {opts.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
    </select>
  );
}

/**
 * Full-text search over the vault (⇧⌘F). Notes: lines with every word, grouped by note.
 * Sessions: past conversations that mention every word, best matches first.
 */
export function SearchView({ vault, initial, active, files, sessions, onOpen, onOpenSession }: {
  vault: string; initial: string; active: boolean; onOpen: (path: string, line: number) => void;
  /** What the filter row offers: the types, statuses, projects and workspaces that exist. */
  files: FileEntry[]; sessions: SessionInfo[];
  onOpenSession: (id: string, title: string) => void;
}) {
  const [q, setQ] = useState(initial);
  const [scope, setScope] = useState<Scope>("notes");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [sessionHits, setSessionHits] = useState<SessionHit[] | null>(null);
  // Words the glossary or notes' aliases widened, and what they also matched.
  const [expanded, setExpanded] = useState<string[][]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const words = [
    ...q.replace(FILTER, " ").trim().split(/\s+/).filter((w) => w && !w.startsWith("#")),
    ...expanded.flat(),
  ];

  // The filter row: pick instead of typing `type:request`. It edits the query, so both stay in step.
  const options = useMemo(() => {
    const notes = files.filter((f) => f.kind !== "file" && !f.rel.startsWith("sessions/"));
    return {
      types: uniq(notes.map((f) => f.kind ?? "note")),
      statuses: uniq(scope === "notes" ? notes.map((f) => f.status) : sessions.map((s) => s.status)),
      projects: uniq([...sessions.map((s) => s.worktree?.repo ?? s.cwd), ...(scope === "notes" ? notes.map((f) => f.project) : [])].map((p) => p && shortPath(p))),
      workspaces: uniq(files.filter((f) => f.kind === "workspace").map((f) => f.title ?? f.rel.split("/").pop()!.replace(/\.md$/, ""))),
    };
  }, [files, sessions, scope]);
  const filter = (key: string, label: string, opts: (string | string[])[]) =>
    (opts.length > 0 || filterOf(q, key)) && (
      <FilterSelect label={label} value={filterOf(q, key)} options={opts} onChange={(v) => setQ(withFilter(q, key, v))} />
    );
  const filtered = ["type", "status", "project", "workspace", "since", "before"].some((k) => filterOf(q, k));

  // Search as you type, after a short pause.
  useEffect(() => {
    if (!q.trim()) {
      setExpanded([]);
      setHits(null);
      return setSessionHits(null);
    }
    setBusy(true);
    let stale = false;
    const t = setTimeout(() => {
      const done = () => !stale && setBusy(false);
      if (scope === "notes") {
        api.searchText(vault, q, false)
          .then((r) => !stale && (setHits(r.hits), setExpanded(r.expanded)))
          .finally(done);
      } else {
        api.searchSessions(vault, q)
          .then((r) => !stale && (setSessionHits(r.hits), setExpanded(r.expanded)))
          .finally(done);
      }
    }, 200);
    return () => { stale = true; clearTimeout(t); };
  }, [vault, q, scope]);

  useEffect(() => setQ(initial), [initial]);
  useEffect(() => {
    if (active) inputRef.current?.select();
  }, [active, initial]);

  const total = hits?.reduce((n, h) => n + h.lines.length + h.more, 0) ?? 0;
  const results = scope === "notes" ? hits : sessionHits;

  return (
    <div className="query">
      <div className="query-inner">
        <div className="search-bar">
          <Search size={15} className="muted" />
          <input ref={inputRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={scope === "notes"
              ? "Search notes: every word on the line, synonyms included; #tag, or pick filters below"
              : "Search past sessions: every word anywhere in the conversation; or pick filters below"}
            onKeyDown={(e) => {
              if (composing(e) || e.key !== "Enter") return;
              if (scope === "notes" && hits?.[0]) onOpen(hits[0].path, hits[0].lines[0][0] - 1);
              if (scope === "sessions" && sessionHits?.[0]) onOpenSession(sessionHits[0].id, sessionHits[0].title);
            }} />
          {busy && <Loader2 size={14} className="spin muted" />}
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={scope === "notes"} className={scope === "notes" ? "on" : ""} onClick={() => setScope("notes")}>Notes</button>
            <button role="tab" aria-selected={scope === "sessions"} className={scope === "sessions" ? "on" : ""} onClick={() => setScope("sessions")}>Sessions</button>
          </div>
        </div>
        <div className="search-filters">
          {scope === "notes" && filter("type", "Type", options.types)}
          {filter("status", "Status", options.statuses)}
          {filter("project", "Project", options.projects)}
          {filter("workspace", "Workspace", options.workspaces)}
          {filter("since", "When", WHEN)}
          {filtered && (
            <a className="muted small" onClick={() => setQ(["type", "status", "project", "workspace", "since", "before"].reduce((s, k) => withFilter(s, k, ""), q))}>Clear filters</a>
          )}
        </div>
        {expanded.length > 0 && (
          <div className="search-expanded small">
            {expanded.map(([word, ...also]) => (
              <span key={word}><b>{word}</b> also matches {also.map((a) => <span key={a} className="tag">{a}</span>)}</span>
            ))}
            <a className="muted" onClick={() => api.glossaryPath(vault).then((p) => onOpen(p, 0))}>Edit glossary</a>
          </div>
        )}
        {scope === "notes" && hits && <div className="muted small result-count">{total} lines in {hits.length} notes{hits.length >= 200 ? " (first 200 notes)" : ""}</div>}
        {scope === "sessions" && sessionHits && (
          <div className="muted small result-count">{sessionHits.length} sessions{sessionHits.length >= 100 ? " (best 100)" : ""}</div>
        )}
        {results && results.length === 0 && !busy && <div className="muted small result-count">Nothing found.</div>}
        <div className="search-results">
          {scope === "sessions" && sessionHits?.map((h) => (
            <div key={h.id} className="search-file">
              <a className="query-file" onClick={() => onOpenSession(h.id, h.title)}>
                <span className={`dot ${h.status}`} /> <MessageSquare size={12} /> <strong>{h.title}</strong>
                <span>{h.started.slice(0, 10)} · {h.project.split("/").filter(Boolean).slice(-2).join("/")} · {h.status}</span>
              </a>
              {h.matches.map((m) => (
                <a key={m.line} className="search-line" title="Open the transcript at this line" onClick={() => onOpen(`${vault}/${h.note}`, m.line - 1)}>
                  <span className="search-ln">{m.line}</span>
                  <span className="search-text">{highlight(m.text, words)}</span>
                </a>
              ))}
              {h.matching_lines > h.matches.length && <div className="muted small search-more">+{h.matching_lines - h.matches.length} more lines</div>}
            </div>
          ))}
          {scope === "notes" && hits?.map((h) => (
            <div key={h.path} className="search-file">
              <a className="query-file" onClick={() => onOpen(h.path, h.lines[0][0] - 1)}>
                <FileText size={12} /> <strong>{h.title ?? h.rel.split("/").pop()}</strong> <span>{h.rel}</span>
              </a>
              {h.lines.map(([line, text]) => (
                <a key={line} className="search-line" onClick={() => onOpen(h.path, line - 1)}>
                  <span className="search-ln">{line}</span>
                  <span className="search-text">{highlight(text, words)}</span>
                </a>
              ))}
              {h.more > 0 && <div className="muted small search-more">+{h.more} more lines</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
