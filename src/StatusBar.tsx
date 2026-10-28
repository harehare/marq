import { Keymap, Mode, pretty } from "./keys";

/** Hints shown per mode: command id and a short label. */
const HINTS: Record<Mode, [string, string][]> = {
  normal: [["mode.tab", "Tab"], ["mode.pane", "Pane"], ["mode.locked", "Lock"], ["palette", "Commands"]],
  tab: [["tab.prev", "Prev"], ["tab.next", "Next"], ["tab.goto.1", "Go to"], ["terminal.new", "New"], ["tab.close", "Close"], ["tab.rename", "Rename"], ["mode.normal", "Done"]],
  pane: [["tree.focus", "Tree"], ["content.focus", "Content"], ["mode.normal", "Done"]],
  locked: [["mode.normal", "Unlock"]],
};

const TREE_HINTS: [string, string][] = [["J/K", "Move"], ["L/↵", "Open"], ["H", "Close"], ["Esc", "Leave"]];

/** zellij-style bar: the current mode and the keys that do something in it. */
export function StatusBar({ mode, keymap, treeFocus }: { mode: Mode; keymap: Keymap; treeFocus: boolean }) {
  const hints = HINTS[mode]
    .map(([cmd, label]) => {
      const keys = mode === "normal" ? keymap.normal[cmd] : keymap[mode][cmd];
      if (!keys?.length) return null;
      return [cmd === "tab.goto.1" ? "1-9" : pretty(keys[0]), label] as const;
    })
    .filter((h): h is readonly [string, string] => h !== null);
  return (
    <footer className={`status-bar mode-${mode}`}>
      <span className="status-mode">{treeFocus && mode === "normal" ? "TREE" : mode.toUpperCase()}</span>
      {(treeFocus && mode === "normal" ? TREE_HINTS : hints).map(([k, label]) => (
        <span key={label} className="status-hint"><kbd>{k}</kbd> {label}</span>
      ))}
    </footer>
  );
}
