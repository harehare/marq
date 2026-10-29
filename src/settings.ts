import { useSyncExternalStore } from "react";

/** The parts of ~/.marq/config.toml the webview uses. */
export type Settings = {
  appearance?: {
    font?: string; mono_font?: string; font_size?: number; editor_font_size?: number; palette?: string; mode?: string;
    content_width?: ContentWidth;
  };
  editor?: { default_mode?: "preview" | "edit" | "split"; autosave?: boolean };
  notifications?: { enabled?: boolean };
  terminal?: { font?: string; font_size?: number; ligatures?: boolean; cursor?: "block" | "bar" | "underline" };
};

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
