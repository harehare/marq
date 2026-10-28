import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, Search } from "lucide-react";
import { api, SearchHit } from "./api";
import { composing } from "./keys";

/** Marks every search word in `text`. */
function highlight(text: string, words: string[]) {
  if (!words.length) return text;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

/** Full-text search over the vault (⇧⌘F): lines with every word, grouped by note. */
export function SearchView({ vault, initial, active, onOpen }: {
  vault: string; initial: string; active: boolean; onOpen: (path: string, line: number) => void;
}) {
  const [q, setQ] = useState(initial);
  const [sessions, setSessions] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const words = q.trim().split(/\s+/).filter(Boolean);

  // Search as you type, after a short pause.
  useEffect(() => {
    if (!q.trim()) return setHits(null);
    setBusy(true);
    const t = setTimeout(() => {
      api.searchText(vault, q, sessions).then(setHits).finally(() => setBusy(false));
    }, 200);
    return () => clearTimeout(t);
  }, [vault, q, sessions]);

  useEffect(() => setQ(initial), [initial]);
  useEffect(() => {
    if (active) inputRef.current?.select();
  }, [active, initial]);

  const total = hits?.reduce((n, h) => n + h.lines.length + h.more, 0) ?? 0;

  return (
    <div className="query">
      <div className="query-inner">
        <div className="search-bar">
          <Search size={15} className="muted" />
          <input ref={inputRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes (every word must appear on the line)"
            onKeyDown={(e) => {
              if (composing(e) || e.key !== "Enter" || !hits?.[0]) return;
              onOpen(hits[0].path, hits[0].lines[0][0] - 1);
            }} />
          {busy && <Loader2 size={14} className="spin muted" />}
          <label className="check"><input type="checkbox" checked={sessions} onChange={(e) => setSessions(e.target.checked)} /> Include sessions</label>
        </div>
        {hits && <div className="muted small result-count">{total} lines in {hits.length} notes{hits.length >= 200 ? " (first 200 notes)" : ""}</div>}
        <div className="search-results">
          {hits?.map((h) => (
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
