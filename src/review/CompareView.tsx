import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { ChevronRight, ExternalLink, Loader2, Trophy } from "lucide-react";
import { AgentInfo, api, Changes, SessionInfo } from "../api";
import { DiffView } from "./DiffView";
import { useIgnoreWhitespace } from "./diffPrefs";

type Props = {
  vault: string;
  /** The runs to compare, in column order. */
  ids: string[];
  /** Live session list, for status and model. */
  sessions: SessionInfo[];
  onOpenSession: (id: string, title: string) => void;
  onChanged: () => void;
};

const modelLabel = (m?: string | null) => (m ? (m.startsWith("ollama:") ? `${m.slice("ollama:".length)} (Ollama)` : `Claude ${m}`) : "Claude (default)");

/** The same task run on several agents or models, side by side, to pick one and drop the rest. */
export function CompareView({ vault, ids, sessions, onOpenSession, onChanged }: Props) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  useEffect(() => {
    api.listAgents().then(setAgents, () => {});
  }, []);
  // Claude by its model; any other agent by its name, since it runs on its own model.
  const runLabel = (r: SessionInfo) =>
    r.agent && r.agent !== "claude" ? agents.find((a) => a.id === r.agent)?.label ?? r.agent : modelLabel(r.model);
  const runs = useMemo(() => ids.map((id) => sessions.find((s) => s.id === id)).filter((s): s is SessionInfo => !!s), [ids, sessions]);
  const [changes, setChanges] = useState<Record<string, Changes>>({});
  // Expanded diffs, keyed by session and file.
  const [open, setOpen] = useState<Record<string, string | null>>({});
  const [ignoreWs] = useIgnoreWhitespace();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const busy = runs.some((r) => r.status === "running" || r.status === "waiting");
  // Reload when a run changes state, not on every render of the session list.
  const statuses = runs.map((r) => `${r.id}:${r.status}`).join(",");

  const load = useCallback(async () => {
    const entries = await Promise.all(
      ids.map(async (id) => [id, await api.sessionChanges(vault, id).catch(() => null)] as const),
    );
    setChanges(Object.fromEntries(entries.filter((e): e is readonly [string, Changes] => e[1] !== null)));
  }, [vault, ids]);

  useEffect(() => {
    load();
  }, [load, statuses]);

  useEffect(() => {
    const uns = ["session://turn", "session://exit"].map((ev) =>
      listen<{ session_id: string }>(ev, (e) => ids.includes(e.payload.session_id) && load()),
    );
    return () => uns.forEach((u) => u.then((f) => f()));
  }, [ids, load]);

  // Expanded diffs follow the whitespace choice.
  const openRef = useRef(open);
  useLayoutEffect(() => {
    openRef.current = open;
  });
  useEffect(() => {
    let stale = false;
    const keys = Object.keys(openRef.current).filter((k) => openRef.current[k] != null);
    Promise.all(keys.map(async (k) => {
      const [id, file] = k.split("\n");
      return [k, await api.sessionFileDiff(vault, id, file, undefined, ignoreWs).catch(() => null)] as const;
    })).then((entries) => {
      if (stale) return;
      const fresh = entries.filter((e): e is readonly [string, string] => e[1] !== null);
      setOpen((o) => ({ ...o, ...Object.fromEntries(fresh.filter(([k]) => o[k] != null)) }));
    });
    return () => {
      stale = true;
    };
  }, [ignoreWs, vault]);

  const toggle = async (id: string, file: string) => {
    const key = `${id}\n${file}`;
    if (open[key] != null) return setOpen((o) => ({ ...o, [key]: null }));
    try {
      const diff = await api.sessionFileDiff(vault, id, file, undefined, ignoreWs);
      setOpen((o) => ({ ...o, [key]: diff }));
    } catch (e) {
      setNotice({ ok: false, text: String(e) });
    }
  };

  const keep = async (winner: SessionInfo) => {
    const others = runs.filter((r) => r.id !== winner.id && r.worktree);
    const ok = await ask(
      `Keep ${runLabel(winner)} and remove the worktrees of the other ${others.length} run${others.length === 1 ? "" : "s"}?\n\n` +
        "Their branches and session logs are kept.",
      { title: "Keep this result", kind: "warning", okLabel: "Keep" },
    );
    if (!ok) return;
    setPending(true);
    try {
      await Promise.all(others.map((r) => api.sessionRemoveWorktree(vault, r.id)));
      // A database or the like made for a run that was not kept goes with its worktree.
      const failed = (await Promise.all(others.map((r) => api.sessionReleaseResources(vault, r.id).catch((e) => [String(e)])))).flat();
      if (failed.length) {
        await message(`The other runs' worktrees were removed, but some of their resources were not dropped:\n\n${failed.join("\n")}`, { title: "Resources", kind: "warning" });
      }
      onChanged();
      onOpenSession(winner.id, winner.title);
    } catch (e) {
      setNotice({ ok: false, text: String(e) });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="compare">
      <div className="compare-head">
        <span className="muted small">
          {busy ? "Runs are still working. Choose one when they have all finished." : "Open a file to see its diff, then keep the run you prefer."}
        </span>
        {notice && <span className={`compare-notice ${notice.ok ? "ok" : "error"}`} onClick={() => setNotice(null)}>{notice.text}</span>}
      </div>
      <div className="compare-cols">
        {runs.map((r) => {
          const c = changes[r.id];
          return (
            <section key={r.id} className="compare-col">
              <header>
                <div className="compare-title">
                  <strong>{runLabel(r)}</strong>
                  <span className={`pill status-${r.status}`}>{r.status}</span>
                </div>
                <div className="muted small">
                  {r.worktree?.branch}
                  {c && <> · <span className="diffstat small"><span className="add">+{c.additions}</span> <span className="del">−{c.deletions}</span></span></>}
                </div>
                <div className="row">
                  <button onClick={() => onOpenSession(r.id, r.title)}><ExternalLink size={13} /> Open session</button>
                  <button className="primary" onClick={() => keep(r)} disabled={busy || pending || !r.worktree}
                    title={busy ? "Wait until every run has finished" : "Keep this result and remove the other worktrees"}>
                    {pending ? <Loader2 size={13} className="spin" /> : <Trophy size={13} />} Keep this one
                  </button>
                </div>
              </header>
              <div className="files">
                {!c && <div className="muted small pad">{r.worktree ? "Loading…" : "The worktree was removed."}</div>}
                {c?.files.length === 0 && <div className="muted small pad">No changes yet.</div>}
                {c?.files.map((f) => {
                  const diff = open[`${r.id}\n${f.path}`];
                  return (
                    <div key={f.path} className={`file ${diff != null ? "open" : ""}`}>
                      <button className="file-head" onClick={() => toggle(r.id, f.path)}>
                        <ChevronRight size={12} className="chev" />
                        <span className={`fstatus s-${f.status === "?" ? "new" : f.status}`}>{f.status === "?" ? "A" : f.status}</span>
                        <span className="fpath ellipsis">{f.path}</span>
                        <span className="diffstat small"><span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></span>
                      </button>
                      {diff != null && <DiffView file={f.path} diff={diff} />}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
