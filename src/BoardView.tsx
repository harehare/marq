import { lastTaskDefaults } from "./NewTaskDialog";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlignLeft, ArrowLeft, ArrowRight, Check, ChevronDown, Columns3, FilePlus2, FileText, Link2, List as ListIcon, ListTodo, Pencil, Plus, Search, Sparkles, Tag,
  Trash2, User, X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, Board, Card, FileEntry } from "./api";
import { composing } from "./keys";
import { linkTo, noteLink, resolveLink } from "./links";
import { NameDialog } from "./NameDialog";
import { QuickOpen } from "./QuickOpen";
import { useAutoGrow } from "./useAutoGrow";

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
  /** Starts a session from a card, with a prompt naming the card. `after` runs once the task has started. */
  onStartTask: (prompt: string, after?: () => void) => void;
};

/** A card's links to notes, with their index among its nested items. */
const linksOf = (c: Card) =>
  c.notes.flatMap((n, i) => {
    const l = noteLink(n);
    return l ? [{ ...l, index: i }] : [];
  });

/** Hues far enough apart to tell labels apart: green, yellow, orange, red, purple, blue, sky, lime, pink, teal. */
const HUES = [140, 45, 25, 2, 272, 218, 195, 85, 325, 168];
/** A hue for a label or owner, the same wherever it appears. */
const hue = (name: string) => {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
};
const hueStyle = (name: string) => ({ "--h": hue(name) }) as React.CSSProperties;

function LabelChip({ name, on, onClick, onRemove }: { name: string; on?: boolean; onClick?: () => void; onRemove?: () => void }) {
  return (
    <span className={`board-label ${on ? "on" : ""} ${onClick ? "clickable" : ""}`} style={hueStyle(name)} onClick={onClick}>
      {name}
      {onRemove && <button className="board-label-remove" title="Remove label" onClick={(e) => { e.stopPropagation(); onRemove(); }}><X size={10} /></button>}
    </span>
  );
}

