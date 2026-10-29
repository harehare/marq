import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowLeft, ArrowRight, Bot, Check, Columns3, FilePlus2, FileText, Link2, List as ListIcon, ListTodo, Pencil, Plus, Sparkles, Trash2, X,
} from "lucide-react";
import { QueueDialog } from "./AutomationDialogs";
import { api, Board, Card, FileEntry } from "./api";
import { composing } from "./keys";
import { linkTo, noteLink, resolveLink } from "./links";
import { NameDialog } from "./NameDialog";
import { QuickOpen } from "./QuickOpen";

type Props = {
  vault: string;
  path: string;
  /** Notes a card can link to. */
  files: FileEntry[];
  recent: string[];
  onOpenMarkdown: () => void;
  onOpenFile: (path: string) => void;
  /** Creates a note at a vault-relative path and opens it; resolves to its path. */
  onCreateNote: (rel: string) => Promise<string>;
  /** Starts a session from a card, with a prompt naming the card. */
  onStartTask: (prompt: string) => void;
  /**
   * The board is this crew's task list: owners are picked from its members and assigning one tells
   * that member. The members work the cards, so there is no Start a session and no queue.
   */
  crew?: { id: string; members: string[] };
};

/** A card's links to notes, with their index among its nested items. */
const linksOf = (c: Card) =>
  c.notes.flatMap((n, i) => {
    const l = noteLink(n);
    return l ? [{ ...l, index: i }] : [];
  });

