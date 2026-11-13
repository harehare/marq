import { Keymap, Mode, pretty } from "./keys";

/** Hints shown per mode: command id and a short label. */
const HINTS: Record<Mode, [string, string][]> = {
  normal: [["mode.tab", "Tab"], ["mode.pane", "Pane"], ["mode.locked", "Lock"], ["palette", "Commands"]],
  tab: [["tab.prev", "Prev"], ["tab.next", "Next"], ["tab.goto.1", "Go to"], ["terminal.new", "New"], ["tab.close", "Close"], ["tab.rename", "Rename"], ["mode.normal", "Done"]],
  pane: [["tree.focus", "Tree"], ["content.focus", "Content"], ["mode.normal", "Done"]],
  locked: [["mode.normal", "Unlock"]],
};

const TREE_HINTS: [string, string][] = [["J/K", "Move"], ["L/↵", "Open"], ["H", "Close"], ["Esc", "Leave"]];

/** In a terminal only ⌘ keys reach the app, so these replace the mode keys. */
const TERMINAL_HINTS: [string, string][] = [["tab.prev", "Prev"], ["tab.next", "Next"], ["terminal.new", "New"], ["terminal.splitRight", "Split"], ["terminal.splitDown", "Split ↓"], ["tab.close", "Close"], ["tree.focus", "Tree"], ["palette", "Commands"]];

/** zellij-style bar: the current mode and the keys that do something in it. */
export function StatusBar({ mode, keymap, treeFocus, termFocus, running, waiting, onActive }: {
  mode: Mode; keymap: Keymap; treeFocus: boolean; termFocus: boolean;
  /** Sessions in a turn, and sessions waiting for an approval. */
  running: number; waiting: number;
  /** Opens the next of those sessions. */
  onActive: () => void;
}) {
  const terminal = termFocus && mode === "normal";
  const hints = (terminal ? TERMINAL_HINTS : HINTS[mode])
    .map(([cmd, label]) => {
      const keys = (mode === "normal" ? keymap.normal[cmd] : keymap[mode][cmd])?.filter((k) => !terminal || k.includes("Cmd"));
      if (!keys?.length) return null;
      return [cmd === "tab.goto.1" ? "1-9" : pretty(keys[0]), label] as const;
    })
    .filter((h): h is readonly [string, string] => h !== null);
  return (
    <footer className={`status-bar mode-${mode}`}>
      <span className="status-mode" title={terminal ? "Keys without ⌘ go to the terminal" : undefined}>
        {treeFocus && mode === "normal" ? "TREE" : terminal ? "TERMINAL" : mode.toUpperCase()}
      </span>
      {(treeFocus && mode === "normal" ? TREE_HINTS : hints).map(([k, label]) => (
        <span key={label} className="status-hint"><kbd>{k}</kbd> {label}</span>
      ))}
      {running + waiting > 0 && (
        <button className={`status-active ${waiting ? "waiting" : ""}`} onClick={onActive} title="Open the next running or waiting session">
          {running > 0 && <span><span className="dot running" /> {running} running</span>}
          {waiting > 0 && <span><span className="dot waiting" /> {waiting} need{waiting === 1 ? "s" : ""} you</span>}
        </button>
      )}
    </footer>
  );
}
