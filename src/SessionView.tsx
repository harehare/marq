import { KeyboardEvent, ReactNode, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isSendKey, sendHint, useSettings } from "./settings";
import { attempt } from "./attempt";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowUp, CornerUpLeft, Square, FileText, FilePen, Terminal, Search, Globe, Wrench, ChevronRight, Bot, Loader2,
  FolderGit2, AlertCircle, GitBranch, PanelRight, ShieldQuestion, Check, X, NotebookPen, FileOutput, RotateCw, CircleCheck, GitPullRequest, Users, Upload,
  Forward, MessageSquareReply, MessagesSquare, ExternalLink, MessageCircleQuestion,
} from "lucide-react";
import { api, Approval, SessionEvent, SessionInfo, Worktree } from "./api";
import { Md } from "./markdown/Md";
import { ChangesPanel } from "./review/ChangesPanel";
import { OriginNotePanel } from "./review/OriginNotePanel";
import { SessionDocsPanel } from "./review/SessionDocsPanel";
import { Resizer, usePaneSize } from "./Resizer";
import { SlashTextarea } from "./SlashTextarea";
import { usePastes } from "./pastes";
import { useStickToBottom } from "./useStickToBottom";
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
  | { kind: "tool"; name: string; toolKind: string; arg: string; result?: string }
  | { kind: "info"; text: string; error?: boolean }
  | { kind: "doc"; path: string; title: string; created: boolean }
  | { kind: "crew"; path: string; title: string }
  /** Markdown files the turn wrote or edited, shown when it ends. */
  | { kind: "files"; paths: string[] }
  /** A message from or to another session. */
  | { kind: "relay"; dir: "in" | "out" | "reply"; session: string; title: string; reply: boolean; by: string };

/** Tallest the message box grows to before it scrolls, in pixels. */
const COMPOSER_MAX = 420;

