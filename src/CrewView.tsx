import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle, ArrowUp, FileOutput, CornerDownRight, Cpu, ExternalLink, FileText, FolderGit2, GitBranch, Gavel, Hand, Loader2, Play,
  ShieldQuestion, UserPlus, Users, X,
} from "lucide-react";
import { api, CrewDoc, CrewMessage, CrewState, FileEntry } from "./api";
import { Md } from "./markdown/Md";
import { Resizer, usePaneSize } from "./Resizer";
import { SessionView } from "./SessionView";
import { BoardView } from "./BoardView";
import type { Excerpt } from "./SendToSessionDialog";
import { composing } from "./keys";
import { useAutoGrow } from "./useAutoGrow";
import { useStickToBottom } from "./useStickToBottom";
import { NoteEditor } from "./NoteEditor";

type Props = {
  vault: string;
  /** The crew note's id or vault-relative path. */
  crewKey: string;
  onOpenNote: (path: string, line?: number) => void;
  onOpenSession: (id: string, title: string) => void;
  onSendExcerpt: (excerpt: Excerpt) => void;
  onOpenCrew: (rel: string, title: string) => void;
  /** For the task board: notes a card can link to, and opening or creating them. */
  files: FileEntry[];
  recent: string[];
  onOpenFile: (path: string) => void;
  onCreateNote: (rel: string) => Promise<string>;
};

// Each member gets a color for its timeline entries, in roster order.
const ROLE_COLORS = ["var(--run)", "var(--info)", "var(--accent)", "var(--ok)", "var(--err)"];

const time = (at: string) => at.slice(11, 16);

/** Claude aliases a member can run on; empty follows the crew's model. */
const MODELS = ["opus", "sonnet", "haiku"];
const toList = (to: string | string[]) => (Array.isArray(to) ? to : [to]);

