/** Keybindings: zellij-style modes, configurable in ~/.marq/config.toml (`[keys]`, `[keys.<mode>]`). */

/** True while an IME is composing, when Enter confirms the conversion rather than submitting. */
export function composing(e: { nativeEvent: KeyboardEvent } | KeyboardEvent): boolean {
  const ev = "nativeEvent" in e ? e.nativeEvent : e;
  return ev.isComposing || ev.keyCode === 229;
}

export type Mode = "normal" | "tab" | "pane" | "locked";

/** Mode -> command id -> keys. */
export type Keymap = Record<Mode, Record<string, string[]>>;

export const DEFAULT_KEYS: Keymap = {
  normal: {
    "mode.tab": ["Ctrl+T"],
    "mode.pane": ["Ctrl+P"],
    "mode.locked": ["Ctrl+G"],
    palette: ["Cmd+K", "Cmd+Shift+P"],
    "file.open": ["Cmd+P"],
    "search.open": ["Cmd+Shift+F"],
    "task.new": ["Cmd+N"],
    "note.new": ["Cmd+Shift+N"],
    "daily.open": ["Cmd+Shift+D"],
    "query.open": ["Cmd+Shift+Q"],
    "terminal.new": ["Cmd+T"],
    "browser.new": ["Cmd+Shift+B"],
    "tab.close": ["Cmd+W"],
    "tab.next": ["Cmd+Shift+]", "Ctrl+Tab"],
    "tab.prev": ["Cmd+Shift+[", "Ctrl+Shift+Tab"],
    "tab.rename": ["Cmd+Shift+R"],
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tab.goto.${n}`, [`Cmd+${n}`]])),
    "tree.focus": ["Cmd+Shift+E"],
    "theme.next": [],
    "vault.switch": [],
    "settings.open": ["Cmd+,"],
  },
  tab: {
    "tab.prev": ["H", "Left", "K", "Up"],
    "tab.next": ["L", "Right", "J", "Down"],
    "terminal.new": ["N"],
    "tab.close": ["X"],
    "tab.rename": ["R"],
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tab.goto.${n}`, [`${n}`]])),
    "mode.normal": ["Escape", "Enter", "Ctrl+T"],
  },
  pane: {
    "tree.focus": ["H", "Left"],
    "content.focus": ["L", "Right"],
    "mode.normal": ["Escape", "Enter", "Ctrl+P"],
  },
  locked: {
    "mode.normal": ["Ctrl+G"],
  },
};

/** Tree navigation while the tree has focus (normal mode). */
export const TREE_KEYS: Record<string, string[]> = {
  "tree.down": ["J", "Down"],
  "tree.up": ["K", "Up"],
  "tree.open": ["L", "Right", "Enter"],
  "tree.close": ["H", "Left"],
  "tree.leave": ["Escape"],
};

const KEY_NAMES: Record<string, string> = {
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
  BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
  Minus: "-", Equal: "=", Semicolon: ";", Quote: "'", Backquote: "`", Space: "Space",
};

/** "Ctrl+Alt+Shift+Cmd+<key>", from the physical key so Option/Shift never change the name. */
export function eventKey(e: KeyboardEvent): string | null {
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return null;
  const c = e.code;
  const name = c.startsWith("Key") ? c.slice(3) : c.startsWith("Digit") ? c.slice(5) : KEY_NAMES[c] ?? KEY_NAMES[e.key] ?? e.key;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Cmd", name].filter(Boolean).join("+");
}

/** Accepts "cmd+shift+t", "Mod+T", "ctrl-t"… and returns the canonical form. */
export function normalize(key: string): string {
  const parts = key.split(/[+-](?=.)/).map((p) => p.trim());
  const last = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.toLowerCase()).map((p) =>
    p === "mod" || p === "meta" || p === "command" || p === "super" ? "cmd" : p === "control" ? "ctrl" : p === "option" || p === "opt" ? "alt" : p));
  const name = last.length === 1 ? last.toUpperCase() : (KEY_NAMES[last] ?? last[0].toUpperCase() + last.slice(1));
  return [mods.has("ctrl") && "Ctrl", mods.has("alt") && "Alt", mods.has("shift") && "Shift", mods.has("cmd") && "Cmd", name]
    .filter(Boolean).join("+");
}

/** Defaults overridden by the config's `[keys]` (normal mode) and `[keys.<mode>]` tables. */
export function mergeKeys(config: unknown): Keymap {
  const map: Keymap = JSON.parse(JSON.stringify(DEFAULT_KEYS));
  const keys = (config as { keys?: Record<string, unknown> } | null)?.keys;
  if (!keys) return map;
  const apply = (mode: Mode, table: Record<string, unknown>) => {
    for (const [cmd, v] of Object.entries(table)) {
      if (typeof v === "string") map[mode][cmd] = v ? [normalize(v)] : [];
      else if (Array.isArray(v)) map[mode][cmd] = v.filter((k) => typeof k === "string").map(normalize);
    }
  };
  const { tab, pane, locked, normal, ...rest } = keys as Record<string, unknown>;
  apply("normal", { ...rest, ...((normal as object) ?? {}) } as Record<string, unknown>);
  for (const [mode, t] of [["tab", tab], ["pane", pane], ["locked", locked]] as const) {
    if (t && typeof t === "object") apply(mode, t as Record<string, unknown>);
  }
  return map;
}

/** The command bound to `key` in `table`. */
export function lookup(table: Record<string, string[]>, key: string): string | undefined {
  return Object.keys(table).find((cmd) => table[cmd].includes(key));
}

/** "⌃⇧T" style for display. */
export function pretty(key: string): string {
  const sym: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘", Left: "←", Right: "→", Up: "↑", Down: "↓", Enter: "↵", Escape: "Esc" };
  return key.split("+").map((p) => sym[p] ?? p).join("");
}