/** A select drawn like the app's controls instead of the platform's. */
function Select({ value, onChange, children, className = "" }: { value: string; onChange: (v: string) => void; children: React.ReactNode; className?: string }) {
  return (
    <span className={`board-select ${className}`}>
      <select value={value} onChange={(e) => { onChange(e.target.value); e.target.blur(); }}>{children}</select>
      <ChevronDown size={12} />
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  return <span className="board-avatar" style={hueStyle(name)} title={`@${name}`}>{name.slice(0, 2)}</span>;
}

/** A kanban board stored as Markdown. */
export function BoardView({ vault, path, files, recent, onOpenMarkdown, onOpenFile, onCreateNote, onStartTask }: Props) {
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
  // Cards shown: those with every picked label and the text in their title, id or owner.
  const [filterLabels, setFilterLabels] = useState<string[]>([]);
  const [filterText, setFilterText] = useState("");
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
    run(api.boardUpdate(vault, path, id, change));
  const listOp = (op: string, name: string, to?: string) => run(api.boardList(vault, path, op, name, to));

  const vaultRel = (p: string) => (p.startsWith(`${vault}/`) ? p.slice(vault.length + 1) : p);
  /** The card as a task prompt: its notes, and where it lives so the agent keeps it up to date. */
  const cardPrompt = (c: Card, list: string) => {
    const notes = c.notes.map((n) => {
      const l = noteLink(n);
      const file = l && resolveLink(path, l.href);
      // Vault-relative, like the board itself, so the agent can open it.
      return file ? `- ${l.title}: ${vaultRel(file)}` : `- ${n}`;
    });
    const linked = linksOf(c).length > 0;
    return [c.title, ...notes, "",
      ...(linked ? ["Read the linked notes first; they hold the details for this card.", ""] : []),
      `(Card ${c.id} on the board ${vaultRel(path)}, list ${list}. Keep it up to date with board_update_card as you work.)`].join("\n");
  };
  const start = (c: Card, list: string) => {
    // Once the session has started the card goes to the list named Doing / In progress, if there is one.
    const doing = board?.lists.find((l) => /^(doing|in progress|wip)$/i.test(l.name.trim()))?.name;
    const target = doing && board?.lists.find((l) => l.name.toLowerCase() === doing.toLowerCase())?.name;
    onStartTask(
      cardPrompt(c, list),
      target && target.toLowerCase() !== list.toLowerCase() ? () => update(c.id, { list: target }) : undefined,
    );
  };
  // Queues the card in the inbox so it waits for its turn instead of starting now: it becomes a request
  // that runs with what the last task used, or, with nothing to go on, opens New task to choose.
  const queueCard = async (c: Card, list: string) => {
    const { project, mode, worktree } = lastTaskDefaults();
    if (!project) {
      start(c, list);
      return;
    }
    try {
      const rel = await api.saveTask(vault, {
        title: c.title, prompt: cardPrompt(c, list), project, permissionMode: mode, carryChanges: false, worktree, autoTitle: false,
      });
      await api.inboxQueueRequest(`${vault}/${rel}`, c.title);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  const link = (c: Card, title: string, file: string) => update(c.id, { note: linkTo(path, title, file) });
  const openLink = (href: string) => {
    const file = resolveLink(path, href);
    if (file) onOpenFile(file);
    else if (/^(https?:|mailto:)/i.test(href)) openUrl(href).catch(() => {});
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
  const allLabels = [...new Map(board.lists.flatMap((l) => l.cards.flatMap((c) => c.labels)).map((x) => [x.toLowerCase(), x])).values()]
    .sort((a, b) => a.localeCompare(b));
  const text = filterText.trim().toLowerCase();
  const filtering = filterLabels.length > 0 || text !== "";
  const shows = (c: Card) =>
    filterLabels.every((f) => c.labels.some((x) => x.toLowerCase() === f.toLowerCase()))
    && (!text || [c.title, c.id, c.owner ?? ""].some((v) => v.toLowerCase().includes(text)));
  const toggleFilter = (x: string) =>
    setFilterLabels((fs) => (fs.some((f) => f.toLowerCase() === x.toLowerCase()) ? fs.filter((f) => f.toLowerCase() !== x.toLowerCase()) : [...fs, x]));
  const openCard = open ? board.lists.flatMap((l) => l.cards.map((c) => ({ c, list: l.name }))).find((x) => x.c.id === open) : undefined;

  return (
    <div className="board">
      <header className="board-head">
        <h2><Columns3 size={16} /> {title}</h2>
        <div className="modes">
          <button className={`mode ${view === "kanban" ? "on" : ""}`} onClick={() => setView("kanban")}><Columns3 size={13} /> Board</button>
          <button className={`mode ${view === "list" ? "on" : ""}`} onClick={() => setView("list")}><ListIcon size={13} /> List</button>
        </div>
        <span className="board-filter">
          <Search size={13} />
          <input value={filterText} onChange={(e) => setFilterText(e.target.value)} placeholder="Filter cards"
            onKeyDown={(e) => e.key === "Escape" && setFilterText("")} />
          {filtering && <button className="icon" title="Clear the filter" onClick={() => { setFilterText(""); setFilterLabels([]); }}><X size={12} /></button>}
        </span>
        <span className="spacer" />
        <NewList onAdd={(name) => listOp("add", name)} />
        <button onClick={onOpenMarkdown} title="Edit the board as Markdown"><FileText size={14} /> Markdown</button>
      </header>
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {allLabels.length > 0 && (
        <div className="board-label-bar">
          <Tag size={12} className="muted" />
          {allLabels.map((x) => <LabelChip key={x} name={x} on={filterLabels.some((f) => f.toLowerCase() === x.toLowerCase())} onClick={() => toggleFilter(x)} />)}
        </div>
      )}
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
            <ListHeader onDragStart={() => setDragList({ name: l.name })} onDragEnd={() => { snapshot(); setDragList(null); }} name={l.name} count={l.cards.length} shown={filtering ? l.cards.filter(shows).length : undefined} first={li === 0} last={li === board.lists.length - 1}
              onRename={(to) => listOp("rename", l.name, to)} onMove={(d) => listOp(d < 0 ? "left" : "right", l.name)}
              onRemove={() => listOp("remove", l.name)} />
            <div className="board-cards">
              {l.cards.map((c, ci) => (
                <div key={c.id} hidden={!shows(c)}
                  className={`board-card ${c.done ? "done" : ""} ${drag?.id === c.id ? "dragging" : ""} ${target(l.name, ci) ? "drop-before" : ""} ${ci === l.cards.length - 1 && target(l.name, ci + 1) ? "drop-after" : ""}`}
                  draggable
                  onClick={() => setOpen(c.id)}
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
                  {c.labels.length > 0 && (
                    <div className="board-card-labels">
                      {c.labels.map((x) => <LabelChip key={x} name={x} />)}
                    </div>
                  )}
                  <div className="board-card-main">
                    <button className={`board-check ${c.done ? "on" : ""}`} title={c.done ? "Mark as not done" : "Mark as done"}
                      onClick={(e) => { e.stopPropagation(); update(c.id, { done: !c.done }); }}>
                      {c.done && <Check size={11} />}
                    </button>
                    <span className="board-card-title">{c.title}</span>
                  </div>
                  {linksOf(c).length > 0 && (
                    <div className="board-card-links">
                      {linksOf(c).map((k) => (
                        <button key={k.index} className="note-chip" title={k.href} draggable={false}
                          onClick={(e) => { e.stopPropagation(); openLink(k.href); }}>
                          <FileText size={11} /> <span className="ellipsis">{k.title || k.href}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="board-card-foot">
                    <span className="board-id">{c.id}</span>
                    {c.notes.length > linksOf(c).length && (
                      <span className="board-badge" title="Notes"><AlignLeft size={11} /> {c.notes.length - linksOf(c).length}</span>
                    )}
                    <span className="spacer" />
                    {c.owner && <Avatar name={c.owner} />}
                  </div>
                </div>
              ))}
              {l.cards.length === 0 && drag?.over?.list === l.name && <div className="board-drop-hint" />}
            </div>
            <AddCard onAdd={(t) => run(api.boardAdd(vault, path, t, l.name))} />
          </section>
        ))}
      </div>
      {openCard && (
        <CardDialog card={openCard.c} list={openCard.list} lists={board.lists.map((l) => l.name)} labels={allLabels}
          onUpdate={(ch) => update(openCard.c.id, ch)} onStart={() => { start(openCard.c, openCard.list); setOpen(null); }}
          onQueue={() => { void queueCard(openCard.c, openCard.list); setOpen(null); }}
          onOpenLink={openLink} onLinkNote={() => setLinking(openCard.c)} onNewNote={() => setCreating(openCard.c)}
          onRemove={() => { setOpen(null); run(api.boardRemove(vault, path, openCard.c.id)); }}
          onClose={() => setOpen(null)} />
      )}
      {linking && (
        <QuickOpen recent={recent} placeholder={`Link a note to ${linking.id}…`}
          files={files.filter((f) => !f.kind || f.kind !== "board")
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

function ListHeader({ name, count, shown, first, last, onRename, onMove, onRemove, onDragStart, onDragEnd }: {
  /** Cards the filter shows, while filtering. */
  shown?: number;
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
      <span className="count">{shown !== undefined ? `${shown}/${count}` : count}</span>
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

function CardDialog({ card, list, lists, labels, onUpdate, onStart, onQueue, onOpenLink, onLinkNote, onNewNote, onRemove, onClose }: {
  card: Card; list: string; lists: string[];
  /** Every label on the board, offered when adding one. */
  labels: string[];
  onUpdate: (c: Parameters<typeof api.boardUpdate>[3]) => void; onStart?: () => void;
  /** Puts the card in the inbox to start when there is room. */
  onQueue?: () => void;
  onOpenLink: (href: string) => void; onLinkNote: () => void; onNewNote: () => void; onRemove: () => void; onClose: () => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [owner, setOwner] = useState(card.owner ?? "");
  const [note, setNote] = useState("");
  const [label, setLabel] = useState("");
  const titleEl = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(titleEl, title, 200);
  useEffect(() => {
    setTitle(card.title);
    setOwner(card.owner ?? "");
  }, [card.title, card.owner]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const has = (x: string) => card.labels.some((l) => l.toLowerCase() === x.toLowerCase());
  const addLabel = (x: string) => {
    const v = x.trim().replace(/^#+/, "");
    if (v && !has(v)) onUpdate({ labels: [...card.labels, v] });
    setLabel("");
  };
  const saveTitle = () => title.trim() && title !== card.title && onUpdate({ title });
  const blurOnEsc = (e: React.KeyboardEvent<HTMLElement>) => e.key === "Escape" && e.currentTarget.blur();
  const links = linksOf(card);
  const texts = card.notes.map((n, i) => ({ n, i })).filter(({ n }) => !noteLink(n));
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal board-dialog">
        <div className="board-dialog-head">
          <button className={`board-check ${card.done ? "on" : ""}`} title={card.done ? "Mark as not done" : "Mark as done"}
            onClick={() => onUpdate({ done: !card.done })}>
            {card.done && <Check size={11} />}
          </button>
          <textarea ref={titleEl} className="board-dialog-title" rows={1} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
            onKeyDown={(e) => {
              if (composing(e)) return;
              if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
              blurOnEsc(e);
            }} />
          <button className="icon" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="board-dialog-sub muted small">
          <span className="board-id">{card.id}</span> in list
          <Select className="pill" value={list} onChange={(v) => onUpdate({ list: v })}>
            {lists.map((l) => <option key={l} value={l}>{l}</option>)}
          </Select>
        </div>
        <div className="board-dialog-body">
          <div className="board-dialog-main">
            <div className="board-dialog-row">
              <div className="board-dialog-field">
                <label className="field-label"><Tag size={11} /> Labels</label>
                <div className="board-dialog-labels">
                  {card.labels.map((x) => <LabelChip key={x} name={x} onRemove={() => onUpdate({ labels: card.labels.filter((l) => l !== x) })} />)}
                  <input className="board-label-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="+ Label" list="board-labels"
                    onBlur={() => label.trim() && addLabel(label)}
                    onKeyDown={(e) => {
                      if (composing(e)) return;
                      if (e.key === "Enter") addLabel(label);
                      if (e.key === "Backspace" && !label && card.labels.length) onUpdate({ labels: card.labels.slice(0, -1) });
                      blurOnEsc(e);
                    }} />
                  <datalist id="board-labels">{labels.filter((x) => !has(x)).map((x) => <option key={x} value={x} />)}</datalist>
                </div>
                {labels.some((x) => !has(x)) && (
                  <div className="board-dialog-labels suggest">
                    {labels.filter((x) => !has(x)).map((x) => <LabelChip key={x} name={x} onClick={() => addLabel(x)} />)}
                  </div>
                )}
              </div>
              <div className="board-dialog-field">
                <label className="field-label"><User size={11} /> Owner</label>
                <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. me"
                  onBlur={() => owner !== (card.owner ?? "") && onUpdate({ owner })}
                  onKeyDown={(e) => { if (!composing(e) && e.key === "Enter") e.currentTarget.blur(); blurOnEsc(e); }} />
              </div>
            </div>
            <label className="field-label"><AlignLeft size={11} /> Notes</label>
            {texts.length > 0 && (
              <ul className="board-notes">
                {texts.map(({ n, i }) => (
                  <li key={i}>
                    {n}
                    <button className="icon board-note-remove" title="Remove" onClick={() => onUpdate({ remove_note: i })}><X size={11} /></button>
                  </li>
                ))}
              </ul>
            )}
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…  ↵"
              onKeyDown={(e) => {
                if (composing(e)) return;
                if (e.key === "Enter" && note.trim()) { onUpdate({ note }); setNote(""); }
                blurOnEsc(e);
              }} />
            {links.length > 0 && (
              <>
                <label className="field-label"><FileText size={11} /> Linked notes</label>
                <div className="board-dialog-links">
                  {links.map((k) => (
                    <span key={k.index} className="board-dialog-link">
                      <button className="note-chip" title={k.href} onClick={() => onOpenLink(k.href)}>
                        <FileText size={11} /> <span className="ellipsis">{k.title || k.href}</span>
                      </button>
                      <button className="icon board-note-remove" title="Unlink" onClick={() => onUpdate({ remove_note: k.index })}><X size={11} /></button>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="board-dialog-side">
            <label className="field-label">Actions</label>
            {onStart && <button className="primary" onClick={onStart}><Sparkles size={13} /> Start a session</button>}
            {onQueue && (
              <button onClick={onQueue} title="Put the card in the Inbox: it starts in its turn, one at a time by default">
                <ListTodo size={13} /> Queue
              </button>
            )}
            <button onClick={onLinkNote}><Link2 size={13} /> Link a note</button>
            <button onClick={onNewNote}><FilePlus2 size={13} /> New note</button>
            <button className="danger" onClick={onRemove}><Trash2 size={13} /> Delete</button>
          </div>
        </div>
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
