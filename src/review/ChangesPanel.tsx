import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  GitBranch, GitCommitHorizontal, GitPullRequest, RefreshCw, FolderOpen, Terminal as TerminalIcon, Code2, Trash2,
  ChevronRight, AlertCircle, CheckCircle2, Pencil, ArrowUp, Check, Loader2, MessageSquareText, Send, TextCursorInput,
} from "lucide-react";
import { api, Changes, Worktree } from "../api";
import { DiffComment, DiffView } from "./DiffView";
import { Resizer, usePaneSize } from "../Resizer";
import { composing } from "../keys";

type Props = {
  vault: string; sessionId: string; worktree: Worktree; title: string; running: boolean;
  /** Puts text into the session's message box. */
  onCompose: (text: string) => void;
  /** Sends text to the session right away. */
  onSend: (text: string) => Promise<void>;
};

const MAX_DIFF_LINES = 600;

/** A file's diff as a fenced block for a message. */
function diffBlock(file: string, diff: string) {
  const body = diff.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  const cut = body.length > MAX_DIFF_LINES;
  return `\`${file}\`\n\`\`\`diff\n${body.slice(0, MAX_DIFF_LINES).join("\n").trimEnd()}\n\`\`\`${cut ? `\n(${body.length - MAX_DIFF_LINES} more lines cut)` : ""}`;
}

/** Review comments as one message: where, the code, and what to do. */
function reviewMessage(comments: DiffComment[]) {
  const parts = comments.map((c) => `**${c.file} ${c.label}**\n\`\`\`diff\n${c.code.join("\n")}\n\`\`\`\n${c.text}`);
  return `Review comments on your changes. Address each one:\n\n${parts.join("\n\n")}`;
}

const reviewKey = (sessionId: string) => `marq.review.${sessionId}`;

type Action = "commit" | "push" | "pr" | "remove" | "rename";

const STATUS_LABEL: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", "?": "new" };

