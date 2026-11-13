import { useEffect, useMemo, useState } from "react";
import { GitBranch, Plus, Search, Send, X } from "lucide-react";
import { api, SessionInfo } from "./api";

/** Text picked somewhere in Marq, with where it came from. */
export type Excerpt = {
  text: string;
  source: string;
  lines?: [number, number];
  /** The session the text came from, which can get the answer back. */
  from?: { id: string; title: string };
  /** What to ask, filled in beforehand. */
  instruction?: string;
  /** The session picked beforehand, such as the one that wrote the document the text is from. */
  target?: string;
};

type Props = {
  vault: string;
  excerpt: Excerpt;
  /** The session the text came from, which is not offered as a target. */
  exclude?: string;
  /** `stay`: the answer comes back to where the text came from, so there is no need to go to the target. */
  onSent: (sessionId: string, title: string, stay?: boolean) => void;
  onNewTask: (prompt: string) => void;
  onClose: () => void;
};

/** The message a session receives: the instruction, then the excerpt with its source. */
export function composeMessage(excerpt: Excerpt, instruction: string) {
  const lines = excerpt.lines ? ` lines="${excerpt.lines[0]}-${excerpt.lines[1]}"` : "";
  const block = `<excerpt source="${excerpt.source.replace(/"/g, "'")}"${lines}>\n${excerpt.text.trim()}\n</excerpt>`;
  return instruction.trim() ? `${instruction.trim()}\n\n${block}` : block;
}

const RANK: Record<string, number> = { waiting: 0, running: 1 };

export function SendToSessionDialog({ vault, excerpt, exclude, onSent, onNewTask, onClose }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [instruction, setInstruction] = useState(excerpt.instruction ?? "");
  const [reply, setReply] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([api.listSessions(vault), api.listApprovals()]).then(([list, approvals]) => {
      const waiting = new Set(approvals.map((a) => a.session_id));
      const all = list
        .filter((s) => s.id !== exclude)
        .map((s) => (waiting.has(s.id) ? { ...s, status: "waiting" } : s))
        .sort((a, b) => (b.id === excerpt.target ? 1 : 0) - (a.id === excerpt.target ? 1 : 0) || (RANK[a.status] ?? 2) - (RANK[b.status] ?? 2));
      setSessions(all);
      setPicked((p) => p ?? all.find((s) => s.id === excerpt.target)?.id ?? all[0]?.id ?? null);
    }, (e) => setError(String(e)));
  }, [vault, exclude, excerpt.target]);

  const shown = useMemo(() => {
    const q = filter.toLowerCase();
    return (sessions ?? [])
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.origin_path.toLowerCase().includes(q))
      .slice(0, 40);
  }, [sessions, filter]);

  const message = composeMessage(excerpt, instruction);
  const target = sessions?.find((s) => s.id === picked);

  const send = async () => {
    if (!target) return;
    setBusy(true);
    try {
      if (excerpt.from) await api.forwardMessage(vault, excerpt.from.id, target.id, message, reply);
      else await api.sendMessage(vault, target.id, message);
      onSent(target.id, target.title);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal send-dialog" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="modal-head">
          <h3><Send size={16} /> Send to session</h3>
          <button className="icon" onClick={onClose}><X size={15} /></button>
        </div>
        <pre className="excerpt">
          <span className="muted small">{excerpt.source}{excerpt.lines ? ` · lines ${excerpt.lines[0]}–${excerpt.lines[1]}` : ""}</span>
          {"\n"}{excerpt.text.trim()}
        </pre>
        <textarea
          className="send-instruction"
          autoFocus
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="What should the session do with this? (optional)"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
          }}
        />
        <div className="project-row">
          <Search size={14} className="muted" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter sessions" />
        </div>
        <div className="send-targets">
          {sessions === null && <div className="muted small pad">Loading…</div>}
          {sessions?.length === 0 && <div className="muted small pad">No other sessions yet.</div>}
          {shown.map((s) => (
            <button key={s.id} className={`send-target ${picked === s.id ? "on" : ""}`} onClick={() => setPicked(s.id)}
              onDoubleClick={() => { setPicked(s.id); send(); }}>
              <span className={`dot ${s.status}`} />
              <span className="send-target-body">
                <span className="ellipsis">{s.title}</span>
                <span className="muted small ellipsis">
                  {s.worktree ? <><GitBranch size={10} /> {s.worktree.branch}</> : s.cwd.replace(/^\/Users\/[^/]+/, "~")}
                </span>
              </span>
              <span className={`pill status-${s.status}`}>{s.status}</span>
            </button>
          ))}
        </div>
        {excerpt.from && (
          <label className="check">
            <input type="checkbox" checked={reply} onChange={(e) => setReply(e.target.checked)} />
            Send its answer back to “{excerpt.from.title}”
          </label>
        )}
        {error && <div className="banner error">{error}</div>}
        <div className="modal-foot">
          <button onClick={() => { onNewTask(message); onClose(); }}><Plus size={14} /> New task with this</button>
          <button className="primary" onClick={send} disabled={!target || busy}>
            <Send size={14} /> {target && !["running", "waiting"].includes(target.status) ? "Send and resume" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
