import { useSyncExternalStore } from "react";

const KEY = "marq.diff.ignoreWhitespace";

const read = () => {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
};

let current = read();
const listeners = new Set<() => void>();

/** Whether diffs hide lines that differ only in whitespace. One choice for every diff in the app, kept across restarts. */
export function useIgnoreWhitespace(): [boolean, (v: boolean) => void] {
  const value = useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => current);
  const set = (v: boolean) => {
    current = v;
    try {
      localStorage.setItem(KEY, String(v));
    } catch {
      // The choice still holds until the app closes.
    }
    listeners.forEach((l) => l());
  };
  return [value, set];
}