export function ChangesPanel({ vault, sessionId, worktree: initial, title, running, onCompose, onSend }: Props) {
  // Review comments, kept until sent.
  const [comments, setComments] = useState<DiffComment[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(reviewKey(sessionId)) ?? "[]");
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      if (comments.length) localStorage.setItem(reviewKey(sessionId), JSON.stringify(comments));
      else localStorage.removeItem(reviewKey(sessionId));
    } catch {}
  }, [comments, sessionId]);
  const [sendingReview, setSendingReview] = useState(false);
  // Local copy, since renaming the branch changes it without reloading the session.
  const [worktree, setWorktree] = useState(initial);
  const [editingBranch, setEditingBranch] = useState<string | null>(null);
  const [changes, setChanges] = useState<Changes | null>(null);
  const [open, setOpen] = useState<Record<string, string | null>>({});
  const [message, setMessage] = useState(title);
  const [notice, setNotice] = useState<{ ok: boolean; text: string; url?: string } | null>(null);
  // What is running now, e.g. "push", so its button and the status line can show it.
  const [pending, setPending] = useState<{ kind: Action; label: string } | null>(null);
  const busy = pending !== null;
  const commitHeight = usePaneSize("commitMessage", 60, 34, 360);

  // Read through a ref so `refresh` stays stable; otherwise expanding a diff re-subscribes
  // the event listeners below, and an event arriving in that gap is lost.
  const openRef = useRef(open);
  openRef.current = open;
  // Refreshes can overlap (one per tool result); only the latest may apply its result.
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const c = await api.sessionChanges(vault, sessionId);
      // Reload diffs that are expanded, since the files may have changed.
      const expanded = Object.keys(openRef.current).filter((f) => openRef.current[f] !== null);
      const entries = (
        await Promise.all(expanded.map(async (f) => [f, await api.sessionFileDiff(vault, sessionId, f).catch(() => null)] as const))
      ).filter((e): e is readonly [string, string] => e[1] !== null);
      if (mine !== generation.current) return;
      setChanges(c);
      // Claude may rename the branch with git; show what is checked out.
      if (c.branch) setWorktree((w) => (w.branch === c.branch ? w : { ...w, branch: c.branch! }));
      // Skip files collapsed in the meantime.
      if (entries.length) setOpen((o) => ({ ...o, ...Object.fromEntries(entries.filter(([f]) => o[f] !== null)) }));
    } catch (e) {
      if (mine === generation.current) setNotice({ ok: false, text: String(e) });
    }
  }, [vault, sessionId]);

  useEffect(() => {
    refresh();
  }, [vault, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh after each file-editing tool result and when the turn ends.
  useEffect(() => {
    const un1 = listen<{ session_id: string; event: any }>("claude://event", (e) => {
      if (e.payload.session_id === sessionId && (e.payload.event.type === "user" || e.payload.event.type === "result")) refresh();
    });
    const un2 = listen<{ session_id: string }>("claude://exit", (e) => e.payload.session_id === sessionId && refresh());
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
    };
  }, [sessionId, refresh]);

  const toggle = async (file: string) => {
    if (open[file] !== undefined && open[file] !== null) {
      setOpen((o) => ({ ...o, [file]: null }));
      return;
    }
    const diff = await api.sessionFileDiff(vault, sessionId, file);
    setOpen((o) => ({ ...o, [file]: diff }));
  };

  const act = async (kind: Action, label: string, fn: () => Promise<{ text: string; url?: string }>) => {
    setPending({ kind, label });
    setNotice(null);
    try {
      setNotice({ ok: true, ...(await fn()) });
      await refresh();
    } catch (e) {
      setNotice({ ok: false, text: String(e) });
    } finally {
      setPending(null);
    }
  };

  const commit = () =>
    act("commit", "Committing…", async () => ({ text: `Committed ${await api.sessionCommit(vault, sessionId, message || title)}` }));
  const push = () =>
    act("push", `Pushing ${worktree.branch} to the remote…`, async () => ({ text: `Pushed to ${await api.sessionPush(vault, sessionId)}` }));
  const pr = () =>
    act("pr", `Pushing ${worktree.branch} and creating a pull request…`, async () => {
      const url = await api.sessionCreatePr(vault, sessionId, message || title);
      return { text: "Pull request created", url };
    });
  /** The button's icon, or a spinner while its action runs. */
  const icon = (kind: Action, Icon: typeof ArrowUp) =>
    pending?.kind === kind ? <Loader2 size={14} className="spin" /> : <Icon size={14} />;
  const remove = async () => {
    const ok = await ask(`Remove the worktree at ${worktree.path}?\n\nThe branch ${worktree.branch} is kept.`, {
      title: "Remove worktree", kind: "warning", okLabel: "Remove",
    });
    if (!ok) return;
    act("remove", "Removing the worktree…", async () => {
      await api.sessionRemoveWorktree(vault, sessionId);
      return { text: "Worktree removed. The branch is kept." };
    });
  };

  const uncommitted = changes?.dirty ?? false;
  /** Expanded, even when its diff is empty (an empty file, say). */
  const isOpen = (file: string) => open[file] !== undefined && open[file] !== null;

  const composeDiff = async (files: string[]) => {
    const blocks = await Promise.all(files.map(async (f) => diffBlock(f, open[f] ?? (await api.sessionFileDiff(vault, sessionId, f)))));
    onCompose(`${files.length > 1 ? "These changes" : "This change"} (against ${worktree.base_branch}):\n\n${blocks.join("\n\n")}\n\n`);
  };

  const sendReview = async () => {
    setSendingReview(true);
    try {
      await onSend(reviewMessage(comments));
      setComments([]);
      setNotice({ ok: true, text: `Sent ${comments.length} comment${comments.length === 1 ? "" : "s"} to the session` });
    } catch (e) {
      setNotice({ ok: false, text: String(e) });
    } finally {
      setSendingReview(false);
    }
  };

  return (
    <div className="changes">
      <div className="changes-head">
        <div className="branch">
          <GitBranch size={13} />
          {editingBranch === null ? (
            <button className="branch-name" title="Rename the branch" onClick={() => setEditingBranch(worktree.branch)}>
              <span className="ellipsis">{worktree.branch}</span> <Pencil size={11} />
            </button>
          ) : (
            <input
              className="branch-input"
              autoFocus
              value={editingBranch}
              onChange={(e) => setEditingBranch(e.target.value)}
              onBlur={() => setEditingBranch(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditingBranch(null);
                if (e.key === "Enter" && !composing(e)) {
                  const name = editingBranch.trim();
                  setEditingBranch(null);
                  if (!name || name === worktree.branch) return;
                  act("rename", `Renaming the branch to ${name}…`, async () => {
                    setWorktree(await api.sessionRenameBranch(vault, sessionId, name));
                    return { text: `Renamed the branch to ${name}` };
                  });
                }
              }}
            />
          )}
          <span className="muted">← {worktree.base_branch}</span>
        </div>
        <div className="diffstat">
          <span className="add">+{changes?.additions ?? 0}</span> <span className="del">−{changes?.deletions ?? 0}</span>
        </div>
        <button className="icon" onClick={() => composeDiff(changes?.files.map((f) => f.path) ?? [])} disabled={!changes?.files.length}
          title="Put the whole diff into the message box"><TextCursorInput size={13} /></button>
        <button className="icon" onClick={refresh} title="Refresh"><RefreshCw size={13} /></button>
      </div>
      <div className="open-in">
        <button className="icon" onClick={() => api.openIn(worktree.path, "finder")} title="Reveal in Finder"><FolderOpen size={14} /></button>
        <button className="icon" title="Terminal in the worktree"
          onClick={() => window.dispatchEvent(new CustomEvent("marq:terminal", { detail: { cwd: worktree.path, title: worktree.branch } }))}>
          <TerminalIcon size={14} />
        </button>
        <button className="icon" onClick={() => api.openIn(worktree.path, "vscode")} title="Open in VS Code"><Code2 size={14} /></button>
        <span className="spacer" />
        <button className="icon danger" onClick={remove} disabled={running || busy} title="Remove worktree"><Trash2 size={14} /></button>
      </div>

      {notice && (
        <div className={`banner ${notice.ok ? "ok" : "error"}`} onClick={() => setNotice(null)}>
          {notice.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          <span>{notice.text}</span>
          {notice.url && <a onClick={(e) => { e.stopPropagation(); openUrl(notice.url!); }}>{notice.url}</a>}
        </div>
      )}

      <div className="files">
        {changes?.files.length === 0 && <div className="muted small pad">No changes in the worktree yet.</div>}
        {changes?.files.map((f) => (
          <div key={f.path} className={`file ${isOpen(f.path) ? "open" : ""}`}>
            <div className="file-row">
              <button className="file-head" onClick={() => toggle(f.path)}>
                <ChevronRight size={12} className="chev" />
                <span className={`fstatus s-${f.status === "?" ? "new" : f.status}`} title={STATUS_LABEL[f.status]}>{f.status === "?" ? "A" : f.status}</span>
                <span className="fpath ellipsis">{f.path}</span>
                {comments.some((c) => c.file === f.path) && (
                  <span className="file-comments"><MessageSquareText size={11} /> {comments.filter((c) => c.file === f.path).length}</span>
                )}
                <span className="diffstat small"><span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></span>
              </button>
              <button className="icon file-compose" title="Put this file's diff into the message box" onClick={() => composeDiff([f.path])}>
                <TextCursorInput size={12} />
              </button>
            </div>
            {isOpen(f.path) && (
              <DiffView file={f.path} diff={open[f.path]!} comments={comments.filter((c) => c.file === f.path)}
                onComment={(c) => setComments((cs) => [...cs, { ...c, id: crypto.randomUUID() }])}
                onRemoveComment={(id) => setComments((cs) => cs.filter((c) => c.id !== id))} />
            )}
          </div>
        ))}
      </div>

      {comments.length > 0 && (
        <div className="review-bar">
          <MessageSquareText size={13} />
          <span>{comments.length} comment{comments.length === 1 ? "" : "s"}</span>
          <span className="spacer" />
          <button className="icon" title="Discard all comments" onClick={() => setComments([])}><Trash2 size={13} /></button>
          <button onClick={() => { onCompose(reviewMessage(comments) + "\n\n"); setComments([]); }} title="Put them into the message box to add instructions">
            <TextCursorInput size={13} /> Edit first
          </button>
          <button className="primary" onClick={sendReview} disabled={sendingReview}
            title={running ? "Queued for after this turn" : "Send to this session"}>
            {sendingReview ? <Loader2 size={13} className="spin" /> : <Send size={13} />} Send review
          </button>
        </div>
      )}

      {(changes?.commits.length ?? 0) > 0 && (
        <div className="commits">
          <div className="section-title">Commits</div>
          {changes!.commits.map((c) => (
            <div key={c} className="commit"><GitCommitHorizontal size={12} /> <span className="mono">{c.slice(0, 7)}</span> {c.slice(8)}</div>
          ))}
        </div>
      )}

      <div className="review-actions">
        <Resizer axis="y" sign={-1} pane={commitHeight} />
        <textarea className="commit-message" value={message} onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message (first line is the subject)" style={{ height: commitHeight.size }} />
        {pending ? (
          <div className="push-status small working"><Loader2 size={12} className="spin" /> {pending.label}</div>
        ) : changes && (changes.commits.length > 0 || changes.upstream) && (
          <div className="push-status small">
            {changes.ahead > 0 ? (
              <span><ArrowUp size={12} /> {changes.ahead} commit{changes.ahead === 1 ? "" : "s"} to push
                {changes.upstream ? ` to ${changes.upstream}` : " (not pushed yet)"}</span>
            ) : (
              <span className="muted"><Check size={12} /> Up to date with {changes.upstream}</span>
            )}
          </div>
        )}
        <div className="row">
          <button onClick={commit} disabled={!uncommitted || running || busy}>
            {icon("commit", GitCommitHorizontal)} {pending?.kind === "commit" ? "Committing…" : "Commit"}
          </button>
          <button onClick={push} disabled={running || busy || !changes?.ahead}
            title={changes?.ahead ? `git push -u origin ${worktree.branch}` : "Nothing to push"}>
            {icon("push", ArrowUp)} {pending?.kind === "push" ? "Pushing…" : "Push"}
          </button>
          <button className="primary" onClick={pr} disabled={running || busy || uncommitted || !changes?.commits.length}
            title={uncommitted ? "Commit first, then create a pull request" : ""}>
            {icon("pr", GitPullRequest)} {pending?.kind === "pr" ? "Creating PR…" : "Create PR"}
          </button>
        </div>
      </div>
    </div>
  );
}
