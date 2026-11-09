import { RefObject, useEffect } from "react";
import { composing } from "./keys";

/**
 * Keeps a palette (⌘K, ⌘P) usable after its input loses focus, from a click on the list or a trip
 * to another window: Esc closes it from anywhere, and any other key goes back to the input first.
 */
export function usePaletteKeys(input: RefObject<HTMLInputElement | null>, onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (composing(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (input.current && document.activeElement !== input.current) {
        // Before the key lands, so typing and ↑↓↵ reach the input.
        input.current.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [input, onClose]);
}
