import { useEffect, useMemo, useRef, useState } from "react";
import { Columns3, FileText, MessageSquare, Search, Users } from "lucide-react";
import { FileEntry, SessionInfo } from "./api";
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

/** One row: a file, or a session's conversation. `names` match with a bonus (title, aliases); `path` without. */
type Entry = { key: string; label: string; detail: string; Icon: typeof FileText; names: string[]; path: string; file?: FileEntry; session?: SessionInfo };

const fileEntry = (f: FileEntry): Entry => ({
  key: f.path, label: f.title ?? f.rel.split("/").pop()!, detail: f.rel, Icon: icon(f),
  names: [f.title ?? "", ...(f.aliases ?? [])], path: f.rel, file: f,
});

const sessionEntry = (s: SessionInfo): Entry => {
  const where = s.worktree?.branch ?? s.cwd.split("/").pop() ?? "";
  return {
    key: `session:${s.id}`, label: s.crew ? `${s.title} · ${s.crew.role}` : s.title,
    detail: [s.crew ? "crew member" : "session", s.status, where, s.started.slice(0, 10)].filter(Boolean).join(" · "),
    Icon: s.crew ? Users : MessageSquare, names: [s.title, s.crew?.role ?? ""], path: `${s.cwd} ${where}`, session: s,
  };
};

/**
 * ⌘P: open a note, board or crew by title or path; recent ones first. With `sessions`, conversations are
 * listed as sessions (opened in their chat view) rather than as their session notes.
 */
export function QuickOpen({ files, recent, sessions, placeholder, onOpen, onOpenSession, onSearch, onClose }: {
  files: FileEntry[];
  /** Paths, most recent first. */
  recent: string[];
  sessions?: SessionInfo[];
  placeholder?: string;
  onOpen: (f: FileEntry) => void;
  onOpenSession?: (s: SessionInfo) => void;
  /** Search the text of notes instead. */
  onSearch?: (q: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => {
    const fs = sessions ? files.filter((f) => !f.rel.startsWith("sessions/")) : files;
    return { files: fs.map(fileEntry), sessions: (sessions ?? []).map(sessionEntry) };
  }, [files, sessions]);

  const shown = useMemo(() => {
    const query = q.trim().toLowerCase().replace(/\s+/g, "");
    if (!query) {
      const byPath = new Map(entries.files.map((e) => [e.key, e]));
      const rec = recent.map((p) => byPath.get(p)).filter((e): e is Entry => !!e);
      // Sessions at work come right after the recent files.
      const working = entries.sessions.filter((e) => e.session!.status === "running" || e.session!.status === "waiting");
      const rest = entries.files.filter((e) => !recent.includes(e.key) && !e.path.startsWith("sessions/"));
      return [...rec, ...working, ...rest].slice(0, 60);
    }
    return [...entries.files, ...entries.sessions]
      // A note's aliases find it like its title.
      .map((e) => ({
        e,
        score: Math.max(
          fuzzy(query, e.path.toLowerCase()),
          ...e.names.filter(Boolean).map((n, i) => fuzzy(query, n.toLowerCase()) + (i === 0 ? 2 : 1)),
        ),
      }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60)
      .map((x) => x.e);
  }, [entries, recent, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const open = (e?: Entry) => {
    if (!e) return;
    onClose();
    if (e.session) onOpenSession?.(e.session);
    else onOpen(e.file!);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder ?? "Open a note by title or path…  (⇧↵ searches the text)"}
          onKeyDown={(e) => {
            if (composing(e)) return;
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setSel((i) => Math.min(i + 1, shown.length - 1));
            else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setSel((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter" && e.shiftKey && onSearch) { onClose(); onSearch(q); }
            else if (e.key === "Enter") open(shown[sel]);
            else return;
            e.preventDefault();
          }} />
        <div className="palette-list" ref={listRef}>
          {shown.map((e, i) => (
            <div key={e.key} className={`palette-item ${i === sel ? "on" : ""}`} onMouseMove={() => setSel(i)} onClick={() => open(e)}>
              <e.Icon size={14} className="muted" />
              <span className="ellipsis">{e.label}</span>
              <span className="palette-path ellipsis">{e.detail}</span>
            </div>
          ))}
          {q.trim() && onSearch && (
            <div className="palette-item search-text" onClick={() => { onClose(); onSearch(q); }}>
              <Search size={14} className="muted" /> <span>Search notes for “{q.trim()}”</span> <kbd>⇧↵</kbd>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
