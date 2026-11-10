import { RefObject, useEffect, useState } from "react";
import { MessageSquare, Send, Sparkles } from "lucide-react";

type Props = {
  /** Only selections inside this element count. */
  container: RefObject<HTMLElement | null>;
  onSend: (text: string) => void;
  /** Ask the agent about the selection. */
  onAsk?: (text: string) => void;
  /** Send the selection to one session in particular, such as the one that wrote the document. */
  toSession?: { title: string; onSend: (text: string) => void };
};

/** A small "Send to session" button that follows a text selection inside `container`. */
export function SelectionPopover({ container, onSend, onAsk, toSession }: Props) {
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    const check = () => {
      const sel = window.getSelection();
      const el = container.current;
      const text = sel?.toString().trim() ?? "";
      if (!sel || sel.rangeCount === 0 || !el || !text || !el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) {
        setAt(null);
        return;
      }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setAt({ x: Math.min(r.right, window.innerWidth - 320), y: Math.max(r.top - 36, 8), text });
    };
    const up = () => setTimeout(check, 0);
    const hide = () => setAt(null);
    document.addEventListener("mouseup", up);
    document.addEventListener("keyup", up);
    window.addEventListener("resize", hide);
    const el = container.current;
    el?.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("mouseup", up);
      document.removeEventListener("keyup", up);
      window.removeEventListener("resize", hide);
      el?.removeEventListener("scroll", hide, true);
    };
  }, [container]);

  if (!at) return null;
  return (
    // Keep the selection: a mousedown here would otherwise clear it before the click.
    <div className="selection-popover" style={{ left: at.x, top: at.y }} onMouseDown={(e) => e.preventDefault()}>
      {onAsk && (
        <button onClick={() => { onAsk(at.text); setAt(null); }}><Sparkles size={13} /> Ask</button>
      )}
      {toSession && (
        <button title={`Ask ${toSession.title} about the selection`} onClick={() => { toSession.onSend(at.text); setAt(null); }}>
          <MessageSquare size={13} /> Ask its session
        </button>
      )}
      <button onClick={() => { onSend(at.text); setAt(null); }}><Send size={13} /> Send to session</button>
    </div>
  );
}
