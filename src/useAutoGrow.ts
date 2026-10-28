import { RefObject, useLayoutEffect } from "react";

/** Sizes a textarea to its text, from its CSS min-height up to `max`; past that it scrolls. */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, max: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(max, el.scrollHeight)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [ref, value, max]);
}
