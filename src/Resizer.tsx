import { useCallback, useRef, useState } from "react";

function stored(key: string): number | null {
  try {
    const v = Number(localStorage.getItem(`marq.size.${key}`));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
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
  const [size, setSize] = useState(() => Math.min(max, Math.max(min, stored(key) ?? initial)));
  // Whether the user has set the size (dragged or reset), rather than it being the default.
  const [touched, setTouched] = useState(() => stored(key) !== null);
  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);
  const set = useCallback(
    (v: number) => {
      const clamped = clamp(v);
      setSize(clamped);
      // Set while dragging too, so the pane follows the pointer before the size is saved.
      setTouched(true);
      return clamped;
    },
    [clamp],
  );
  return {
    size, set, clamp, initial, touched,
    persist: (v: number) => {
      save(key, v);
      setTouched(true);
    },
  };
}

type Props = {
  /** Which way the handle moves. */
  axis: "x" | "y";
  /** +1 when dragging right/down grows the pane, -1 when it shrinks it. */
  sign: 1 | -1;
  pane: ReturnType<typeof usePaneSize>;
  /** Pixels per unit of size, for ratios (e.g. the container width). Defaults to 1. */
  scale?: () => number;
  /** The size as drawn, when it can be smaller than `pane.size` (a cap on content that is shorter). */
  measure?: () => number;
  /**
   * Draws a size while dragging, straight on the element, so a large parent does not re-render on every move;
   * the size is set once, on release. Without it the pane's size is set on each frame.
   */
  preview?: (size: number) => void;
};

/** A drag handle between two panes. Double-click resets the size. */
export function Resizer({ axis, sign, pane, scale, measure, preview }: Props) {
  const start = useRef<{ pos: number; size: number } | null>(null);
  const [active, setActive] = useState(false);
  // At most one update per frame, however fast the pointer events come.
  const frame = useRef(0);
  const latest = useRef(0);
  const sizeAt = (e: { clientX: number; clientY: number }) =>
    start.current!.size + (((axis === "x" ? e.clientX : e.clientY) - start.current!.pos) * sign) / (scale?.() ?? 1);

  return (
    <div
      className={`resizer ${axis} ${active ? "active" : ""}`}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { pos: axis === "x" ? e.clientX : e.clientY, size: measure?.() ?? pane.size };
        setActive(true);
        document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        latest.current = sizeAt(e);
        if (frame.current) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = 0;
          if (!start.current) return;
          if (preview) preview(pane.clamp(latest.current));
          else pane.set(latest.current);
        });
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        const v = pane.set(sizeAt(e));
        // The last frame may have been dropped; draw the final size too, in case React sees nothing to change.
        preview?.(v);
        pane.persist(v);
        start.current = null;
        setActive(false);
        document.body.classList.remove("resizing-x", "resizing-y");
      }}
      onDoubleClick={() => pane.persist(pane.set(pane.initial))}
    />
  );
}
