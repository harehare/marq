import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Keeps a scroll container at its end: when it mounts, when `deps` change, and while its content
 * grows (Markdown and code render after the first layout), unless the user has scrolled up.
 * Returns a callback ref for the container.
 */
/** Outside the hook: React Compiler treats the element held in state as read-only. */
function toEnd(el: HTMLElement) {
  el.scrollTop = el.scrollHeight;
}

export function useStickToBottom<T extends HTMLElement>(deps: unknown[]) {
  const [el, setEl] = useState<T | null>(null);
  const stuck = useRef(true);

  useLayoutEffect(() => {
    if (!el) return;
    stuck.current = true;
    toEnd(el);
    const onScroll = () => { stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => stuck.current && toEnd(el));
    Array.from(el.children).forEach((c) => ro.observe(c));
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [el]);

  useLayoutEffect(() => {
    if (!el) return;
    stuck.current = true;
    toEnd(el);
  }, [el, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  return useCallback((node: T | null) => setEl(node), []);
}
