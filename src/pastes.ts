import { useCallback, useMemo, useRef } from "react";

// Pastes this long show as a `[Pasted text #n +k lines]` placeholder, expanded when sent.
const MIN_LINES = 3;
const MIN_CHARS = 800;

export type Pastes = {
  /** The placeholder for `text`, or null when it is short enough to paste as is. */
  collapse: (text: string) => string | null;
  /** `text` with every placeholder replaced by what was pasted. */
  expand: (text: string) => string;
  clear: () => void;
};

const PLACEHOLDER = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g;

/** Pasted text held back from the input box, per box. */
export function usePastes(): Pastes {
  const store = useRef(new Map<number, string>());
  const next = useRef(1);

  const collapse = useCallback((text: string) => {
    const lines = text.split(/\r\n|\r|\n/).length;
    if (lines <= MIN_LINES && text.length < MIN_CHARS) return null;
    const id = next.current++;
    store.current.set(id, text.replace(/\r\n?/g, "\n"));
    return lines > 1 ? `[Pasted text #${id} +${lines} lines]` : `[Pasted text #${id}]`;
  }, []);

  const expand = useCallback(
    (text: string) => text.replace(PLACEHOLDER, (m, id) => store.current.get(Number(id)) ?? m),
    [],
  );

  const clear = useCallback(() => {
    store.current.clear();
    next.current = 1;
  }, []);

  return useMemo(() => ({ collapse, expand, clear }), [collapse, expand, clear]);
}
