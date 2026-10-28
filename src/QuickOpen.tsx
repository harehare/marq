import { useEffect, useMemo, useRef, useState } from "react";
import { Columns3, FileText, MessageSquare, Search, Users } from "lucide-react";
import { FileEntry } from "./api";
import { composing } from "./keys";

/** Subsequence match of `q` in `s`; higher for consecutive runs and matches at word starts. -1 when no match. */
function fuzzy(q: string, s: string): number {
  let score = 0;
  let run = 0;
  let j = 0;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] !== q[j]) {
      run = 0;
      continue;
    }
    run++;
    score += run * 2 + (i === 0 || "/-_ .".includes(s[i - 1]) ? 3 : 0);
    j++;
  }
  return j === q.length ? score - s.length * 0.01 : -1;
}

const icon = (f: FileEntry) =>
  f.kind === "board" ? Columns3 : f.kind === "crew" ? Users : f.rel.startsWith("sessions/") ? MessageSquare : FileText;

/** ⌘P: open a note, board or crew by title or path; recent ones first. */
export function QuickOpen({ files, recent, onOpen, onSearch, onClose }: {
  files: FileEntry[];
  /** Paths, most recent first. */
  recent: string[];
  onOpen: (f: FileEntry) => void;
  /** Search the text of notes instead. */
  onSearch: (q: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const query = q.trim().toLowerCase().replace(/\s+/g, "");
    if (!query) {
      const byPath = new Map(files.map((f) => [f.path, f]));
      const rec = recent.map((p) => byPath.get(p)).filter((f): f is FileEntry => !!f);
      const rest = files.filter((f) => !recent.includes(f.path) && !f.rel.startsWith("sessions/"));
      return [...rec, ...rest].slice(0, 60);
    }
    return files
      .map((f) => ({ f, score: Math.max(fuzzy(query, (f.title ?? "").toLowerCase()) + 2, fuzzy(query, f.rel.toLowerCase())) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60)
      .map((x) => x.f);
  }, [files, recent, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const open = (f?: FileEntry) => {
    if (!f) return;
    onClose();
    onOpen(f);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Open a note by title or path…  (⇧↵ searches the text)"
          onKeyDown={(e) => {
            if (composing(e)) return;
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setSel((i) => Math.min(i + 1, shown.length - 1));
            else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setSel((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter" && e.shiftKey) { onClose(); onSearch(q); }
            else if (e.key === "Enter") open(shown[sel]);
            else return;
            e.preventDefault();
          }} />
        <div className="palette-list" ref={listRef}>
          {shown.map((f, i) => {
            const Icon = icon(f);
            return (
              <div key={f.path} className={`palette-item ${i === sel ? "on" : ""}`} onMouseMove={() => setSel(i)} onClick={() => open(f)}>
                <Icon size={14} className="muted" />
                <span className="ellipsis">{f.title ?? f.rel.split("/").pop()}</span>
                <span className="palette-path ellipsis">{f.rel}</span>
              </div>
            );
          })}
          {q.trim() && (
            <div className="palette-item search-text" onClick={() => { onClose(); onSearch(q); }}>
              <Search size={14} className="muted" /> <span>Search notes for “{q.trim()}”</span> <kbd>⇧↵</kbd>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
