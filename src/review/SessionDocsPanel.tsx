import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { FileOutput } from "lucide-react";
import { api, CrewDoc } from "../api";

type Props = {
  vault: string;
  sessionId: string;
  onOpenNote: (path: string, line: number) => void;
  /** Called with the number of documents whenever the list loads, for the tab's count. */
  onCount?: (n: number) => void;
};

/** The documents a session's task wrote with `write_doc`, beside the chat. Each opens in its own tab. */
export function SessionDocsPanel({ vault, sessionId, onOpenNote, onCount }: Props) {
  const [docs, setDocs] = useState<CrewDoc[]>([]);

  const load = useCallback(async () => {
    const list = await api.sessionDocs(vault, sessionId).catch(() => []);
    setDocs(list);
    onCount?.(list.length);
  }, [vault, sessionId, onCount]);

  useEffect(() => {
    load();
    const uns = [
      listen("vault://changed", () => load()),
      listen<{ session_id: string; event: { type?: string } }>("session://event",
        (e) => e.payload.session_id === sessionId && e.payload.event?.type === "marq_doc" && load()),
    ];
    return () => {
      uns.forEach((u) => u.then((f) => f()));
    };
  }, [load, sessionId]);

  return (
    <div className="session-docs">
      {docs.length === 0 && (
        <p className="muted small">Designs, plans and reports this task saves with <code>write_doc</code> show up here, from every run of the same request.</p>
      )}
      {docs.map((d) => (
        <a key={d.path} className="doc-card" onClick={() => onOpenNote(d.path, 0)} title={`Open ${d.rel} in a tab`}>
          <FileOutput size={18} />
          <span className="doc-card-body">
            <span className="doc-card-title">{d.title ?? d.rel}</span>
            <span className="muted small mono ellipsis">{d.rel}</span>
          </span>
        </a>
      ))}
    </div>
  );
}
