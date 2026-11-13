import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

type Hidden = { left: string[]; right: string[] };
const NONE: Hidden = { left: [], right: [] };

/**
 * A row of tabs. With `wrap` they flow onto more rows; otherwise they scroll sideways, and each end
 * shows how many tabs are out of sight there. Clicking the count lists them (`onShowHidden`).
 * Tabs are found by their `data-key`.
 */
export function TabStrip({ className, lead, trail, wrap, active, onShowHidden, onBlankDoubleClick, children }: {
  className?: string;
  /** Shown before the tabs, outside the scrolling part. */
  lead?: React.ReactNode;
  /** Shown after the tabs, at the end of the bar. */
  trail?: React.ReactNode;
  wrap: boolean;
  active: string | null;
  onShowHidden: (keys: string[], x: number, y: number) => void;
  /** A double-click on the bar's empty space, not on a tab or button. */
  onBlankDoubleClick?: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Hidden>(NONE);

  const measure = () => {
    const el = ref.current;
    if (!el || wrap) return setHidden(NONE);
    const from = el.scrollLeft, to = from + el.clientWidth;
    const next: Hidden = { left: [], right: [] };
    for (const t of el.querySelectorAll<HTMLElement>(":scope > [data-key]")) {
      // A tab more than half cut off counts as hidden.
      const mid = t.offsetLeft + t.offsetWidth / 2;
      if (mid < from) next.left.push(t.dataset.key!);
      else if (mid > to) next.right.push(t.dataset.key!);
    }
    setHidden((prev) => (prev.left.join() === next.left.join() && prev.right.join() === next.right.join() ? prev : next));
  };

  const latest = useRef(measure);
  useLayoutEffect(() => {
    latest.current = measure;
    measure();
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => latest.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The tab shown is kept in sight.
  useEffect(() => {
    if (wrap) return;
    ref.current?.querySelector<HTMLElement>(":scope > .tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, wrap]);

  const more = (side: "left" | "right") => {
    const keys = hidden[side];
    if (!keys.length) return null;
    return (
      <button className={`tabs-more ${side}`} title={`${keys.length} more tab${keys.length > 1 ? "s" : ""}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onShowHidden(side === "left" ? keys.slice().reverse() : keys, side === "left" ? r.left : r.right, r.bottom + 4);
        }}>
        {side === "left" && <ChevronLeft size={13} />}
        {keys.length}
        {side === "right" && <ChevronRight size={13} />}
      </button>
    );
  };

  const blank = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onBlankDoubleClick?.();
  };

  return (
    <nav className={`tabs ${wrap ? "wrap" : ""} ${className ?? ""}`} onDoubleClick={blank}>
      {lead}
      {more("left")}
      <div ref={ref} className={`tabs-scroll ${hidden.left.length ? "fade-l" : ""} ${hidden.right.length ? "fade-r" : ""}`}
        onScroll={measure}
        onDoubleClick={blank}
        // A plain mouse wheel scrolls the tabs sideways.
        onWheel={(e) => { if (!wrap && e.deltaX === 0 && ref.current) ref.current.scrollLeft += e.deltaY; }}>
        {children}
      </div>
      {more("right")}
      {trail}
    </nav>
  );
}
