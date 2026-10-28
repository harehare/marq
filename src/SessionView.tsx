import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowUp, CornerUpLeft, Square, FileText, FilePen, Terminal, Search, Globe, Wrench, ChevronRight, Bot, Loader2,
  FolderGit2, AlertCircle, GitBranch, PanelRight, ShieldQuestion, Check, X, NotebookPen, FileOutput, RotateCw, CircleCheck, GitPullRequest, Users, Upload,
} from "lucide-react";
import { api, Approval, ClaudeEvent, SessionInfo, Worktree } from "./api";
import { Md } from "./markdown/Md";
import { ChangesPanel } from "./review/ChangesPanel";
import { OriginNotePanel } from "./review/OriginNotePanel";
import { Resizer, usePaneSize } from "./Resizer";
import { SlashTextarea } from "./SlashTextarea";
import { SelectionPopover } from "./SelectionPopover";
import type { Excerpt } from "./SendToSessionDialog";

type Props = {
  vault: string;
  sessionId: string;
  onOpenOrigin: (path: string, line: number) => void;
  onOpenSession: (id: string, title: string) => void;
  onSendExcerpt: (excerpt: Excerpt) => void;
  /** Opens a crew this session handed its task to (`start_crew`). */
  onOpenCrew?: (rel: string, title: string) => void;
  /** Starts with the side panel closed, for narrow embeds such as the crew view. */
  compact?: boolean;
};

type Item =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; arg: string; result?: string }
  | { kind: "info"; text: string; error?: boolean }
  | { kind: "doc"; path: string; title: string; created: boolean }
  | { kind: "crew"; path: string; title: string };

function toolArg(input: any): string {
  for (const k of ["file_path", "command", "pattern", "path", "url", "query", "description"]) {
    if (typeof input?.[k] === "string") return input[k];
  }
  return JSON.stringify(input);
}

function toolResult(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? "").join("\n");
  return "";
}

const TOOL_ICONS: Record<string, typeof Wrench> = {
  Read: FileText, Edit: FilePen, Write: FilePen, MultiEdit: FilePen, Bash: Terminal,
  Grep: Search, Glob: Search, WebFetch: Globe, WebSearch: Globe,
};

/** Folds stream-json events into display items, attaching each tool result to its call. */
function toItems(events: ClaudeEvent[]): Item[] {
  const items: Item[] = [];
  const byId = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const e of events) {
    if (e.type === "marq_user") items.push({ kind: "user", text: e.text });
    else if (e.type === "assistant") {
      for (const c of e.message?.content ?? []) {
        if (c.type === "text" && c.text.trim()) items.push({ kind: "text", text: c.text });
        if (c.type === "tool_use") {
          const item = { kind: "tool" as const, name: c.name, arg: toolArg(c.input) };
          byId.set(c.id, item);
          items.push(item);
        }
      }
    } else if (e.type === "user") {
      for (const c of e.message?.content ?? []) {
        const call = c.type === "tool_result" && byId.get(c.tool_use_id);
        if (call) call.result = toolResult(c.content);
      }
    } else if (e.type === "result") {
      const secs = Math.round((e.duration_ms ?? 0) / 1000);
      const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
      items.push({ kind: "info", text: `${e.is_error ? "Failed" : "Done"} in ${took} · ${e.num_turns} turns`, error: e.is_error });
    } else if (e.type === "marq_doc") {
      items.push({ kind: "doc", path: e.path, title: e.title, created: e.created !== false });
    } else if (e.type === "marq_crew") {
      items.push({ kind: "crew", path: e.path, title: e.title });
    } else if (e.type === "marq_approval") {
      items.push({ kind: "info", text: `${e.allow ? (e.always ? "Always allowed" : "Allowed") : "Denied"} ${e.tool}`, error: !e.allow });
    } else if (e.type === "marq_exit" && e.status === "error") {
      items.push({ kind: "info", text: `error${e.stderr ? `: ${e.stderr}` : ""}`, error: true });
    }
  }
  return items;
}