/** One project worked on by several sessions that message each other by role. */
export function CrewView({ vault, crewKey, onOpenNote, onOpenSession, onSendExcerpt, onOpenCrew, files, recent, onOpenFile, onCreateNote }: Props) {
  const [st, setSt] = useState<CrewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [to, setTo] = useState<string>("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"timeline" | "tasks" | "docs">("timeline");
  // A document opened inside the Docs view.
  const [doc, setDoc] = useState<CrewDoc | null>(null);
  const sessionWidth = usePaneSize("crewSession", 560, 320, 1400);
  const membersWidth = usePaneSize("crewMembers", 220, 160, 400);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(inputRef, input, 240);
  // Once loaded, the crew is addressed by id, so the tab keeps working if the note moves.
  const key = st?.id || crewKey;

  const load = useCallback(() => {
    api.crewState(vault, key).then((s) => { setSt(s); setError(null); }).catch((e) => setError(String(e)));
  }, [vault, key]);

  useEffect(() => {
    load();
    const uns = [
      listen<{ crew_id: string }>("crew://changed", (e) => (!st || e.payload.crew_id === st.id) && load()),
      ...["session://turn", "session://exit", "session://approval", "vault://changed"].map((ev) => listen(ev, () => load())),
    ];
    return () => uns.forEach((u) => u.then((f) => f()));
  }, [load, st?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The timeline opens at its latest message, also when switching back to it.
  const timelineRef = useStickToBottom<HTMLDivElement>([st?.messages.length]);

  // Default the recipient to the first member (usually the lead).
  useEffect(() => {
    if (st && to !== "all" && !st.members.some((m) => m.role === to)) setTo(st.members[0]?.role ?? "");
  }, [st, to]);

  if (!st) {
    return error ? (
      <div className="pane-msg"><AlertCircle size={14} /> {error}</div>
    ) : (
      <div className="pane-msg"><Loader2 size={14} className="spin" /></div>
    );
  }

  const color = (role: string) => {
    const i = st.members.findIndex((m) => m.role === role);
    return i < 0 ? "var(--fg-strong)" : ROLE_COLORS[i % ROLE_COLORS.length];
  };
  const byId = new Map(st.messages.filter((m) => m.type === "crew_msg").map((m) => [m.id, m]));
  const member = st.members_state.find((m) => m.role === selected);
  const waiting = st.members_state.filter((m) => m.status === "waiting");
  const openTasks = st.tasks.filter((t) => t.status !== "done").length;

  const send = async (target: string, text: string) => {
    if (!target || !text.trim()) return;
    setSending(true);
    try {
      await api.crewSend(vault, st.id, target, text);
      setInput("");
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  const release = async (m: CrewMessage) => {
    try {
      await api.crewRelease(vault, st.id, m.id);
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  const setModel = async (role: string, model: string) => {
    try {
      await api.crewSetModel(vault, st.id, role, model);
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  const kickOff = async () => {
    setSending(true);
    try {
      await api.crewKickOff(vault, st.id);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="session crew">
      <header className="session-head">
        <div className="session-title">
          <h2 title={st.title}><Users size={16} /> {st.title}</h2>
          <div className="session-meta">
            <span className="meta-item" title={st.project ?? ""}>
              <FolderGit2 size={12} /> <span className="ellipsis">{st.project ?? "no project set"}</span>
            </span>
            <span className="meta-item" title="Member-to-member messages allowed after each of yours before the crew pauses">
              max {st.max_hops} hops
            </span>
          </div>
        </div>
        {st.messages.length === 0 && (
          <button className="primary" onClick={kickOff} disabled={sending || !st.goal.trim() || !st.members.length}
            title={`Send the Goal section to ${st.members[0]?.role ?? "the first member"}`}>
            <Play size={13} /> Kick off
          </button>
        )}
        <button onClick={() => onOpenNote(st.path)}><FileText size={14} /> Edit crew note</button>
      </header>
      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          <AlertCircle size={14} /> {error}
        </div>
      )}
      {waiting.map((m) => (
        <div key={m.role} className="banner warn" onClick={() => setSelected(m.role)}>
          <ShieldQuestion size={14} /> {m.role} is waiting for your approval. Click to open its session.
        </div>
      ))}
      <div className="session-body">
        <aside className="crew-members" style={{ width: membersWidth.size }}>
          <div className="crew-members-title muted small">Members</div>
          {st.members_state.map((m) => (
            <a key={m.role} className={`crew-member ${selected === m.role ? "on" : ""}`} style={{ "--role": color(m.role) } as React.CSSProperties}
              onClick={() => setSelected(selected === m.role ? null : m.role)}
              onDoubleClick={() => m.session_id && onOpenSession(m.session_id, `${st.title} · ${m.role}`)}>
              <span className="crew-avatar">
                {m.role.charAt(0).toUpperCase()}
                <span className={`dot ${m.status === "idle" ? "status-done" : m.status}`} />
              </span>
              <span className="crew-member-body">
                <span className="crew-member-role">{m.role}</span>
                <span className="muted small ellipsis">
                  {m.model && <span className="crew-model">{m.model}</span>}
                  {m.session_id ? (m.branch ? <><GitBranch size={10} /> {m.branch}</> : m.status) : "starts on its first message"}
                </span>
              </span>
              {m.pending > 0 && <span className="count run" title="Messages waiting for its next turn">{m.pending}</span>}
            </a>
          ))}
          {st.members.length === 0 && <div className="muted small crew-empty">Add members to the crew note.</div>}
          {st.members.length === 1 && (
            <div className="muted small crew-empty">
              <UserPlus size={12} /> {st.members[0].role} adds the rest of the team with <code>crew_add_member</code> after Kick off.
              You approve each one.
            </div>
          )}
        </aside>
        <Resizer axis="x" sign={1} pane={membersWidth} />
        <div className="session-main">
          <div className="side-switch">
            <button className={view === "timeline" ? "on" : ""} onClick={() => setView("timeline")}>Timeline</button>
            <button className={view === "tasks" ? "on" : ""} onClick={() => setView("tasks")}>
              Tasks {openTasks > 0 && <span className="count">{openTasks}</span>}
            </button>
            <button className={view === "docs" ? "on" : ""} onClick={() => { setView("docs"); setDoc(null); }}>
              Docs {st.docs.length > 0 && <span className="count">{st.docs.length}</span>}
            </button>
          </div>
          {view === "tasks" && (
            <BoardView vault={vault} path={st.tasks_path} files={files} recent={recent} onOpenMarkdown={() => onOpenNote(st.tasks_path)}
              onOpenFile={onOpenFile} onCreateNote={onCreateNote} onStartTask={() => {}}
              crew={{ id: st.id, members: st.members.map((m) => m.role) }} />
          )}
          {view === "docs" && doc && (
            <div className="crew-doc">
              <NoteEditor key={doc.path} vault={vault} path={doc.path} onOpenSession={onOpenSession} onSendExcerpt={onSendExcerpt}
                parents={[{ label: st.title, onClick: () => { setView("timeline"); setDoc(null); } }, { label: "Docs", onClick: () => setDoc(null) }]}
                onOpenFile={(p) => {
                  const d = st.docs.find((x) => x.path === p);
                  if (d) setDoc(d);
                  else onOpenNote(p);
                }} />
            </div>
          )}
          {view === "docs" && !doc && (
            <div className="messages">
              <div className="messages-inner">
                {st.docs.length === 0 && (
                  <p className="muted small">Designs, plans and reports the members save with <code>write_doc</code> show up here. They are kept in the crew's folder and linked from the crew note.</p>
                )}
                {st.docs.map((d) => (
                  <a key={d.path} className="doc-card" onClick={() => setDoc(d)} title="Open">
                    <FileOutput size={18} />
                    <span className="doc-card-body">
                      <span className="doc-card-title">{d.title ?? d.rel}</span>
                      <span className="muted small mono">{d.rel}</span>
                    </span>
                    <button className="icon" title="Open in a tab" onClick={(e) => { e.stopPropagation(); onOpenNote(d.path); }}>
                      <ExternalLink size={13} />
                    </button>
                  </a>
                ))}
              </div>
            </div>
          )}
          {view === "timeline" && <>
          <div className="messages" ref={timelineRef}>
            <div className="messages-inner">
              {st.messages.length === 0 && (
                <div className="crew-empty muted">
                  <p>No messages yet.</p>
                  <p className="small">
                    Write the Goal and the roles in the crew note, then <b>Kick off</b> or message a member below.
                    Members talk to each other with <code>crew_send</code>, and their messages show up here.
                  </p>
                </div>
              )}
              {st.messages.map((m, i) => {
                if (m.type === "crew_event") {
                  return <div key={`e${i}`} className="info">{m.text} · {time(m.at)}</div>;
                }
                const re = m.reply_to ? byId.get(m.reply_to) : undefined;
                const recipients = toList(m.to);
                return (
                  <div key={m.id}
                    className={`crew-msg ${m.from === "user" ? "from-user" : ""} ${m.held && !m.released ? "held" : ""} ${m.kind === "decision" ? "decision" : ""}`}
                    style={{ "--role": color(m.from) } as React.CSSProperties}>
                    <div className="crew-msg-head small">
                      <a className="crew-msg-role" onClick={() => m.from !== "user" && setSelected(m.from)}>{m.from}</a>
                      <span className="muted">→</span>
                      {recipients.length === st.members.length - 1 && recipients.length > 1 && !recipients.includes("user") ? (
                        <span className="crew-msg-role" style={{ color: "var(--fg-strong)" }}>all</span>
                      ) : recipients.map((r, j) => (
                        <a key={r} className="crew-msg-role" style={{ color: color(r) }} onClick={() => r !== "user" && setSelected(r)}>
                          {r}{j < recipients.length - 1 ? "," : ""}
                        </a>
                      ))}
                      {m.kind === "decision" ? (
                        <span className="crew-kind decision"><Gavel size={10} /> decision</span>
                      ) : m.kind !== "tell" && <span className={`crew-kind ${m.kind}`}>{m.kind}</span>}
                      <span className="spacer" />
                      {m.held && !m.released ? (
                        <>
                          <span className="crew-held"><Hand size={11} /> held at hop {m.hop}</span>
                          <button className="small-btn primary" onClick={() => release(m)}>Let it through</button>
                        </>
                      ) : recipients.some((r) => r !== "user") && !m.delivered ? (
                        <span className="muted">queued</span>
                      ) : null}
                      <span className="muted">{time(m.at)}</span>
                    </div>
                    {re && (
                      <div className="crew-msg-re muted small ellipsis">
                        <CornerDownRight size={11} /> {re.from}: {re.text.split("\n")[0]}
                      </div>
                    )}
                    <div className="crew-msg-body msg"><Md>{m.text}</Md></div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="composer">
            <div className="composer-box">
              <select className="crew-to" value={to} onChange={(e) => setTo(e.target.value)} title="Recipient">
                {st.members.map((m) => <option key={m.role} value={m.role}>to {m.role}</option>)}
                {st.members.length > 1 && <option value="all">to all</option>}
              </select>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={`Message ${to || "a member"}…  (⌘↵ to send)`}
                rows={1}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !composing(e)) send(to, input);
                }}
              />
              <button className="send" onClick={() => send(to, input)} disabled={sending || !input.trim() || !to} title="Send">
                {sending ? <Loader2 size={16} className="spin" /> : <ArrowUp size={16} />}
              </button>
            </div>
          </div>
          </>}
        </div>
        {member && (
          <>
            <Resizer axis="x" sign={-1} pane={sessionWidth} />
            <aside className="crew-session" style={{ width: sessionWidth.size }}>
              <div className="crew-session-head">
                <span className="crew-member-role" style={{ color: color(member.role) }}>{member.role}</span>
                <span className="spacer" />
                <label className="crew-model-pick" title="The model it runs on from its next turn. Members may also switch with crew_set_model.">
                  <Cpu size={12} />
                  <select value={st.members.find((m) => m.role === member.role)?.model ?? ""}
                    onChange={(e) => setModel(member.role, e.target.value)}>
                    <option value="">{st.model ? `crew (${st.model})` : "default"}</option>
                    {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                    {(() => {
                      const own = st.members.find((m) => m.role === member.role)?.model;
                      return own && !MODELS.includes(own) ? <option value={own}>{own}</option> : null;
                    })()}
                  </select>
                </label>
                {member.session_id && (
                  <button className="icon" title="Open in its own tab"
                    onClick={() => onOpenSession(member.session_id!, `${st.title} · ${member.role}`)}>
                    <ExternalLink size={13} />
                  </button>
                )}
                <button className="icon" title="Close" onClick={() => setSelected(null)}><X size={13} /></button>
              </div>
              {member.session_id ? (
                <SessionView key={member.session_id} vault={vault} sessionId={member.session_id} compact
                  onOpenOrigin={onOpenNote} onOpenSession={onOpenSession} onSendExcerpt={onSendExcerpt} onOpenCrew={onOpenCrew} />
              ) : (
                <div className="pane-msg small">{member.role} has no session yet. It starts when the first message reaches it.</div>
              )}
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