/** A kanban board stored as Markdown. */
export function BoardView({ vault, path, files, recent, onOpenMarkdown, onOpenFile, onCreateNote, onStartTask, crew }: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"kanban" | "list">("kanban");
  const [open, setOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; over?: { list: string; index: number } } | null>(null);
  // A list being dragged, and the index it would move to; the lists are shown in that order while dragging.
  const [dragList, setDragList] = useState<{ name: string; to?: number } | null>(null);
  // The card picking a note to link, or naming a new one.
  const [linking, setLinking] = useState<Card | null>(null);
  const [creating, setCreating] = useState<Card | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const listEls = useRef(new Map<string, HTMLElement>());
  // List positions before a reorder, to slide them from there.
  const before = useRef<Map<string, DOMRect> | null>(null);

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
  const update = (id: string, change: Parameters<typeof api.boardUpdate>[3]) =>
    // A crew assigns through its own call, which tells the new owner.
    run(crew && change.owner !== undefined && Object.keys(change).length === 1
      ? api.crewTaskUpdate(vault, crew.id, id, { owner: change.owner })
      : api.boardUpdate(vault, path, id, change));
  const listOp = (op: string, name: string, to?: string) => run(api.boardList(vault, path, op, name, to));

  const vaultRel = (p: string) => (p.startsWith(`${vault}/`) ? p.slice(vault.length + 1) : p);
  const start = (c: Card, list: string) => {
    const notes = c.notes.map((n) => {
      const l = noteLink(n);
      const file = l && resolveLink(path, l.href);
      // Vault-relative, like the board itself, so the agent can open it.
      return file ? `- ${l.title}: ${vaultRel(file)}` : `- ${n}`;
    });
    const linked = linksOf(c).length > 0;
    onStartTask(
      [c.title, ...notes, "",
        ...(linked ? ["Read the linked notes first; they hold the details for this card.", ""] : []),
        `(Card ${c.id} on the board ${vaultRel(path)}, list ${list}. Keep it up to date with board_update_card as you work.)`].join("\n"),
    );
  };
  const link = (c: Card, title: string, file: string) => update(c.id, { note: linkTo(path, title, file) });
  const openLink = (href: string) => {
    const file = resolveLink(path, href);
    if (file) onOpenFile(file);
  };

  const shown = board?.lists.map((l) => l.name) ?? [];
  if (dragList?.to !== undefined) {
    shown.splice(shown.indexOf(dragList.name), 1);
    shown.splice(dragList.to, 0, dragList.name);
  }
  const orderKey = shown.join("\n");

  const snapshot = () => {
    before.current = new Map([...listEls.current].map(([n, el]) => [n, el.getBoundingClientRect()]));
  };
  useLayoutEffect(() => {
    const prev = before.current;
    before.current = null;
    if (!prev) return;
    for (const [n, el] of listEls.current) {
      const a = prev.get(n);
      const b = el.getBoundingClientRect();
      if (!a || (a.left === b.left && a.top === b.top)) continue;
      el.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: "none" }], { duration: 160, easing: "ease-out" });
    }
  }, [orderKey]);

  const dropList = () => {
    if (dragList && board) {
      const from = board.lists.findIndex((l) => l.name === dragList.name);
      if (dragList.to !== undefined && dragList.to !== from) {
        // Keep the new order on screen until the board reloads.
        setBoard({ ...board, lists: shown.map((n) => board.lists.find((l) => l.name === n)!) });
        listOp("move", dragList.name, String(dragList.to));
      }
    }
    setDragList(null);
  };

  // Where the dragged card sits now, to place it relative to the other cards.
  const dragged = drag && board ? board.lists.flatMap((l) => l.cards.map((c, i) => ({ list: l.name, i, id: c.id }))).find((c) => c.id === drag.id) : undefined;
  // Dropping right above or below itself leaves the card where it is.
  const noop = (list: string, index: number) => dragged?.list === list && (index === dragged.i || index === dragged.i + 1);
  const drop = (list: string, index: number) => {
    // The index counts the dragged card, which is taken out before it is inserted again.
    if (drag && !noop(list, index)) update(drag.id, { list, index: dragged?.list === list && dragged.i < index ? index - 1 : index });
    setDrag(null);
  };
  const target = (list: string, index: number) => drag?.over?.list === list && drag.over.index === index && !noop(list, index);

  if (!board) return <div className="board muted pad">{error ?? "Loading…"}</div>;
  const title = path.split("/").pop()!.replace(/\.md$/, "");

  return (
    <div className={`board ${crew ? "crew-board" : ""}`}>
      <header className="board-head">
        {!crew && <h2><Columns3 size={16} /> {title}</h2>}
        <div className="modes">
          <button className={`mode ${view === "kanban" ? "on" : ""}`} onClick={() => setView("kanban")}><Columns3 size={13} /> Board</button>
          <button className={`mode ${view === "list" ? "on" : ""}`} onClick={() => setView("list")}><ListIcon size={13} /> List</button>
        </div>
        <span className="spacer" />
        <NewList onAdd={(name) => listOp("add", name)} />
        {!crew && <button className={board.queue ? "on" : ""} onClick={() => setQueueOpen(true)}
          title={board.queue ? `Cards in ${board.queue.list} start sessions while Marq runs` : "Let Marq work through a list of cards"}>
          <ListTodo size={14} /> {board.queue ? `Queue: ${board.queue.list}` : "Queue"}
        </button>}
        <button onClick={onOpenMarkdown} title="Edit the board as Markdown"><FileText size={14} /> Markdown</button>
      </header>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {/* Lists are reordered with CSS `order` while dragging, so the dragged element stays put in the DOM. */}
      <div className={view === "kanban" ? "board-columns" : "board-rows"}
        onDragOver={(e) => dragList && e.preventDefault()}
        onDrop={(e) => {
          if (!dragList) return;
          e.preventDefault();
          dropList();
        }}>
        {board.lists.map((l, li) => (
          <section key={l.name} style={{ order: shown.indexOf(l.name) }}
            ref={(el) => void (el ? listEls.current.set(l.name, el) : listEls.current.delete(l.name))}
            className={`board-list ${drag?.over?.list === l.name ? "over" : ""} ${dragList?.name === l.name ? "dragging" : ""}`}
            onDragOver={(e) => {
              if (dragList) {
                e.preventDefault();
                if (l.name === dragList.name) return;
                const at = shown.indexOf(l.name);
                const after = at > shown.indexOf(dragList.name);
                const r = e.currentTarget.getBoundingClientRect();
                const pos = view === "kanban" ? e.clientX : e.clientY;
                const mid = view === "kanban" ? r.left + r.width / 2 : r.top + r.height / 2;
                // Swap only past the middle of the list, so lists of different sizes don't flip back and forth.
                if (after ? pos <= mid : pos >= mid) return;
                snapshot();
                setDragList({ ...dragList, to: at });
                return;
              }
              if (!drag) return;
              e.preventDefault();
              if (drag.over?.list !== l.name) setDrag({ ...drag, over: { list: l.name, index: l.cards.length } });
            }}
            onDrop={(e) => {
              if (dragList) return;
              e.preventDefault();
              drop(l.name, drag?.over?.list === l.name ? drag.over.index : l.cards.length);
            }}>
            <ListHeader onDragStart={() => setDragList({ name: l.name })} onDragEnd={() => { snapshot(); setDragList(null); }} name={l.name} queue={board.queue?.list.toLowerCase() === l.name.toLowerCase()} count={l.cards.length} first={li === 0} last={li === board.lists.length - 1}
              onRename={(to) => listOp("rename", l.name, to)} onMove={(d) => listOp(d < 0 ? "left" : "right", l.name)}
              onRemove={() => listOp("remove", l.name)} />
            <div className="board-cards">
              {l.cards.map((c, ci) => (
                <div key={c.id}
                  className={`board-card ${c.done ? "done" : ""} ${open === c.id ? "open" : ""} ${drag?.id === c.id ? "dragging" : ""} ${target(l.name, ci) ? "drop-before" : ""} ${ci === l.cards.length - 1 && target(l.name, ci + 1) ? "drop-after" : ""}`}
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
                    {c.notes.length > linksOf(c).length && open !== c.id && (
                      <span className="muted small">{c.notes.length - linksOf(c).length}</span>
                    )}
                    <span className="board-id muted small">{c.id}</span>
                  </div>
                  {open !== c.id && linksOf(c).length > 0 && (
                    <div className="board-card-links">
                      {linksOf(c).map((k) => (
                        <button key={k.index} className="note-chip" title={k.href} draggable={false}
                          onClick={(e) => { e.stopPropagation(); openLink(k.href); }}>
                          <FileText size={11} /> <span className="ellipsis">{k.title || k.href}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {open === c.id && (
                    <CardDetail card={c} members={crew?.members} onUpdate={(ch) => update(c.id, ch)} onStart={crew ? undefined : () => start(c, l.name)}
                      onOpenLink={openLink} onLinkNote={() => setLinking(c)} onNewNote={() => setCreating(c)}
                      onRemove={() => run(api.boardRemove(vault, path, c.id))} />
                  )}
                </div>
              ))}
              {l.cards.length === 0 && drag?.over?.list === l.name && <div className="board-drop-hint" />}
            </div>
            <AddCard onAdd={(t) => run(api.boardAdd(vault, path, t, l.name))} />
          </section>
        ))}
      </div>
      {queueOpen && <QueueDialog vault={vault} path={path} board={board} onClose={() => { setQueueOpen(false); load(); }} />}
      {linking && (
        <QuickOpen recent={recent} placeholder={`Link a note to ${linking.id}…`}
          files={files.filter((f) => !f.kind || !["board", "crew"].includes(f.kind))
            .filter((f) => !f.rel.startsWith("sessions/") && !linksOf(linking).some((k) => resolveLink(path, k.href) === f.path))}
          onOpen={(f) => link(linking, f.title ?? f.rel.split("/").pop()!.replace(/\.md$/, ""), f.path)}
          onClose={() => setLinking(null)} />
      )}
      {creating && (
        <NameDialog title={`New note for ${creating.id}`} label="Path, relative to the vault" submit="Create"
          initial={`notes/${creating.title.replace(/[\\/:*?"<>|#[\]]+/g, "").trim().replace(/\s+/g, "-")}`}
          hint="Linked from the card and opened. .md is added if you leave it out."
          onSubmit={async (v) => {
            const rel = v.replace(/^\/+/, "").replace(/(\.md)?$/, ".md");
            const file = await onCreateNote(rel);
            await link(creating, rel.split("/").pop()!.replace(/\.md$/, ""), file);
          }}
          onClose={() => setCreating(null)} />
      )}
    </div>
  );
}

function ListHeader({ name, queue, count, first, last, onRename, onMove, onRemove, onDragStart, onDragEnd }: {
  /** The board's queue list: its cards start sessions. */
  queue?: boolean;
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
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        // Drag the whole list, not just its header.
        const list = e.currentTarget.closest<HTMLElement>(".board-list");
        if (list) {
          const r = list.getBoundingClientRect();
          e.dataTransfer.setDragImage(list, e.clientX - r.left, e.clientY - r.top);
        }
        onDragStart();
      }} onDragEnd={onDragEnd}
      onDoubleClick={() => { setValue(name); setEditing(true); }}>
      <span className="board-list-name ellipsis">{name}</span>
      {queue && <span className="board-queue-badge" title="Cards put here start a session while Marq runs"><Bot size={11} /> queue</span>}
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

function CardDetail({ card, members, onUpdate, onStart, onOpenLink, onLinkNote, onNewNote, onRemove }: {
  card: Card; onUpdate: (c: { title?: string; owner?: string; note?: string; remove_note?: number }) => void; onStart?: () => void;
  /** Crew roles to pick the owner from, instead of typing one. */
  members?: string[];
  onOpenLink: (href: string) => void; onLinkNote: () => void; onNewNote: () => void; onRemove: () => void;
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
      {members ? (
        <select value={card.owner ?? ""} onChange={(e) => onUpdate({ owner: e.target.value })}>
          <option value="">No owner</option>
          {members.map((m) => <option key={m} value={m}>@{m}</option>)}
        </select>
      ) : (
        <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Owner (e.g. me)"
          onBlur={() => owner !== (card.owner ?? "") && onUpdate({ owner })} />
      )}
      {card.notes.length > 0 && (
        <ul className="board-notes">
          {card.notes.map((n, i) => {
            const l = noteLink(n);
            return (
              <li key={i}>
                {l ? (
                  <button className="note-chip" title={l.href} onClick={() => onOpenLink(l.href)}>
                    <FileText size={11} /> <span className="ellipsis">{l.title || l.href}</span>
                  </button>
                ) : n}
                <button className="icon board-note-remove" title={l ? "Unlink" : "Remove"} onClick={() => onUpdate({ remove_note: i })}>
                  <X size={11} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…  ↵"
        onKeyDown={enter(() => { if (note.trim()) { onUpdate({ note }); setNote(""); } })} />
      <div className="board-card-actions">
        {onStart && <button className="primary" onClick={onStart}><Sparkles size={13} /> Start a session</button>}
        <button className="square" onClick={onLinkNote} title="Link an existing note"><Link2 size={13} /></button>
        <button className="square" onClick={onNewNote} title="Create a note and link it"><FilePlus2 size={13} /></button>
        <button className="square danger" onClick={onRemove} title="Delete the card"><Trash2 size={13} /></button>
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
