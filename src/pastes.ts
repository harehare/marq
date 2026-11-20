import { useCallback, useMemo, useRef, useState } from "react";

// Pastes this long are held back and put into the text as a short placeholder, at the cursor, so they keep their place;
// the placeholders are swapped for the full text on send.
const MIN_LINES = 3;
const MIN_CHARS = 800;

export type Paste = { id: number; text: string; lines: number };

export type Pastes = {
  /** The pastes held back, in the order they were pasted. */
  items: Paste[];
  /** Holds `text` back and returns the placeholder to insert. Null when it is short enough to paste as is. */
  add: (text: string) => string | null;
  /** What is sent: `text` with each placeholder replaced by the paste it stands for. */
  expand: (text: string) => string;
  clear: () => void;
};

const PLACEHOLDER = /\[Pasted text #(\d+)[^\]]*\]/g;
const placeholder = (id: number, lines: number, chars: number) =>
  `[Pasted text #${id} ${lines > 1 ? `+${lines} lines` : `${chars} chars`}]`;

/** Pasted text held back from the input box, per box. */
export function usePastes(): Pastes {
  const [items, setItems] = useState<Paste[]>([]);

  const next = useRef(1);

  const add = useCallback((text: string) => {
    const lines = text.split(/\r\n|\r|\n/).length;
    if (lines <= MIN_LINES && text.length < MIN_CHARS) return null;
    const id = next.current++;
    setItems((prev) => [...prev, { id, text: text.replace(/\r\n?/g, "\n"), lines }]);
    return placeholder(id, lines, text.length);
  }, []);

  const expand = useCallback(
    (text: string) => {
      // A placeholder deleted from the text drops its paste too.
      const full = text.replace(PLACEHOLDER, (m, id) => items.find((p) => p.id === Number(id))?.text.trim() ?? m);
      return full.trim();
    },
    [items],
  );

  const clear = useCallback(() => setItems([]), []);

  return useMemo(() => ({ items, add, expand, clear }), [items, add, expand, clear]);
}