/** Messages sent from any session's box, oldest first, for ↑/↓ recall. */
const HISTORY_KEY = "marq.inputHistory";
const HISTORY_MAX = 200;
function loadHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}
function saveHistory(text: string) {
  try {
    const list = [...loadHistory().filter((t) => t !== text), text].slice(-HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    // Recall is a convenience; without storage it only covers this session.
  }
}

function toolArg(input: any): string {
  for (const k of ["file_path", "command", "pattern", "path", "url", "query", "description"]) {
    if (typeof input?.[k] === "string") return input[k];
  }
  return JSON.stringify(input);
}

/** Icons by tool kind, which every agent backend reports (see `sidecar/protocol.ts`). */
const TOOL_ICONS: Record<string, typeof Wrench> = {
  read: FileText, edit: FilePen, execute: Terminal, search: Search, fetch: Globe,
};

/** Folds session events into display items, attaching each tool result to its call. */
function toItems(events: SessionEvent[]): Item[] {
  const items: Item[] = [];
  const byId = new Map<string, Extract<Item, { kind: "tool" }>>();
  let written: string[] = [];
  for (const e of events) {
    if (e.type === "marq_user") items.push({ kind: "user", text: e.text });
    else if (e.type === "text") {
      if (e.text.trim()) items.push({ kind: "text", text: e.text });
    } else if (e.type === "tool_call") {
      const file = toolArg(e.input);
      if (e.kind === "edit" && /\.(md|markdown)$/i.test(file) && !written.includes(file)) written.push(file);
      const item = { kind: "tool" as const, name: e.name, toolKind: e.kind, arg: file };
      byId.set(e.id, item);
      items.push(item);
    } else if (e.type === "tool_result") {
      const call = byId.get(e.id);
      if (call) call.result = e.output;
    } else if (e.type === "turn_end") {
      const secs = Math.round((e.duration_ms ?? 0) / 1000);
      const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
      const turns = e.num_turns ? ` · ${e.num_turns} turns` : "";
      items.push({ kind: "info", text: `${e.is_error ? "Failed" : "Done"} in ${took}${turns}`, error: e.is_error });
      if (written.length) items.push({ kind: "files", paths: written });
      written = [];
    } else if (e.type === "marq_doc") {
      items.push({ kind: "doc", path: e.path, title: e.title, created: e.created !== false });
    } else if (e.type === "marq_message") {
      items.push({ kind: "relay", dir: e.by === "reply" ? "reply" : "in", session: e.from, title: e.title, reply: !!e.reply, by: e.by });
    } else if (e.type === "marq_sent") {
      items.push({ kind: "relay", dir: "out", session: e.to, title: e.title, reply: !!e.reply, by: e.by });
    } else if (e.type === "marq_crew") {
      items.push({ kind: "crew", path: e.path, title: e.title });
    } else if (e.type === "marq_approval" && e.tool === "AskUserQuestion") {
      const answers = Object.entries((e.answers ?? {}) as Record<string, string>);
      items.push(e.allow && answers.length
        ? { kind: "info", text: `You answered: ${answers.map(([q, a]) => `${q} → ${a}`).join(" / ")}` }
        : { kind: "info", text: "You skipped the question", error: true });
    } else if (e.type === "marq_approval") {
      items.push({ kind: "info", text: `${e.allow ? (e.always ? "Always allowed" : "Allowed") : "Denied"} ${e.tool}`, error: !e.allow });
    } else if (e.type === "marq_verify") {
      const of = e.of ? ` (attempt ${e.attempt} of ${e.of})` : "";
      if (e.stage === "handoff") {
        items.push({ kind: "info", text: e.why === "phase" ? "The next phase continues in a new session" : "Retrying in a new session with a fresh context" });
      } else if (e.status === "running") {
        items.push({ kind: "info", text: e.stage === "acceptance" ? "Acceptance check started in a separate session…" : `Checking: ${e.command}…` });
      } else {
        const what = e.stage === "acceptance" ? "Acceptance check" : `Check \`${e.command}\``;
        items.push({ kind: "tool", name: e.stage === "acceptance" ? "acceptance" : "verify", toolKind: "execute", arg: e.command ?? "verdict", result: e.output });
        items.push({ kind: "info", text: `${what} ${e.passed ? "passed" : "failed"}${e.passed ? "" : of}`, error: !e.passed });
      }
    } else if (e.type === "marq_phase") {
      items.push({ kind: "info", text: `Phase ${e.done} done. Next: ${e.next}${e.auto ? ", starting now" : " (Start on the request runs it)"}` });
    } else if (e.type === "marq_exit" && e.status === "error") {
      items.push({ kind: "info", text: `error${e.stderr ? `: ${e.stderr}` : ""}`, error: true });
    }
  }
  return items;
}

type ToolItem = Extract<Item, { kind: "tool" }>;

/** toItems builds new objects on every event, so compare the fields, not the object. */
const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[item.toolKind] ?? Wrench;
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
}, (a, b) => a.item.name === b.item.name && a.item.toolKind === b.item.toolKind && a.item.arg === b.item.arg && a.item.result === b.item.result);

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

type Question = { question: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] };

