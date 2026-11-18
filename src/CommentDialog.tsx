import { useRef, useState } from "react";
import { MessageSquarePlus, Sparkles, X } from "lucide-react";
import { composing } from "./keys";
import { useAutoGrow } from "./useAutoGrow";
import { hasMention } from "./comments";

/** Write a comment to leave in the note. Mentioning @marq asks an agent to act on it as soon as it is added. */
export function CommentDialog({ about, onAdd, onClose }: {
  /** The text the comment is about, shown above the box. */
  about?: string;
  onAdd: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, text, 240);
  const asks = hasMention(text);

  const add = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      await onAdd(text.trim());
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal ask" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="modal-head">
          <h3><MessageSquarePlus size={16} /> Comment</h3>
          <button className="icon" onClick={onClose}><X size={15} /></button>
        </div>
        {about && <blockquote className="ask-excerpt">{about.length > 400 ? `${about.slice(0, 400)}…` : about}</blockquote>}
        <textarea ref={ref} autoFocus className="ask-input" value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Write a comment. Add @marq to ask an agent right away  (⌘↵ to add)"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !composing(e)) {
              e.preventDefault();
              add();
            }
          }} />
        <p className="muted small">
          {asks ? "An agent starts on this as soon as you add it." : "Saved in the note. Ask an agent later with “Ask marq”, or mention @marq to do it now."}
        </p>
        {error && <div className="banner error">{error}</div>}
        <div className="modal-foot">
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !text.trim()} onClick={add}>
            {asks ? <><Sparkles size={13} /> Add and ask</> : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
