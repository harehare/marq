import { useEffect, useMemo, useRef, useState } from "react";
import { usePaletteKeys } from "./usePaletteKeys";
import { composing, pretty } from "./keys";

export type PaletteCommand = { id: string; label: string; keys: string[] };

/** Every command with its keys; type to filter, ↵ to run. */
export function CommandPalette({ getCommands, onRun, onClose }: {
  /** Called once, when the palette opens. */
  getCommands: () => PaletteCommand[]; onRun: (id: string) => void; onClose: () => void;
}) {
  const [commands] = useState(getCommands);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  usePaletteKeys(inputRef, onClose);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => `${c.label} ${c.id}`.toLowerCase().includes(w)));
  }, [commands, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (c?: PaletteCommand) => {
    if (!c) return;
    onClose();
    onRun(c.id);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <input ref={inputRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a command…"
          onKeyDown={(e) => {
            if (composing(e)) return;
            if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setSel((i) => Math.min(i + 1, shown.length - 1));
            else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setSel((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter") run(shown[sel]);
            else return;
            e.preventDefault();
          }} />
        <div className="palette-list" ref={listRef}>
          {shown.map((c, i) => (
            <div key={c.id} className={`palette-item ${i === sel ? "on" : ""}`} onMouseMove={() => setSel(i)} onClick={() => run(c)}>
              <span className="ellipsis">{c.label}</span>
              <span className="palette-keys">{c.keys.slice(0, 2).map((k) => <kbd key={k}>{pretty(k)}</kbd>)}</span>
            </div>
          ))}
          {shown.length === 0 && <div className="muted small pad">No commands</div>}
        </div>
      </div>
    </div>
  );
}
