import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2, Trash2, X } from "lucide-react";
import { api, SessionInfo } from "./api";

type Props = { vault: string; session: SessionInfo; onDeleted: () => void; onClose: () => void };

/** Confirms deleting a session, and whether its worktree and branch go too. */
export function DeleteSessionDialog({ vault, session, onDeleted, onClose }: Props) {
  const wt = session.worktree;
  const [removeWorktree, setRemoveWorktree] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);

  useEffect(() => {
    const un = listen<string>("task://progress", (e) => setStage(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);
  const changed = (session.additions ?? 0) + (session.deletions ?? 0) > 0;

  const run = async () => {
    setBusy(true);
    try {
      await api.deleteSession(vault, session.id, removeWorktree || deleteBranch, deleteBranch);
      onDeleted();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
      setStage(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal small" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="modal-head">
          <h3><Trash2 size={16} /> Delete session</h3>
          <button className="icon" onClick={onClose}><X size={15} /></button>
        </div>
        <p className="delete-title">{session.title}</p>
        <ul className="delete-list muted small">
          {session.status === "running" || session.status === "waiting" ? <li>The running session is stopped first.</li> : null}
          <li>The session log and note move to the Trash.</li>
          <li>Its result block is removed from <span className="mono">{session.origin_path}</span>.</li>
        </ul>
        {wt && (
          <>
            <label className="check">
              <input type="checkbox" checked={removeWorktree || deleteBranch} disabled={deleteBranch}
                onChange={(e) => setRemoveWorktree(e.target.checked)} />
              Remove the worktree <span className="mono small muted">{wt.path.replace(/^\/Users\/[^/]+/, "~")}</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
              Delete the branch <span className="mono small">{wt.branch}</span>
            </label>
            {deleteBranch && changed && (
              <div className="banner error">This branch has changes. Deleting it discards them, including commits that were not pushed.</div>
            )}
          </>
        )}
        {error && <div className="banner error">{error}</div>}
        <div className="modal-foot">
          {busy ? (
            <span className="stage small"><Loader2 size={13} className="spin" /> {stage ?? "Deleting…"}</span>
          ) : (
            <button onClick={onClose}>Cancel</button>
          )}
          <button className="primary danger-fill" onClick={run} disabled={busy}><Trash2 size={14} /> Delete</button>
        </div>
      </div>
    </div>
  );
}
