import { useMemo, useState } from "react";
import { ClipboardList, FileText, MessageSquare } from "lucide-react";
import { SessionInfo } from "./api";
import { useVaultFiles } from "./wikilinks";
import { workspaceContents, workspaceTitle } from "./workspaces";

/** How many rows of a list show before "Show all". */
const FIRST = 15;

/** A workspace note's side panel: the sessions that ran on it, the requests that name it and their documents. */
export function WorkspacePanel({ path, sessions, onOpenSession, onOpenFile }: {
  path: string; sessions: SessionInfo[]; onOpenSession: (id: string, title: string) => void; onOpenFile: (path: string) => void;
}) {
  const files = useVaultFiles();
  const ws = files.find((f) => f.path === path);
  const contents = useMemo(() => (ws ? workspaceContents(ws, files, sessions) : null), [ws, files, sessions]);
  const [all, setAll] = useState<Record<string, boolean>>({});
  if (!ws || !contents) return null;
  const list = <T,>(key: string, items: T[], row: (x: T) => React.ReactNode) => (
    <>
      {(all[key] ? items : items.slice(0, FIRST)).map(row)}
      {!all[key] && items.length > FIRST && (
        <p className="small"><a onClick={() => setAll({ ...all, [key]: true })}>Show all {items.length}</a></p>
      )}
    </>
  );
  return (
    <>
      <h4><MessageSquare size={11} /> Sessions <span className="count">{contents.sessions.length}</span></h4>
      {contents.sessions.length === 0 && (
        <p className="muted small">No session has run on this workspace yet. Pick it under Workspace in New task.</p>
      )}
      {list("sessions", contents.sessions, (s) => (
        <a key={s.id} className="session-card" onClick={() => onOpenSession(s.id, s.title)}>
          <div className="session-card-title"><span className={`dot ${s.status}`} /> {s.title}</div>
          <div className="muted small">{s.started.slice(0, 16).replace("T", " ")} · {s.status}{s.worktree ? ` · ${s.worktree.branch}` : ""}</div>
        </a>
      ))}
      {contents.requests.length > 0 && <h4><ClipboardList size={11} /> Requests <span className="count">{contents.requests.length}</span></h4>}
      {list("requests", contents.requests, (f) => (
        <div key={f.path} className="link-ref">
          <a onClick={() => onOpenFile(f.path)} title={f.rel}>
            <span className="link-ref-title">{workspaceTitle(f)}</span>
            <span className="muted small">{[f.kind, f.status, f.created?.slice(0, 10)].filter(Boolean).join(" · ")}</span>
          </a>
        </div>
      ))}
      {contents.docs.length > 0 && <h4><FileText size={11} /> Documents <span className="count">{contents.docs.length}</span></h4>}
      {list("docs", contents.docs, (f) => (
        <div key={f.path} className="link-ref">
          <a onClick={() => onOpenFile(f.path)} title={f.rel}><span className="link-ref-title">{workspaceTitle(f)}</span></a>
        </div>
      ))}
    </>
  );
}
