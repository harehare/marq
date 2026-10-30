import { useEffect, useMemo, useState } from "react";
import { Bot, GitBranch, Plus, Search, Send, X } from "lucide-react";
import { api, Helper, SessionInfo } from "./api";

/** Text picked somewhere in Marq, with where it came from. */
export type Excerpt = {
  text: string;
  source: string;
  lines?: [number, number];
  /** The session the text came from, which can get the answer back. */
  from?: { id: string; title: string };
  /** What to ask, filled in beforehand. */
  instruction?: string;
};

type Props = {
  vault: string;
  excerpt: Excerpt;
  /** The session the text came from, which is not offered as a target. */
  exclude?: string;
  /** `stay`: the answer comes back to where the text came from, so there is no need to go to the target. */
  onSent: (sessionId: string, title: string, stay?: boolean) => void;
  /** Opens a helper's note, to edit its instructions. */
  onOpenFile: (path: string) => void;
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

export function SendToSessionDialog({ vault, excerpt, exclude, onSent, onOpenFile, onNewTask, onClose }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [instruction, setInstruction] = useState(excerpt.instruction ?? "");
  const [reply, setReply] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [helpers, setHelpers] = useState<Helper[]>([]);
  /** A helper's note path, while a helper rather than a session is picked. */
  const [helper, setHelper] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  /** The name being typed for a new helper. */
  const [naming, setNaming] = useState<string | null>(null);

  const loadHelpers = () => api.listHelpers(vault).then(setHelpers, (e) => setError(String(e)));
  useEffect(() => {
    loadHelpers();
  }, [vault]);

  useEffect(() => {
    Promise.all([api.listSessions(vault), api.listApprovals()]).then(([list, approvals]) => {
      const waiting = new Set(approvals.map((a) => a.session_id));
      const all = list
        .filter((s) => s.id !== exclude)
        .map((s) => (waiting.has(s.id) ? { ...s, status: "waiting" } : s))
        .sort((a, b) => (RANK[a.status] ?? 2) - (RANK[b.status] ?? 2));
      setSessions(all);
      setPicked((p) => p ?? all[0]?.id ?? null);
    }, (e) => setError(String(e)));
  }, [vault, exclude]);

  const shown = useMemo(() => {
    const q = filter.toLowerCase();
    // A helper's session is reached through the helper.
    const own = new Set(helpers.map((h) => h.session));
    return (sessions ?? [])
      .filter((s) => !own.has(s.id))
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.origin_path.toLowerCase().includes(q))
      .slice(0, 40);
  }, [sessions, filter, helpers]);
  const shownHelpers = helpers.filter((h) => !filter || `${h.name} ${h.summary}`.toLowerCase().includes(filter.toLowerCase()));
  const pickedHelper = helpers.find((h) => h.path === helper);

  const message = composeMessage(excerpt, instruction);
  const target = pickedHelper ? null : sessions?.find((s) => s.id === picked);
  const pickSession = (id: string) => {
    setHelper(null);
    setPicked(id);
  };

  const newHelper = async () => {
    const name = naming?.trim();
    if (!name) return setNaming(null);
    try {
      const path = await api.createHelper(vault, name);
      await loadHelpers();
      setHelper(path);
      setNaming(null);
      onOpenFile(path);
    } catch (e) {
      setError(String(e));
    }
  };

  const send = async () => {
    if (pickedHelper) {
      setBusy(true);
      try {
        const from = excerpt.from && excerpt.from.id !== pickedHelper.session ? excerpt.from.id : null;
        const id = await api.sendToHelper(vault, pickedHelper.path, message, from, reply, fresh);
        onSent(id, pickedHelper.name, !!from && reply);
        onClose();
      } catch (e) {
        setError(String(e));
        setBusy(false);
      }
      return;
    }
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
          <div className="send-group muted small">
            Helpers
            <button className="icon" title="New helper: a standing session with a role, set by a note under helpers/" onClick={() => setNaming("")}>
              <Plus size={13} />
            </button>
          </div>
          {naming !== null && (
            <input className="send-helper-name" autoFocus value={naming} placeholder="Name, e.g. Translator (↵ to create)"
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") newHelper();
                if (e.key === "Escape") { e.stopPropagation(); setNaming(null); }
              }} />
          )}
          {helpers.length === 0 && naming === null && (
            <div className="muted small pad">None yet. A helper is a session with a standing role, such as translating; add one with +.</div>
          )}
          {shownHelpers.map((h) => (
            <button key={h.path} className={`send-target ${helper === h.path ? "on" : ""}`} onClick={() => setHelper(h.path)}
              onDoubleClick={() => { setHelper(h.path); send(); }}>
              <Bot size={14} className="muted" />
              <span className="send-target-body">
                <span className="ellipsis">{h.name}</span>
                <span className="muted small ellipsis">{h.summary}</span>
              </span>
              <span className="send-edit small" title="Edit its instructions" onClick={(e) => { e.stopPropagation(); onOpenFile(h.path); }}>Edit</span>
            </button>
          ))}
          <div className="send-group muted small">Sessions</div>
          {sessions === null && <div className="muted small pad">Loading…</div>}
          {sessions?.length === 0 && <div className="muted small pad">No other sessions yet.</div>}
          {shown.map((s) => (
            <button key={s.id} className={`send-target ${!pickedHelper && picked === s.id ? "on" : ""}`} onClick={() => pickSession(s.id)}
              onDoubleClick={() => { pickSession(s.id); send(); }}>
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
        {pickedHelper?.session && (
          <label className="check">
            <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />
            Start “{pickedHelper.name}” over in a new conversation
          </label>
        )}
        {error && <div className="banner error">{error}</div>}
        <div className="modal-foot">
          <button onClick={() => { onNewTask(message); onClose(); }}><Plus size={14} /> New task with this</button>
          <button className="primary" onClick={send} disabled={(!target && !pickedHelper) || busy}>
            <Send size={14} /> {target && !["running", "waiting"].includes(target.status) ? "Send and resume" : pickedHelper ? `Ask ${pickedHelper.name}` : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
