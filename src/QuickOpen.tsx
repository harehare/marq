import { useEffect, useMemo, useRef, useState } from "react";
import { Columns3, FileText, FolderGit2, MessageSquare, Search } from "lucide-react";
import { FileEntry, SessionInfo } from "./api";
import { usePaletteKeys } from "./usePaletteKeys";
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
  f.kind === "board" ? Columns3 : f.kind === "workspace" ? FolderGit2 : f.rel.startsWith("sessions/") ? MessageSquare : FileText;

/** What the list is narrowed to. Tab goes through them; the letter and a space picks one as the first thing typed. */
const SCOPES = [
  { id: "all", label: "All", key: "" },
  { id: "notes", label: "Notes", key: "n" },
  { id: "sessions", label: "Sessions", key: "s" },
  { id: "requests", label: "Requests", key: "r" },
  { id: "docs", label: "Docs", key: "d" },
  { id: "workspaces", label: "Workspaces", key: "w" },
] as const;
type Scope = (typeof SCOPES)[number]["id"];

/** Whether a row belongs to a scope. Notes are the files that are nothing more specific. */
function inScope(e: Entry, scope: Scope) {
  if (scope === "all") return true;
  if (scope === "sessions") return !!e.session;
  const kind = e.file?.kind ?? "note";
  if (!e.file) return false;
  if (scope === "requests") return kind === "request";
  if (scope === "docs") return kind === "doc";
  if (scope === "workspaces") return kind === "workspace";
  return !["request", "doc", "workspace", "session", "file"].includes(kind);
}

/** One row: a file, or a session's conversation. `names` match with a bonus (title, aliases); `path` without. */
type Entry = { key: string; label: string; detail: string; Icon: typeof FileText; names: string[]; path: string; file?: FileEntry; session?: SessionInfo };

const fileEntry = (f: FileEntry): Entry => ({
  key: f.path, label: f.title ?? f.rel.split("/").pop()!, detail: f.rel, Icon: icon(f),
  names: [f.title ?? "", ...(f.aliases ?? [])], path: f.rel, file: f,
});

const sessionEntry = (s: SessionInfo, workspaces: Map<string, string>): Entry => {
  const where = s.worktree?.branch ?? s.cwd.split("/").pop() ?? "";
  // Also found by its project, its workspace and the note it started from.
  const also = [s.worktree?.repo, s.workspace && (workspaces.get(s.workspace) ?? s.workspace), s.origin_path].filter(Boolean).join(" ");
  return {
    key: `session:${s.id}`, label: s.title,
    detail: ["session", s.status, where, s.started.slice(0, 10)].filter(Boolean).join(" · "),
    Icon: MessageSquare, names: [s.title], path: `${s.cwd} ${where} ${also}`, session: s,
  };
};

/**
 * ⌘P: open a note or board by title or path; recent ones first. With `sessions`, conversations are
 * listed as sessions (opened in their chat view) rather than as their session notes, and the list can be
 * narrowed to a scope (Tab, or `s ` and the like) and to a tag (`#name`).
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
  const [scope, setScope] = useState<Scope>("all");
  // Scopes are for the main palette; a picker of notes has only notes.
  const scoped = !!sessions;
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  usePaletteKeys(inputRef, onClose);

  const entries = useMemo(() => {
    const fs = sessions ? files.filter((f) => !f.rel.startsWith("sessions/")) : files;
    const workspaces = new Map(files.filter((f) => f.kind === "workspace").map((f) => [f.rel, f.title ?? f.rel]));
    return { files: fs.map(fileEntry), sessions: (sessions ?? []).map((s) => sessionEntry(s, workspaces)) };
  }, [files, sessions]);

  const shown = useMemo(() => {
    // `#name` keeps what carries a tag that starts with it; the rest of the text is matched as before.
    const parts = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const tags = parts.filter((p) => p.length > 1 && p.startsWith("#")).map((p) => p.slice(1));
    const query = parts.filter((p) => !(p.length > 1 && p.startsWith("#"))).join("");
    const keep = (e: Entry) =>
      inScope(e, scope) && tags.every((t) => e.file?.tags?.some((x) => x.toLowerCase().startsWith(t)));
    if (scope !== "all" || tags.length) {
      const pool = [...entries.files, ...entries.sessions].filter(keep);
      if (!query) {
        // Nothing typed: the newest first (sessions already are).
        return pool.sort((a, b) => (b.file?.modified ?? 0) - (a.file?.modified ?? 0)).slice(0, 60);
      }
      return pool
        .map((e) => ({ e, score: Math.max(fuzzy(query, e.path.toLowerCase()), ...e.names.filter(Boolean).map((n, i) => fuzzy(query, n.toLowerCase()) + (i === 0 ? 2 : 1))) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 60)
        .map((x) => x.e);
    }
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
  }, [entries, recent, q, scope]);

  useEffect(() => setSel(0), [q, scope]);
  const cycle = (d: number) => setScope(SCOPES[(SCOPES.findIndex((s) => s.id === scope) + d + SCOPES.length) % SCOPES.length].id);
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
        <input ref={inputRef} autoFocus value={q} placeholder={placeholder ?? "Open a note by title or path…  (⇧↵ searches the text)"}
          onChange={(e) => {
            // A scope's letter and a space, as the first thing typed, picks the scope.
            const pick = scoped && scope === "all" ? SCOPES.find((s) => s.key && e.target.value === `${s.key} `) : undefined;
            if (pick) {
              setScope(pick.id);
              setQ("");
            } else setQ(e.target.value);
          }}
          onKeyDown={(e) => {
            if (composing(e)) return;
            if (scoped && e.key === "Tab") cycle(e.shiftKey ? -1 : 1);
            else if (scoped && e.key === "Backspace" && !q && scope !== "all") setScope("all");
            else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setSel((i) => Math.min(i + 1, shown.length - 1));
            else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setSel((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter" && e.shiftKey && onSearch) { onClose(); onSearch(q); }
            else if (e.key === "Enter") open(shown[sel]);
            else return;
            e.preventDefault();
          }} />
        {scoped && (
          <div className="palette-scopes" role="tablist">
            {SCOPES.map((s) => (
              <button key={s.id} role="tab" aria-selected={scope === s.id} className={scope === s.id ? "on" : ""}
                title={s.key ? `Type "${s.key}" and a space, or press Tab` : "Tab goes through the scopes"}
                onMouseDown={(e) => e.preventDefault()} onClick={() => setScope(s.id)}>
                {s.label}{s.key && <kbd>{s.key}</kbd>}
              </button>
            ))}
            <span className="muted small">#tag</span>
          </div>
        )}
        <div className="palette-list" ref={listRef}>
          {shown.length === 0 && <div className="palette-item muted">Nothing found.</div>}
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
