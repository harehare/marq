import { useEffect, useMemo, useRef, useState } from "react";
import { FolderSearch, Pin, PinOff, Vault } from "lucide-react";

const PINS_KEY = "marq.pinnedProjects";

function loadPins(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** True when every character of `q` appears in `s` in order (case-insensitive). */
const fuzzy = (s: string, q: string) => {
  const t = s.toLowerCase();
  let i = 0;
  for (const c of q.toLowerCase()) {
    i = t.indexOf(c, i);
    if (i < 0) return false;
    i++;
  }
  return true;
};

const split = (p: string) => {
  const trimmed = p.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return { name: trimmed.slice(at + 1) || trimmed, parent: at > 0 ? trimmed.slice(0, at) : "" };
};

/**
 * The project field: type a path or filter, pick from pinned and recent projects, browse for a folder,
 * or choose the vault (empty). No scanning: the candidates are what the user has used or pinned.
 */
export function ProjectPicker({ value, onChange, recent, onBrowse, pathProps }: {
  value: string;
  onChange: (v: string) => void;
  recent: string[];
  onBrowse: () => void;
  pathProps?: object;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [pins, setPins] = useState(loadPins);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const close = () => {
    setOpen(false);
    setFilter(null);
  };
  const savePins = (next: string[]) => {
    setPins(next);
    try {
      localStorage.setItem(PINS_KEY, JSON.stringify(next));
    } catch {}
  };
  const togglePin = (p: string) => savePins(pins.includes(p) ? pins.filter((x) => x !== p) : [...pins, p]);

  const q = (filter ?? "").trim();
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: { path: string; pinned: boolean }[] = [];
    for (const p of [...pins, ...recent]) {
      if (seen.has(p) || (q && !fuzzy(p, q))) continue;
      seen.add(p);
      out.push({ path: p, pinned: pins.includes(p) });
    }
    return out;
  }, [pins, recent, q]);

  const pick = (p: string) => {
    onChange(p);
    close();
  };

  return (
    <div className="project-picker" ref={root}>
      <input
        value={filter ?? value}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setFilter(e.target.value);
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(items.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter" && open && filter !== null && items[active]) {
            e.preventDefault();
            pick(items[active].path);
          } else if (e.key === "Escape" && open) {
            e.stopPropagation();
            close();
          }
        }}
        placeholder="Project (empty: the vault)"
        title={value || "Where the agent runs"}
        spellCheck={false}
        {...(filter === null ? pathProps : {})}
      />
      <button className="icon" onClick={onBrowse} title="Browse for the project"><FolderSearch size={14} /></button>
      {open && (
        <div className="project-menu" role="listbox">
          <button className={`project-item ${value === "" ? "on" : ""}`} onClick={() => pick("")}>
            <Vault size={13} className="muted" /><span className="project-name">The vault</span>
            <span className="project-parent">no project</span>
          </button>
          {items.map((it, i) => {
            const { name, parent } = split(it.path);
            return (
              <div key={it.path} className={`project-item ${i === active ? "active" : ""} ${it.path === value ? "on" : ""}`}
                role="option" aria-selected={it.path === value} onMouseEnter={() => setActive(i)} onClick={() => pick(it.path)}>
                <span className="project-name">{name}</span>
                <span className="project-parent" title={it.path}>{parent}</span>
                <button className="icon" title={it.pinned ? "Unpin" : "Pin to the top"}
                  onClick={(e) => { e.stopPropagation(); togglePin(it.path); }}>
                  {it.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                </button>
              </div>
            );
          })}
          {items.length === 0 && <div className="project-empty muted small">{q ? "No match: the text is used as the path." : "No recent projects yet."}</div>}
          <button className="project-item" onClick={() => { close(); onBrowse(); }}>
            <FolderSearch size={13} className="muted" /><span className="project-name">Browse…</span>
          </button>
        </div>
      )}
    </div>
  );
}
