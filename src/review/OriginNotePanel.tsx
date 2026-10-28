import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ExternalLink } from "lucide-react";
import { AskDialog, AskOptions } from "../AskDialog";
import { api, SessionInfo } from "../api";
import { Preview } from "../markdown/Preview";

type Props = {
  vault: string;
  sessionId: string;
  onOpenNote: (path: string, line: number) => void;
  onOpenSession: (id: string, title: string) => void;
};

/** The note a session came from, shown next to the chat. mq blocks in it run here too. */
export function OriginNotePanel({ vault, sessionId, onOpenNote, onOpenSession }: Props) {
  const [origin, setOrigin] = useState<{ path: string; line: number } | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  const [ask, setAsk] = useState<{ line: number; options: boolean } | null>(null);
  const load = useCallback(async () => {
    const o = await api.sessionOrigin(vault, sessionId);
    setOrigin(o);
    if (!o) return;
    setText(await api.readNote(vault, o.path));
    setSessions(await api.listSessions(vault));
  }, [vault, sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const un = listen<{ path: string }>("vault://changed", (e) => origin && e.payload.path === origin.path && load());
    return () => {
      un.then((f) => f());
    };
  }, [origin, load]);

  const run = async (line: number, options: AskOptions) => {
    const started = await api.runFromNote(vault, origin!.path, line, options);
    onOpenSession(started.session_id, text?.split("\n")[line]?.replace(/^#+\s*/, "") || "session");
  };

  if (!origin) return <div className="muted small pad">The origin note was not found.</div>;
  if (text === null) return null;

  return (
    <div className="origin-note">
      <div className="origin-head">
        <span className="ellipsis mono small">{origin.path.replace(vault + "/", "")}</span>
        <button className="icon" onClick={() => onOpenNote(origin.path, origin.line)} title="Open in a tab">
          <ExternalLink size={13} />
        </button>
      </div>
      <Preview
        vault={vault}
        path={origin.path}
        text={text}
        sessions={sessions}
        onRunAt={(line, withOptions) => setAsk({ line, options: !!withOptions })}
        onEditAt={(line) => onOpenNote(origin.path, line)}
        onOpenSession={onOpenSession}
        onPinned={setText}
      />
      {ask && (
        <AskDialog vault={vault} note={text} showOptions={ask.options} onClose={() => setAsk(null)} onRun={(o) => run(ask.line, o)} />
      )}
    </div>
  );
}
