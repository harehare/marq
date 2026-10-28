import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowLeft, ArrowRight, Check, Columns3, FileText, List as ListIcon, Pencil, Plus, Sparkles, Trash2, X,
} from "lucide-react";
import { api, Board, Card } from "./api";
import { composing } from "./keys";

type Props = {
  vault: string;
  path: string;
  onOpenMarkdown: () => void;
  /** Starts a session from a card, with a prompt naming the card. */
  onStartTask: (prompt: string) => void;
};

/** A kanban board stored as Markdown. */
export function BoardView({ vault, path, onOpenMarkdown, onStartTask }: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"kanban" | "list">("kanban");
  const [open, setOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; over?: { list: string; index: number } } | null>(null);
  // A list being dragged, and the gap it would drop into (0 = before the first list).
  const [dragList, setDragList] = useState<{ name: string; gap?: number } | null>(null);

  const load = useCallback(() => api.boardRead(vault, path).then(setBoard, (e) => setError(String(e))), [vault, path]);
  useEffect(() => {
    load();
    const un = listen<{ path: string }>("vault://changed", (e) => e.payload.path === path && load());
    return () => {
      un.then((f) => f());
    };
  }, [load, path]);

  const run = async (p: Promise<unknown>) => {
    try {
      await p;
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    load();
  };
  const update = (id: string, change: Parameters<typeof api.boardUpdate>[3]) => run(api.boardUpdate(vault, path, id, change));
  const listOp = (op: string, name: string, to?: string) => run(api.boardList(vault, path, op, name, to));

  const start = (c: Card, list: string) => {
    const rel = path.slice(vault.length + 1);
    onStartTask(
      [c.title, ...c.notes.map((n) => `- ${n}`), "",
        `(Card ${c.id} on the board ${rel}, list ${list}. Keep it up to date with board_update_card as you work.)`].join("\n"),
    );
  };

  const dropList = () => {
    if (dragList?.gap !== undefined && board) {
      const from = board.lists.findIndex((l) => l.name === dragList.name);
      // The gap counts the dragged list itself; its own removal shifts later gaps by one.
      const to = dragList.gap > from ? dragList.gap - 1 : dragList.gap;
      if (to !== from) listOp("move", dragList.name, String(to));
    }
    setDragList(null);
  };

  const drop = (list: string, index: number) => {
    if (drag) update(drag.id, { list, index });
    setDrag(null);
  };

  if (!board) return <div className="board muted pad">{error ?? "Loading…"}</div>;
  const title = path.split("/").pop()!.replace(/\.md$/, "");

  return (
    <div className="board">
      <header className="board-head">
        <h2><Columns3 size={16} /> {title}</h2>
        <div className="modes">
          <button className={`mode ${view === "kanban" ? "on" : ""}`} onClick={() => setView("kanban")}><Columns3 size={13} /> Board</button>
          <button className={`mode ${view === "list" ? "on" : ""}`} onClick={() => setView("list")}><ListIcon size={13} /> List</button>
        </div>
        <span className="spacer" />
        <NewList onAdd={(name) => listOp("add", name)} />
        <button onClick={onOpenMarkdown} title="Edit the board as Markdown"><FileText size={14} /> Markdown</button>
      </header>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      <div className={view === "kanban" ? "board-columns" : "board-rows"}>
        {board.lists.map((l, li) => (
          <section key={l.name}
            className={`board-list ${drag?.over?.list === l.name ? "over" : ""} ${dragList?.name === l.name ? "dragging" : ""}
              ${dragList?.gap === li && dragList.name !== l.name ? "gap-before" : ""} ${dragList?.gap === li + 1 && li === board.lists.length - 1 ? "gap-after" : ""}`}
            onDragOver={(e) => {
              if (dragList) {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const after = view === "kanban" ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
                const gap = after ? li + 1 : li;
                if (dragList.gap !== gap) setDragList({ ...dragList, gap });
                return;
              }
              if (!drag) return;
              e.preventDefault();
              if (drag.over?.list !== l.name) setDrag({ ...drag, over: { list: l.name, index: l.cards.length } });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragList) return dropList();
              drop(l.name, drag?.over?.list === l.name ? drag.over.index : l.cards.length);
            }}>
            <ListHeader onDragStart={() => setDragList({ name: l.name })} onDragEnd={() => setDragList(null)} name={l.name} count={l.cards.length} first={li === 0} last={li === board.lists.length - 1}
              onRename={(to) => listOp("rename", l.name, to)} onMove={(d) => listOp(d < 0 ? "left" : "right", l.name)}
              onRemove={() => listOp("remove", l.name)} />
            <div className="board-cards">
              {l.cards.map((c, ci) => (
                <div key={c.id}
                  className={`board-card ${c.done ? "done" : ""} ${open === c.id ? "open" : ""} ${drag?.id === c.id ? "dragging" : ""}`}
                  draggable={open !== c.id}
                  onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = "move"; setDrag({ id: c.id }); }}
                  onDragEnd={() => setDrag(null)}
                  onDragOver={(e) => {
                    if (!drag || dragList) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    const index = e.clientY < r.top + r.height / 2 ? ci : ci + 1;
                    if (drag.over?.list !== l.name || drag.over.index !== index) setDrag({ ...drag, over: { list: l.name, index } });
                  }}
                  onDrop={(e) => {
                    if (dragList) return;
                    e.preventDefault();
                    e.stopPropagation();
                    drop(l.name, drag?.over?.index ?? ci);
                  }}>
                  <div className="board-card-main" onClick={() => setOpen(open === c.id ? null : c.id)}>
                    <button className={`board-check ${c.done ? "on" : ""}`} title={c.done ? "Mark as not done" : "Mark as done"}
                      onClick={(e) => { e.stopPropagation(); update(c.id, { done: !c.done }); }}>
                      {c.done && <Check size={11} />}
                    </button>
                    <span className="board-card-title">{c.title}</span>
                    {c.owner && <span className="board-owner">@{c.owner}</span>}
                    {c.notes.length > 0 && open !== c.id && <span className="muted small">{c.notes.length}</span>}
                    <span className="board-id muted small">{c.id}</span>
                  </div>
                  {open === c.id && (
                    <CardDetail card={c} onUpdate={(ch) => update(c.id, ch)} onStart={() => start(c, l.name)}
                      onRemove={() => run(api.boardRemove(vault, path, c.id))} />
                  )}
                </div>
              ))}
              {drag?.over?.list === l.name && <div className="board-drop-hint" />}
            </div>
            <AddCard onAdd={(t) => run(api.boardAdd(vault, path, t, l.name))} />
          </section>
        ))}
      </div>
    </div>
  );
}

