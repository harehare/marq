import { useSyncExternalStore } from "react";

/** The parts of ~/.marq/config.toml the webview uses. */
export type Settings = {
  appearance?: {
    font?: string; mono_font?: string; font_size?: number; editor_font_size?: number; palette?: string; mode?: string;
    content_width?: ContentWidth;
    /** `rail`: only icons show; one opens its list over the content. */
    sidebar?: "full" | "rail";
  };
  editor?: { default_mode?: "preview" | "edit" | "split"; autosave?: boolean; vim?: boolean };
  notifications?: { enabled?: boolean };
  worktree?: { dir?: string; default?: boolean; base?: "head" | "latest" };
  inbox?: { parallel?: number };
  chat?: { send?: SendKey };
  tabs?: { pinned_layout?: "inline" | "row"; overflow?: "scroll" | "wrap" };
  terminal?: { font?: string; font_size?: number; ligatures?: boolean; cursor?: "block" | "bar" | "underline" };
  /** Frontmatter keys of the user's own to search, filter and group by. */
  organize?: { keys?: string[] };
};

/** Names the search filters already use; a key of the user's own cannot be one of them. */
const RESERVED_KEYS = ["type", "kind", "status", "project", "workspace", "ws", "since", "after", "before", "tag", "tags"];

/** `[organize] keys` as the app uses them: lowercase words, not a built-in filter, each once. */
export function organizeKeys(s: Settings): string[] {
  const keys = (s.organize?.keys ?? []).map((k) => String(k).trim().toLowerCase())
    .filter((k) => /^[\p{L}\p{N}_-]+$/u.test(k) && !RESERVED_KEYS.includes(k));
  return [...new Set(keys)];
}

/** Which key sends a message in a conversation; the others add a line. ⌘↵ sends in every mode. */
export type SendKey = "mod-enter" | "enter" | "shift-enter";

/** True when this key press sends the message. Callers `preventDefault()` when it does. */
export function isSendKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; nativeEvent: KeyboardEvent }, mode: SendKey | undefined): boolean {
  // Enter that confirms an IME conversion (Japanese input) is not a send.
  if (e.key !== "Enter" || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return false;
  if (e.metaKey || e.ctrlKey) return true;
  if (e.altKey) return false;
  if (mode === "enter") return !e.shiftKey;
  if (mode === "shift-enter") return e.shiftKey;
  return false;
}

/** The send key as shown in hints. */
export const sendHint = (mode: SendKey | undefined) => (mode === "enter" ? "↵" : mode === "shift-enter" ? "⇧↵" : "⌘↵");

/** How wide notes and conversations are. */
export type ContentWidth = "normal" | "wide" | "full";
export const CONTENT_WIDTHS: { value: ContentWidth; label: string; css: string }[] = [
  { value: "normal", label: "Normal", css: "780px" },
  { value: "wide", label: "Wide", css: "1040px" },
  { value: "full", label: "Full width", css: "100%" },
];

let current: Settings = {};
const listeners = new Set<() => void>();

export function getSettings() {
  return current;
}

export function setSettings(s: Settings) {
  current = s;
  applyAppearance(s);
  listeners.forEach((l) => l());
}

export function useSettings() {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), getSettings);
}

export const quote = (f: string) => (/[\s,"]/.test(f) && !f.includes(",") ? `"${f}"` : f);

/** Fonts and sizes as CSS variables; unset ones fall back to App.css. */
function applyAppearance(s: Settings) {
  const a = s.appearance ?? {};
  const root = document.documentElement.style;
  const set = (name: string, v: string | undefined) => (v ? root.setProperty(name, v) : root.removeProperty(name));
  set("--font", a.font ? `${quote(a.font)}, -apple-system, BlinkMacSystemFont, sans-serif` : undefined);
  set("--font-mono", a.mono_font ? `${quote(a.mono_font)}, ui-monospace, Menlo, monospace` : undefined);
  set("--font-size", a.font_size ? `${a.font_size}px` : undefined);
  set("--editor-font-size", a.editor_font_size ? `${a.editor_font_size}px` : undefined);
  set("--content-width", CONTENT_WIDTHS.find((w) => w.value === a.content_width)?.css);
}