function ToolRow({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[item.name] ?? Wrench;
  const lines = item.result?.split("\n").length ?? 0;
  return (
    <div className={`tool-row ${open ? "open" : ""}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} disabled={item.result === undefined}>
        <Icon size={13} className="tool-icon" />
        <span className="tool-name">{item.name}</span>
        <span className="tool-arg">{item.arg}</span>
        {item.result === undefined ? (
          <Loader2 size={12} className="spin" />
        ) : (
          <span className="tool-lines">{lines} lines <ChevronRight size={12} className="chev" /></span>
        )}
      </button>
      {open && <pre className="tool-out">{item.result}</pre>}
    </div>
  );
}

/** What a tool call is about to do, for the approval card. */
function approvalDetail(a: Approval): string {
  const i = a.input ?? {};
  if (typeof i.command === "string") return i.command;
  if (typeof i.file_path === "string") {
    if (typeof i.old_string === "string") return `${i.file_path}\n\n- ${i.old_string}\n+ ${i.new_string ?? ""}`;
    if (typeof i.content === "string") return `${i.file_path}\n\n${i.content.slice(0, 2000)}`;
    return i.file_path;
  }
  return JSON.stringify(i, null, 2);
}

function ApprovalCard({ a }: { a: Approval }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const answer = async (allow: boolean, always = false) => {
    setBusy(true);
    try {
      await api.answerApproval(a.request_id, allow, always, allow ? undefined : note || undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="approval">
      <div className="approval-head">
        <ShieldQuestion size={15} />
        <span>{a.title ?? `Claude wants to use ${a.tool_name}`}</span>
      </div>
      {a.reason && <div className="muted small">{a.reason}</div>}
      <pre className="approval-detail">{approvalDetail(a)}</pre>
      <div className="approval-actions">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tell Claude what to do instead (optional)" />
        <button className="danger" disabled={busy} onClick={() => answer(false)}><X size={13} /> Deny</button>
        <button disabled={busy} onClick={() => answer(true, true)} title={`Allow ${a.tool_name} for the rest of this session`}>
          Always allow
        </button>
        <button className="primary" disabled={busy} onClick={() => answer(true)}><Check size={13} /> Allow</button>
      </div>
    </div>
  );
}

export function SessionView({ vault, sessionId, onOpenOrigin, onOpenSession, onSendExcerpt, onOpenCrew, compact }: Props) {
  const messagesRef = useRef<HTMLDivElement>(null);
  // null until the user picks a tab: Changes for worktree sessions, otherwise the note.
  const [side, setSide] = useState<"changes" | "note" | null>(null);
  const [sideOpen, setSideOpen] = useState(!compact);
  const sideWidth = usePaneSize("sessionSide", 480, 300, 2000);
  const composerHeight = usePaneSize("composer", 52, 36, 420);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [summarizing, setSummarizing] = useState(false);
  // Review state lives in the session list, not in the streamed events.
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const loadInfo = () => api.listSessions(vault).then((l) => setInfo(l.find((x) => x.id === sessionId) ?? null));
  const setReview = async (state: "done" | "open") => {
    try {
      await api.setSessionReview(vault, sessionId, state);
      await loadInfo();
    } catch (e) {
      setError(String(e));
    }
  };
  const [notice, setNotice] = useState<string | null>(null);
  const [events, setEvents] = useState<ClaudeEvent[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api.sessionEvents(vault, sessionId).then((ev) => alive && setEvents(ev)).catch((e) => setError(String(e)));
    const un1 = listen<{ session_id: string; event: ClaudeEvent }>("claude://event", (e) => {
      if (e.payload.session_id === sessionId) setEvents((prev) => [...prev, e.payload.event]);
    });
    // Reload on exit so marq_exit (written by the backend, not streamed) shows up.
    const un2 = listen<{ session_id: string }>("claude://exit", (e) => {
      if (e.payload.session_id === sessionId) api.sessionEvents(vault, sessionId).then(setEvents);
    });
    return () => {
      alive = false;
      un1.then((f) => f());
      un2.then((f) => f());
    };
  }, [vault, sessionId]);

  useEffect(() => {
    loadInfo();
    const uns = ["claude://turn", "claude://exit", "sessions://changed"].map((ev) => listen(ev, () => loadInfo()));
    return () => uns.forEach((u) => u.then((f) => f()));
  }, [vault, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const load = () => api.listApprovals(sessionId).then(setApprovals);
    load();
    const un = listen<{ session_id: string }>("claude://approval", (e) => e.payload.session_id === sessionId && load());
    return () => {
      un.then((f) => f());
    };
  }, [sessionId]);

  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [events.length, approvals.length]);

  const meta = events.find((e) => e.type === "marq_meta");
  // A turn is running from a prompt until its result.
  const last = [...events].reverse().find((e) => ["marq_user", "result", "marq_exit"].includes(e.type));
  const running = last?.type === "marq_user";
  const status = approvals.length
    ? "waiting"
    : running
      ? "running"
      : last?.type === "result" && last.is_error
        ? "error"
        : last?.type === "marq_exit" && last.status === "error"
          ? "error"
          : last?.type === "marq_exit" && ["interrupted", "stopped"].includes(last.status)
            ? "interrupted"
            : "done";
  const stopped = status === "interrupted" || status === "error";
  const [resuming, setResuming] = useState(false);

  const resume = async () => {
    setResuming(true);
    try {
      await api.resumeSession(vault, sessionId);
      setEvents(await api.sessionEvents(vault, sessionId));
    } catch (e) {
      setError(String(e));
    } finally {
      setResuming(false);
    }
  };
  const model = events.find((e) => e.type === "system" && e.subtype === "init")?.model;
  const worktree: Worktree | undefined = meta?.worktree ?? undefined;
  const panel = side ?? (worktree ? "changes" : "note");

  const summarize = async () => {
    setSummarizing(true);
    try {
      await api.summarizeSession(vault, sessionId);
      setNotice("Summary and learnings written to the session note");
    } catch (e) {
      setError(String(e));
    } finally {
      setSummarizing(false);
    }
  };

  const [pushing, setPushing] = useState(false);
  const push = async () => {
    setPushing(true);
    try {
      setNotice(`Pushed to ${await api.sessionPushCwd(vault, sessionId)}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setPushing(false);
    }
  };

  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** Appends to the message box and focuses it. */
  const compose = (text: string) => {
    setInput((v) => (v.trim() ? `${v.trimEnd()}\n\n${text}` : text));
    requestAnimationFrame(() => {
      const el = composerRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  };
  const sendText = async (text: string) => {
    await api.sendMessage(vault, sessionId, text);
    setEvents(await api.sessionEvents(vault, sessionId));
  };

  const send = async () => {
    if (!input.trim()) return;
    try {
      await api.sendMessage(vault, sessionId, input);
      setInput("");
      setEvents(await api.sessionEvents(vault, sessionId));
    } catch (e) {
      setError(String(e));
    }
  };

  const openOrigin = async () => {
    const o = await api.sessionOrigin(vault, sessionId);
    if (o) onOpenOrigin(o.path, o.line);
    else setError("Origin note not found");
  };

  return (
    <div className="session">
      <header className="session-head">
        <div className="session-title">
          <h2 title={meta?.title}>{meta?.title ?? "Session"}</h2>
          <div className="session-meta">
            <span className={`pill status-${status}`}>{status}</span>
            {worktree ? (
              <span className="meta-item" title={`${worktree.branch}\n${worktree.path}`}>
                <GitBranch size={12} /> <span className="ellipsis">{worktree.branch}</span>
              </span>
            ) : (
              <span className="meta-item" title={meta?.cwd}>
                <FolderGit2 size={12} /> <span className="ellipsis">{meta?.cwd?.replace(/^\/Users\/[^/]+/, "~")}</span>
              </span>
            )}
            {model && <span className="meta-item"><Bot size={12} /> {model}</span>}
          </div>
        </div>
        {info && !running && (
          info.review ? (
            <button onClick={() => setReview("open")} title="Put this session back under Needs review">
              {info.review === "pr" ? <GitPullRequest size={14} /> : <CircleCheck size={14} />} {info.review === "pr" ? "PR opened" : "Done"}
            </button>
          ) : (
            <button onClick={() => setReview("done")} title="Mark as reviewed: leaves Needs review and closes the request">
              <CircleCheck size={14} /> Mark as done
            </button>
          )
        )}
        {info?.review === "done" && !worktree && !running && (
          <button onClick={push} disabled={pushing} title={`git push the branch checked out in ${meta?.cwd ?? "the project"}`}>
            {pushing ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} Push
          </button>
        )}
        <button onClick={openOrigin}><CornerUpLeft size={14} /> Origin note</button>
        <button onClick={summarize} disabled={summarizing || running || !events.some((e) => e.type === "result")}
          title="Write Summary and Learnings into the session note (runs on a fork of the conversation)">
          {summarizing ? <Loader2 size={14} className="spin" /> : <NotebookPen size={14} />} Summarize
        </button>
        {running && <button className="danger" onClick={() => api.stopSession(sessionId)}><Square size={12} /> Stop</button>}
        <button className={`icon ${sideOpen ? "on" : ""}`} title="Toggle side panel" onClick={() => setSideOpen(!sideOpen)}>
          <PanelRight size={14} />
        </button>
      </header>
      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          <AlertCircle size={14} /> {error}
        </div>
      )}
      {notice && (
        <div className="banner ok" onClick={() => setNotice(null)}>
          <Check size={14} /> {notice}
        </div>
      )}
      <div className="session-body">
      <div className="session-main">
      <div className="messages" ref={messagesRef}>
        <SelectionPopover container={messagesRef}
          onSend={(text) => onSendExcerpt({ text, source: `session: ${meta?.title ?? sessionId}` })} />
        <div className="messages-inner">
          {toItems(events).map((it, i) => {
            switch (it.kind) {
              case "user":
                return <div key={i} className="msg user"><Md>{it.text}</Md></div>;
              case "text":
                return <div key={i} className="msg assistant"><Md>{it.text}</Md></div>;
              case "tool":
                return <ToolRow key={i} item={it} />;
              case "info":
                return <div key={i} className={`info ${it.error ? "err" : ""}`}>{it.text}</div>;
              case "doc":
                return (
                  <a key={i} className="doc-card" onClick={() => onOpenOrigin(`${vault}/${it.path}`, 0)} title="Open in a tab">
                    <FileOutput size={18} />
                    <span className="doc-card-body">
                      <span className="doc-card-title">{it.title}</span>
                      <span className="muted small mono">{it.created ? "Saved to" : "Updated"} {it.path}</span>
                    </span>
                  </a>
                );
              case "crew":
                return (
                  <a key={i} className="doc-card" onClick={() => onOpenCrew?.(it.path, it.title)} title="Open the crew">
                    <Users size={18} />
                    <span className="doc-card-body">
                      <span className="doc-card-title">{it.title}</span>
                      <span className="muted small mono">Handed to a crew · {it.path}</span>
                    </span>
                  </a>
                );
            }
          })}
          {approvals.map((a) => <ApprovalCard key={a.request_id} a={a} />)}
          {running && approvals.length === 0 && (
            <div className="thinking"><Loader2 size={14} className="spin" /> Working…</div>
          )}
          <div ref={bottom} />
        </div>
      </div>
      <div className="composer">
        {stopped && (
          <div className="resume-bar">
            <AlertCircle size={15} />
            <span>{status === "error" ? "This session stopped with an error." : "This session was interrupted before it finished."}</span>
            <button className="primary" onClick={resume} disabled={resuming}>
              {resuming ? <Loader2 size={14} className="spin" /> : <RotateCw size={14} />} Resume
            </button>
          </div>
        )}
        <Resizer axis="y" sign={-1} pane={composerHeight} />
        <div className="composer-box">
          <SlashTextarea
            ref={composerRef}
            value={input}
            onChange={setInput}
            vault={vault}
            sessionId={sessionId}
            style={{ height: composerHeight.size }}
            placeholder={running ? "Queue a follow-up for after this turn…  (⌘↵)" : "Follow up… / for skills and commands  (⌘↵ to send)"}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
            }}
          />
          <button className="send" onClick={send} disabled={!input.trim()} title="Send">
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
      </div>
      {sideOpen && <Resizer axis="x" sign={-1} pane={sideWidth} />}
      {sideOpen && (
        <aside className="session-side" style={{ width: sideWidth.size }}>
          <div className="side-switch">
            {worktree && (
              <button className={panel === "changes" ? "on" : ""} onClick={() => setSide("changes")}>Changes</button>
            )}
            <button className={panel === "note" ? "on" : ""} onClick={() => setSide("note")}>Note</button>
          </div>
          <div className="side-content">
            {panel === "changes" && worktree ? (
              <ChangesPanel vault={vault} sessionId={sessionId} worktree={worktree} title={meta?.title ?? ""} running={running}
                onCompose={compose} onSend={sendText} />
            ) : (
              <OriginNotePanel vault={vault} sessionId={sessionId} onOpenNote={onOpenOrigin} onOpenSession={onOpenSession} />
            )}
          </div>
        </aside>
      )}
      </div>
    </div>
  );
}