function ListHeader({ name, count, first, last, onRename, onMove, onRemove, onDragStart, onDragEnd }: {
  name: string; count: number; first: boolean; last: boolean;
  onRename: (to: string) => void; onMove: (d: number) => void; onRemove: () => void;
  onDragStart: () => void; onDragEnd: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  if (editing) {
    return (
      <div className="board-list-head">
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (composing(e)) return;
            if (e.key === "Enter" && value.trim()) { onRename(value.trim()); setEditing(false); }
            if (e.key === "Escape") setEditing(false);
          }} />
      </div>
    );
  }
  return (
    <div className="board-list-head" draggable title="Drag to reorder; double-click to rename"
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }} onDragEnd={onDragEnd}
      onDoubleClick={() => { setValue(name); setEditing(true); }}>
      <span className="board-list-name ellipsis">{name}</span>
      <span className="count">{count}</span>
      <span className="board-list-actions">
        <button className="icon" title="Rename" onClick={() => { setValue(name); setEditing(true); }}><Pencil size={12} /></button>
        <button className="icon" title="Move left" disabled={first} onClick={() => onMove(-1)}><ArrowLeft size={12} /></button>
        <button className="icon" title="Move right" disabled={last} onClick={() => onMove(1)}><ArrowRight size={12} /></button>
        <button className="icon" title={count ? "Move its cards first" : "Remove list"} disabled={count > 0} onClick={onRemove}>
          <Trash2 size={12} />
        </button>
      </span>
    </div>
  );
}

function CardDetail({ card, onUpdate, onStart, onRemove }: {
  card: Card; onUpdate: (c: { title?: string; owner?: string; note?: string }) => void; onStart: () => void; onRemove: () => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [owner, setOwner] = useState(card.owner ?? "");
  const [note, setNote] = useState("");
  useEffect(() => {
    setTitle(card.title);
    setOwner(card.owner ?? "");
  }, [card.title, card.owner]);
  const enter = (f: () => void) => (e: React.KeyboardEvent) => !composing(e) && e.key === "Enter" && f();
  return (
    <div className="board-card-detail" onClick={(e) => e.stopPropagation()}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title"
        onBlur={() => title.trim() && title !== card.title && onUpdate({ title })} onKeyDown={(e) => !composing(e) && e.key === "Enter" && e.currentTarget.blur()} />
      <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Owner (e.g. me)"
        onBlur={() => owner !== (card.owner ?? "") && onUpdate({ owner })} />
      {card.notes.length > 0 && <ul className="board-notes">{card.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…  ↵"
        onKeyDown={enter(() => { if (note.trim()) { onUpdate({ note }); setNote(""); } })} />
      <div className="row">
        <button className="primary" onClick={onStart}><Sparkles size={13} /> Start a session</button>
        <span className="spacer" />
        <button className="danger" onClick={onRemove}><Trash2 size={13} /> Delete</button>
      </div>
    </div>
  );
}

function AddCard({ onAdd }: { onAdd: (title: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <input className="board-add" value={value} onChange={(e) => setValue(e.target.value)} placeholder="+ Add a card"
      onKeyDown={(e) => {
        if (composing(e) || e.key !== "Enter" || !value.trim()) return;
        onAdd(value.trim());
        setValue("");
      }} />
  );
}

function NewList({ onAdd }: { onAdd: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  if (!editing) return <button onClick={() => setEditing(true)}><Plus size={14} /> List</button>;
  return (
    <span className="board-new-list">
      <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. Review" onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (composing(e)) return;
          if (e.key === "Enter" && value.trim()) { onAdd(value.trim()); setValue(""); setEditing(false); }
          if (e.key === "Escape") setEditing(false);
        }} />
      <button className="icon" onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(false)}><X size={13} /></button>
    </span>
  );
}
