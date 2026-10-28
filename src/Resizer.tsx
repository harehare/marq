import { useCallback, useRef, useState } from "react";

function load(key: string, fallback: number) {
  try {
    const v = Number(localStorage.getItem(`marq.size.${key}`));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: number) {
  try {
    localStorage.setItem(`marq.size.${key}`, String(Math.round(value)));
  } catch {}
}

/**
 * A remembered size for a pane, in pixels (or a 0-1 ratio). `edge` says which side of the pane the
 * handle sits on, so dragging toward the pane shrinks it.
 */
export function usePaneSize(key: string, initial: number, min: number, max: number) {
  const [size, setSize] = useState(() => Math.min(max, Math.max(min, load(key, initial))));
  const set = useCallback(
    (v: number) => {
      const clamped = Math.min(max, Math.max(min, v));
      setSize(clamped);
      return clamped;
    },
    [min, max],
  );
  return { size, set, initial, persist: (v: number) => save(key, v) };
}

type Props = {
  /** Which way the handle moves. */
  axis: "x" | "y";
  /** +1 when dragging right/down grows the pane, -1 when it shrinks it. */
  sign: 1 | -1;
  pane: ReturnType<typeof usePaneSize>;
  /** Pixels per unit of size, for ratios (e.g. the container width). Defaults to 1. */
  scale?: () => number;
};

/** A drag handle between two panes. Double-click resets the size. */
export function Resizer({ axis, sign, pane, scale }: Props) {
  const start = useRef<{ pos: number; size: number } | null>(null);
  const [active, setActive] = useState(false);

  return (
    <div
      className={`resizer ${axis} ${active ? "active" : ""}`}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { pos: axis === "x" ? e.clientX : e.clientY, size: pane.size };
        setActive(true);
        document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const delta = ((axis === "x" ? e.clientX : e.clientY) - start.current.pos) * sign;
        pane.set(start.current.size + delta / (scale?.() ?? 1));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const delta = ((axis === "x" ? e.clientX : e.clientY) - start.current.pos) * sign;
        pane.persist(pane.set(start.current.size + delta / (scale?.() ?? 1)));
        start.current = null;
        setActive(false);
        document.body.classList.remove("resizing-x", "resizing-y");
      }}
      onDoubleClick={() => pane.persist(pane.set(pane.initial))}
    />
  );
}