/** AskUserQuestion: the agent's questions with their options. The choices go back as the tool's `answers`. */
function QuestionCard({ a }: { a: Approval }) {
  const questions: Question[] = Array.isArray(a.input?.questions) ? a.input.questions : [];
  // Per question: the chosen labels, and the text typed under Other.
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const choose = (qi: number, label: string, multi?: boolean) =>
    setPicked((p) => p.map((l, i) => (i !== qi ? l : multi ? (l.includes(label) ? l.filter((x) => x !== label) : [...l, label]) : [label])));
  const answerOf = (qi: number) => {
    const typed = other[qi].trim();
    const labels = picked[qi].filter((l) => l !== OTHER);
    return [...labels, ...(picked[qi].includes(OTHER) && typed ? [typed] : [])].join(", ");
  };
  const ready = questions.length > 0 && questions.every((_, i) => answerOf(i));
  const submit = async (allow: boolean) => {
    setBusy(true);
    await attempt(async () => {
      const answers = Object.fromEntries(questions.map((q, i) => [q.question, answerOf(i)]));
      await api.answerApproval(a.request_id, allow, false, allow ? undefined : "The user skipped the question.", allow ? answers : undefined);
    }, undefined, () => setBusy(false));
  };
  return (
    <div className="approval question">
      {questions.map((q, qi) => (
        <div key={qi} className="question-block">
          <div className="approval-head">
            <MessageCircleQuestion size={15} />
            {q.header && <span className="question-chip">{q.header}</span>}
            <span>{q.question}</span>
          </div>
          <div className="question-options">
            {[...(q.options ?? []), { label: OTHER, description: undefined }].map((o) => {
              const on = picked[qi].includes(o.label);
              return (
                <button key={o.label} className={`question-option ${on ? "on" : ""}`} disabled={busy}
                  onClick={() => choose(qi, o.label, q.multiSelect)}>
                  <span className="question-mark">{q.multiSelect ? (on ? "☑" : "☐") : on ? "◉" : "○"}</span>
                  <span className="question-text">
                    <span>{o.label}</span>
                    {o.description && <span className="muted small">{o.description}</span>}
                  </span>
                </button>
              );
            })}
            {picked[qi].includes(OTHER) && (
              <input autoFocus value={other[qi]} placeholder="Your answer" disabled={busy}
                onChange={(e) => setOther((t) => t.map((x, i) => (i === qi ? e.target.value : x)))}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && ready && submit(true)} />
            )}
          </div>
        </div>
      ))}
      <div className="approval-actions">
        <span className="muted small" style={{ flex: 1 }}>{questions.some((q) => q.multiSelect) ? "Pick one or more where marked." : ""}</span>
        <button disabled={busy} onClick={() => submit(false)}><X size={13} /> Skip</button>
        <button className="primary" disabled={busy || !ready} onClick={() => submit(true)}><Check size={13} /> Answer</button>
      </div>
    </div>
  );
}

const OTHER = "Other";

function ApprovalCard({ a }: { a: Approval }) {
  if (a.tool_name === "AskUserQuestion") return <QuestionCard a={a} />;
  return <PermissionCard a={a} />;
}

function PermissionCard({ a }: { a: Approval }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const answer = async (allow: boolean, always = false) => {
    setBusy(true);
    await attempt(async () => {
      await api.answerApproval(a.request_id, allow, always, allow ? undefined : note || undefined);
    }, undefined, () => setBusy(false));
  };
  return (
    <div className="approval">
      <div className="approval-head">
        <ShieldQuestion size={15} />
        <span>{a.title ?? `The agent wants to use ${a.tool_name}`}</span>
      </div>
      {a.reason && <div className="muted small">{a.reason}</div>}
      <pre className="approval-detail">{approvalDetail(a)}</pre>
      <div className="approval-actions">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What to do instead (optional)" />
        <button className="danger" disabled={busy} onClick={() => answer(false)}><X size={13} /> Deny</button>
        <button disabled={busy} onClick={() => answer(true, true)} title={`Allow ${a.tool_name} for the rest of this session`}>
          Always allow
        </button>
        <button className="primary" disabled={busy} onClick={() => answer(true)}><Check size={13} /> Allow</button>
      </div>
    </div>
  );
}

type ListProps = {
  vault: string;
  events: SessionEvent[];
  onOpenOrigin: (path: string, line: number) => void;
  onOpenSession: (id: string, title: string) => void;
  onOpenCrew?: (rel: string, title: string) => void;
  onError: (message: string) => void;
};

/** The conversation. Memoized so typing in the composer does not render every message again;
 * a new event renders the list, and Md/ToolRow skip the messages that did not change. */
