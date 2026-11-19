import { useCallback, useMemo, useState } from "react";

// Pastes this long are held as a chip above the input instead of going into the text.
const MIN_LINES = 3;
const MIN_CHARS = 800;

export type Paste = { id: number; text: string; lines: number };

export type Pastes = {
  /** The pastes held back, in the order they were pasted; each shows as a chip. */
  items: Paste[];
  /** Holds `text` back as a chip. False when it is short enough to paste as is. */
  add: (text: string) => boolean;
  /** Takes a chip off and returns what it held, e.g. to put it into the text after all. */
  remove: (id: number) => string;
  /** What is sent: `text`, then each held paste as its own block. */
  expand: (text: string) => string;
  clear: () => void;
};

/** Pasted text held back from the input box, per box. */
export function usePastes(): Pastes {
  const [items, setItems] = useState<Paste[]>([]);

  const add = useCallback((text: string) => {
    const lines = text.split(/\r\n|\r|\n/).length;
    if (lines <= MIN_LINES && text.length < MIN_CHARS) return false;
    setItems((prev) => [...prev, { id: (prev[prev.length - 1]?.id ?? 0) + 1, text: text.replace(/\r\n?/g, "\n"), lines }]);
    return true;
  }, []);

  const remove = useCallback(
    (id: number) => {
      setItems((prev) => prev.filter((p) => p.id !== id));
      return items.find((p) => p.id === id)?.text ?? "";
    },
    [items],
  );

  const expand = useCallback((text: string) => [text.trim(), ...items.map((p) => p.text.trim())].filter(Boolean).join("\n\n"), [items]);

  const clear = useCallback(() => setItems([]), []);

  return useMemo(() => ({ items, add, remove, expand, clear }), [items, add, remove, expand, clear]);
}