const MessageList = memo(function MessageList({ vault, events, onOpenOrigin, onOpenSession, onOpenCrew, onError }: ListProps) {
  const items = useMemo(() => toItems(events), [events]);
  const openNote = useCallback((path: string) => onOpenOrigin(path, 0), [onOpenOrigin]);
  return (
    <>
    {items.map((it, i) => {
      switch (it.kind) {
        case "user":
          return <div key={i} className="msg user"><Md onOpenNote={openNote}>{it.text}</Md></div>;
        case "text":
          return <div key={i} className="msg assistant"><Md onOpenNote={openNote}>{it.text}</Md></div>;
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
        case "files":
          return (
            <div key={i} className="written-files">
              {it.paths.map((p) => {
                const inVault = p.startsWith(`${vault}/`);
                return (
                  <a key={p} className="doc-card" title={inVault ? "Open in a tab" : "Open with the default app"}
                    onClick={() => (inVault ? onOpenOrigin(p, 0) : api.openIn(p, "finder").catch((e) => onError(String(e))))}>
                    <FileText size={18} />
                    <span className="doc-card-body">
                      <span className="doc-card-title">{p.split("/").pop()}</span>
                      <span className="muted small mono ellipsis">Wrote {inVault ? p.slice(vault.length + 1) : p.replace(/^\/Users\/[^/]+/, "~")}</span>
                    </span>
                    <ExternalLink size={13} className="muted" />
                  </a>
                );
              })}
            </div>
          );
        case "relay":
          return (
            <a key={i} className={`relay-row ${it.dir}`} onClick={() => onOpenSession(it.session, it.title)} title="Open that session">
              {it.dir === "out" ? <Forward size={13} /> : it.dir === "reply" ? <MessageSquareReply size={13} /> : <MessagesSquare size={13} />}
              <span className="ellipsis">
                {it.dir === "out" ? (it.by === "user" ? "You sent this to " : "Sent to ")
                  : it.dir === "reply" ? "Reply from " : it.by === "user" ? "Forwarded by you from " : "Message from "}
                <b>{it.title}</b>
              </span>
              {it.reply && <span className="muted small">{it.dir === "out" ? "· the answer comes back here" : "· your answer goes back"}</span>}
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
    </>
  );
});

export function SessionView({ vault, sessionId, onOpenOrigin, onOpenSession, onSendExcerpt, onOpenCrew, compact }: Props) {
  const sendKey = useSettings().chat?.send;
  const messagesRef = useRef<HTMLDivElement>(null);
  // null until the user picks a tab: Changes for worktree sessions, otherwise the note.
  const [side, setSide] = useState<"changes" | "note" | "docs" | null>(null);
  // How many documents the task has written, for the Docs tab's count.
  const [docCount, setDocCount] = useState(0);
  useEffect(() => {
    setDocCount(0);
    api.sessionDocs(vault, sessionId).then((d) => setDocCount(d.length)).catch(() => {});
    const un = listen<{ session_id: string; event: { type?: string } }>("session://event", (e) => {
      if (e.payload.session_id === sessionId && e.payload.event?.type === "marq_doc") {
        api.sessionDocs(vault, sessionId).then((d) => setDocCount(d.length)).catch(() => {});
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [vault, sessionId]);
  const [sideOpen, setSideOpen] = useState(!compact);
  const sideWidth = usePaneSize("sessionSide", 480, 300, 2000);
  const sideRef = useRef<HTMLElement>(null);
  const composerHeight = usePaneSize("composer", 52, 36, COMPOSER_MAX);
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
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [input, setInput] = useState("");
  const pastes = usePastes();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.sessionEvents(vault, sessionId).then((ev) => alive && setEvents(ev)).catch((e) => setError(String(e)));
    const un1 = listen<{ session_id: string; event: SessionEvent }>("session://event", (e) => {
      if (e.payload.session_id !== sessionId) return;
      const ev = e.payload.event;
      // A message this view sent may already be in the log it reloaded after sending.
      setEvents((prev) => (ev.type === "marq_user" && prev.some((p) => p.type === "marq_user" && p.text === ev.text && p.timestamp === ev.timestamp)
        ? prev : [...prev, ev]));
    });
    // Reload on exit so marq_exit (written by the backend, not streamed) shows up.
    const un2 = listen<{ session_id: string }>("session://exit", (e) => {
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
    const uns = ["session://turn", "session://exit", "sessions://changed"].map((ev) => listen(ev, () => loadInfo()));
    return () => uns.forEach((u) => u.then((f) => f()));
  }, [vault, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const load = () => api.listApprovals(sessionId).then(setApprovals);
    load();
    const un = listen<{ session_id: string }>("session://approval", (e) => e.payload.session_id === sessionId && load());
    return () => {
      un.then((f) => f());
    };
  }, [sessionId]);

  // Opens at the latest message and follows new ones.
  const stick = useStickToBottom<HTMLDivElement>([events.length, approvals.length]);
  const messagesEl = useCallback((el: HTMLDivElement | null) => {
    messagesRef.current = el;
    stick(el);
  }, [stick]);

  const meta = events.find((e) => e.type === "marq_meta");
  const title: string = info?.title ?? meta?.title ?? "session";
  // A turn is running from a prompt until its result.
  const last = [...events].reverse().find((e) => ["marq_user", "turn_end", "marq_exit"].includes(e.type));
  const running = last?.type === "marq_user";
  const status = approvals.length
    ? "waiting"
    : running
      ? "running"
      : last?.type === "turn_end" && last.is_error
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
    await attempt(async () => {
      await api.resumeSession(vault, sessionId);
      setEvents(await api.sessionEvents(vault, sessionId));
    }, (e) => {
      setError(String(e));
    }, () => setResuming(false));
  };
  const model = events.find((e) => e.type === "init")?.model;
  const worktree: Worktree | undefined = meta?.worktree ?? undefined;
  // A session without a worktree ran in its project; show that checkout's uncommitted changes.
  const [checkout, setCheckout] = useState<Worktree | null>(null);
  const hasMeta = !!meta;
  const hasWorktree = !!meta?.worktree;
  useEffect(() => {
    setCheckout(null);
    if (hasMeta && !hasWorktree) api.sessionCheckout(vault, sessionId).then(setCheckout, () => {});
  }, [vault, sessionId, hasMeta, hasWorktree]);
  // Worktrees of the workspace's other directories get a tab each in the Changes panel.
  const dirTrees: Worktree[] = (meta?.dirs ?? []).flatMap((d: { worktree?: Worktree | null }) => (d.worktree ? [d.worktree] : []));
  const [repoTab, setRepoTab] = useState<string | null>(null);
  useEffect(() => setRepoTab(null), [sessionId]);
  const otherTree = repoTab ? dirTrees.find((w) => w.repo === repoTab) : undefined;
  const diffable = worktree ?? checkout ?? undefined;
  const panel = side ?? (diffable ? "changes" : "note");
  const repoName = (w: Worktree) => w.repo.replace(/\/+$/, "").split("/").pop();

  const summarize = async () => {
    setSummarizing(true);
    await attempt(async () => {
      await api.summarizeSession(vault, sessionId);
      setNotice("Summary and learnings written to the session note");
    }, (e) => {
      setError(String(e));
    }, () => setSummarizing(false));
  };

  const [pushing, setPushing] = useState(false);
  const push = async () => {
    setPushing(true);
    await attempt(async () => {
      setNotice(`Pushed to ${await api.sessionPushCwd(vault, sessionId)}`);
    }, (e) => {
      setError(String(e));
    }, () => setPushing(false));
  };

  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Grows with the text; the dragged height is the minimum, and past the cap the box scrolls.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(COMPOSER_MAX, Math.max(composerHeight.size, el.scrollHeight))}px`;
  }, [input, composerHeight.size]);
  /** Appends to the message box and focuses it. */
  const compose = useCallback((text: string) => {
    setInput((v) => (v.trim() ? `${v.trimEnd()}\n\n${text}` : text));
    requestAnimationFrame(() => {
      const el = composerRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  }, [setInput]);
  const sendText = useCallback(async (text: string) => {
    // The message comes back as an event, like the rest of the turn.
    await api.sendMessage(vault, sessionId, text);
  }, [vault, sessionId]);

  // Earlier messages, recalled with ↑/↓ while the box is empty: this session's own, newest last,
  // after those sent in other sessions.
  const recall = useRef<{ list: string[]; at: number } | null>(null);
  const history = () => {
    const own = events.flatMap((e) => (e.type === "marq_user" ? [e.text] : []));
    return [...loadHistory().filter((t) => !own.includes(t)), ...own];
  };
  const recallKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const r = recall.current;
    // Only from an empty box or one still showing a recalled message, so ↑/↓ keep moving the caret otherwise.
    if (input !== (r ? r.list[r.at] ?? "" : "")) {
      recall.current = null;
      if (input) return false;
    }
    const list = recall.current?.list ?? history();
    const at = (recall.current?.at ?? list.length) + (e.key === "ArrowUp" ? -1 : 1);
    if (at < 0 || at > list.length || !list.length) return false;
    e.preventDefault();
    recall.current = at === list.length ? null : { list, at };
    const text = list[at] ?? "";
    setInput(text);
    requestAnimationFrame(() => composerRef.current?.setSelectionRange(text.length, text.length));
    return true;
  };

  // Esc interrupts the turn wherever the focus is in this view, or anywhere when this is the only session on screen.
  const rootRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(false);
  useLayoutEffect(() => {
    runningRef.current = running;
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const root = rootRef.current;
      // defaultPrevented: the app's own Esc bindings (leaving the tree, a key mode) claimed it.
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented || !runningRef.current || !root?.offsetParent) return;
      // Esc closes dialogs and menus first.
      if (document.querySelector(".modal-backdrop, .context-menu")) return;
      const at = document.activeElement as HTMLElement | null;
      const typing = at?.closest("input, textarea, select, [contenteditable=true], .cm-editor, .terminal-view");
      if (typing && at !== composerRef.current) return;
      const other = at?.closest(".session");
      if (other ? other !== root : [...document.querySelectorAll<HTMLElement>(".session")].some((s) => s !== root && s.offsetParent)) return;
      e.preventDefault();
      api.stopSession(sessionId).catch((err) => setError(String(err)));
    };
    // On the document, so it runs before the window listener that swallows every Esc.
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sessionId]);

  const send = async () => {
    if (!input.trim()) return;
    const text = pastes.expand(input);
    try {
      await api.sendMessage(vault, sessionId, text);
      saveHistory(text);
      recall.current = null;
      setInput("");
      pastes.clear();
    } catch (e) {
      setError(String(e));
    }
  };

  // The title, edited in place after a double-click.
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const renameTo = async () => {
    const t = editingTitle?.trim();
    setEditingTitle(null);
    if (!t || t === title) return;
    try {
      await api.renameSession(vault, sessionId, t);
      await loadInfo();
    } catch (e) {
      setError(String(e));
    }
  };

  // Forward what is typed, with the latest answer as context, to another session.
  const latest = [...events].reverse().find((e) => e.type === "turn_end")?.result as string | undefined;
  const forward = () => {
    onSendExcerpt({
      text: latest?.trim() || pastes.expand(input),
      source: `latest answer in session: ${title}`,
      from: { id: sessionId, title },
      instruction: latest?.trim() ? pastes.expand(input) : "",
    });
  };

  const openOrigin = async () => {
    const o = await api.sessionOrigin(vault, sessionId);
    if (o) onOpenOrigin(o.path, o.line);
    else setError("Origin note not found");
  };

  return (
    <div className="session" ref={rootRef}>
      <header className="session-head">
        <div className="session-title">
          {editingTitle !== null ? (
            <input className="session-title-input" autoFocus value={editingTitle} onChange={(e) => setEditingTitle(e.target.value)}
              onBlur={renameTo} onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) renameTo();
                if (e.key === "Escape") setEditingTitle(null);
              }} />
          ) : (
            <h2 title={`${title}\nDouble-click to rename`} onDoubleClick={() => setEditingTitle(title)}>{meta ? title : "Session"}</h2>
          )}
          <div className="session-meta">
            <span className={`pill status-${status}`}>{status}</span>
            {worktree ? (
              <CopyMeta value={worktree.branch} alt={worktree.path} icon={<GitBranch size={12} />}
                title={`${worktree.branch}\n${worktree.path}\nClick to copy the branch, ⌥-click to copy the path`} />
            ) : meta?.cwd ? (
              <CopyMeta value={meta.cwd} label={meta.cwd.replace(/^\/Users\/[^/]+/, "~")} icon={<FolderGit2 size={12} />}
                title={`${meta.cwd}\nClick to copy the path`} />
            ) : null}
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
        {/* Without a worktree the changes panel has no commit and push buttons, so pushing is offered here once a turn ends. */}
        {info && !worktree && !running && info.review !== "pr" && events.some((e) => e.type === "turn_end") && (
          <button onClick={push} disabled={pushing} title={`git push the branch checked out in ${meta?.cwd ?? "the project"}`}>
            {pushing ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} Push
          </button>
        )}
        <button onClick={openOrigin}><CornerUpLeft size={14} /> Origin note</button>
        <button onClick={summarize} disabled={summarizing || running || !events.some((e) => e.type === "turn_end")}
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
      <div className="messages" ref={messagesEl}>
        <SelectionPopover container={messagesRef}
          onSend={(text) => onSendExcerpt({ text, source: `session: ${title}`, from: { id: sessionId, title } })} />
        <div className="messages-inner">
          <MessageList vault={vault} events={events} onOpenOrigin={onOpenOrigin} onOpenSession={onOpenSession}
            onOpenCrew={onOpenCrew} onError={setError} />
          {approvals.map((a) => <ApprovalCard key={a.request_id} a={a} />)}
          {running && approvals.length === 0 && (
            <div className="thinking"><Loader2 size={14} className="spin" /> Working…</div>
          )}
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
            pastes={pastes}
            placeholder={running ? `Queue a follow-up for after this turn…  (${sendHint(sendKey)}, Esc to interrupt)` : `Follow up… / for skills and commands  (${sendHint(sendKey)} to send)`}
            onKeyDown={(e) => {
              if (isSendKey(e, sendKey)) { e.preventDefault(); send(); }
              else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.metaKey) recallKey(e);
            }}
          />
          <button className="icon forward" onClick={forward} disabled={!input.trim() && !latest}
            title="Send to another session: what you typed, with this session's latest answer. Its answer can come back here.">
            <Forward size={15} />
          </button>
          <button className="send" onClick={send} disabled={!input.trim()} title="Send">
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
      </div>
      {sideOpen && <Resizer axis="x" sign={-1} pane={sideWidth}
        preview={(v) => sideRef.current && (sideRef.current.style.width = `${v}px`)} />}
      {sideOpen && (
        <aside ref={sideRef} className="session-side" style={{ width: sideWidth.size }}>
          <div className="side-switch">
            {diffable && (
              <button className={panel === "changes" ? "on" : ""} onClick={() => setSide("changes")}>Changes</button>
            )}
            <button className={panel === "note" ? "on" : ""} onClick={() => setSide("note")}>Note</button>
            <button className={panel === "docs" ? "on" : ""} onClick={() => setSide("docs")}>
              Docs {docCount > 0 && <span className="count">{docCount}</span>}
            </button>
          </div>
          <div className="side-content">
            {panel === "changes" && diffable && dirTrees.length > 0 && (
              <div className="repo-tabs">
                <button className={!otherTree ? "on" : ""} onClick={() => setRepoTab(null)} title={diffable.path}>{repoName(diffable)}</button>
                {dirTrees.map((w) => (
                  <button key={w.repo} className={otherTree?.repo === w.repo ? "on" : ""} onClick={() => setRepoTab(w.repo)} title={w.path}>
                    {repoName(w)}
                  </button>
                ))}
              </div>
            )}
            {panel === "docs" ? (
              <SessionDocsPanel vault={vault} sessionId={sessionId} onOpenNote={onOpenOrigin} onCount={setDocCount} />
            ) : panel === "changes" && diffable ? (
              <ChangesPanel key={`${sessionId}:${otherTree?.repo ?? ""}`} vault={vault} sessionId={sessionId}
                worktree={otherTree ?? diffable} repo={otherTree?.repo} checkout={!otherTree && !worktree}
                title={meta?.title ?? ""} running={running}
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

/** A session header item (branch or directory) that copies its value when clicked; ⌥-click copies `alt`. */
function CopyMeta({ value, alt, label, icon, title }: { value: string; alt?: string; label?: string; icon: ReactNode; title: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }, () => {});
  };
  return (
    <button type="button" className="meta-item meta-copy" title={title} onClick={(e) => copy(e.altKey && alt ? alt : value)}>
      {copied ? <Check size={12} /> : icon} <span className="ellipsis">{copied ? "Copied" : label ?? value}</span>
    </button>
  );
}
