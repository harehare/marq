import { createContext, forwardRef, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  Inbox, BookA, ClipboardList, ListOrdered, Lightbulb, ScrollText, FilePlus2, Braces, ChevronRight, FileText, Folder, MessageSquare, X,
  ArrowLeftRight, Sparkles, Plus, ChevronsDownUp, ChevronsUpDown, GitBranch, Trash2, FolderOpen, CornerUpLeft, Square, ExternalLink, Pencil, FolderInput, FolderPlus, CircleCheck, CheckCheck, CircleDashed, CircleSlash, RotateCw, GitPullRequest, GitCompare,
  Palette, Settings as SettingsIcon, Check, Monitor, Sun, Moon, SquareTerminal, Columns3, Search, Timer, Play, Pause, Pin, PinOff,
  ArrowDownAZ, ArrowUpZA, ArrowDownUp, Clock, PanelLeftClose, PanelLeftOpen, PanelRightClose, Columns2, Rows2, StickyNote, NotebookPen, FolderGit2, History, Activity, PanelLeft, Server, ListFilter, Layers,
} from "lucide-react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { LucideIcon } from "lucide-react";
import { VerifyBadge } from "./VerifyBadge";
import { api, FileEntry, InboxEvent, Schedule, SessionInfo } from "./api";
import { ScheduleDialog } from "./AutomationDialogs";
import { setVaultFiles } from "./wikilinks";
import { NoteEditor } from "./NoteEditor";
import { SessionView } from "./SessionView";
import { QueryView } from "./QueryView";
import { TerminalView, PANE_EVENT, type PaneAction, type PaneRequest } from "./TerminalView";
import { BoardView } from "./BoardView";
import { QuickOpen } from "./QuickOpen";
import { SearchView } from "./SearchView";
import { namesWorkspace } from "./workspaces";
import { filterSessions, groupRecent, projectName, recentGroups, RecentGroup } from "./recentSessions";
import { CommandPalette } from "./CommandPalette";
import { StatusBar } from "./StatusBar";
import { TabStrip } from "./TabStrip";
import { TabErrorBoundary } from "./TabErrorBoundary";
import { FIND_EVENT, Keymap, Mode, TREE_KEYS, eventKey, lookup, mergeKeys, composing } from "./keys";
import { NewTaskDialog, lastProject } from "./NewTaskDialog";
import { QueryContext, RUN_AGENT_EVENT } from "./queryContext";
import { CompareView } from "./review/CompareView";
import { LogoMark } from "./Logo";
import { Resizer, usePaneSize } from "./Resizer";
import { Excerpt, SendToSessionDialog } from "./SendToSessionDialog";
import { NameDialog } from "./NameDialog";
import { SettingsDialog } from "./SettingsDialog";
import { ContextMenu, MenuItem, MenuState } from "./ContextMenu";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { PALETTES, useTheme } from "./theme";
import { Settings, getSettings, organizeKeys, setSettings, useSettings } from "./settings";
import { notify, summary } from "./notify";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

/** Pinned tabs come first in the list, so tab order and Cmd+1… match what is shown. */
type Tab = { pinned?: boolean } & (
  | { key: string; kind: "note"; path: string; title: string; jump?: { line: number; nonce: number }; fresh?: boolean }
  | { key: string; kind: "session"; id: string; title: string }
  | { key: string; kind: "query"; title: string }
  /** The runs of one request on several models, side by side. */
  | { key: string; kind: "compare"; ids: string[]; title: string }
  | { key: string; kind: "board"; path: string; title: string }
  /** `initial` changes (with a new nonce) when a search is started from elsewhere. */
  | { key: string; kind: "search"; title: string; initial: string; nonce: number }
  /** `named`: renamed by the user, so the shell's title no longer applies. */
  | { key: string; kind: "terminal"; id: string; cwd: string; title: string; command?: string; named?: boolean });

const VAULT_KEY = "marq.vault";

const RECENT_KEY = "marq.recentVaults";

/** Most recent first. */
function loadRecentVaults(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function loadVault(): string | null {
  try {
    // Fall back to the key used before the app was renamed.
    return localStorage.getItem(VAULT_KEY) ?? localStorage.getItem("kura.vault");
  } catch {
    return null;
  }
}

const tabsKey = (vault: string) => `marq.tabs:${vault}`;

/**
 * Two tabs side by side (`row`) or one above the other (`column`). The focused one is `active`;
 * `other` is the tab in the other pane, and `side` is where the focused one sits (0: left or top).
 */
type Split = { other: string; dir: "row" | "column"; side: 0 | 1 };

// Kinds no longer in the app are dropped. Terminals' shells ended with the app: only pinned ones
// come back, as a fresh shell in the same directory with the same title (not the command they ran).
const RESTORED_KINDS = new Set(["note", "session", "query", "compare", "board", "search"]);
const restored = (t: Tab) => RESTORED_KINDS.has(t.kind) || (t.kind === "terminal" && !!t.pinned && typeof t.cwd === "string");

/**
 * The tabs open when the vault was last shown.
 * One-off state (a jump to a line, a just-created note) is dropped too.
 */
function loadTabs(vault: string | null): { tabs: Tab[]; active: string | null; split: Split | null } {
  try {
    const v = vault && JSON.parse(localStorage.getItem(tabsKey(vault)) ?? "null");
    if (!v || !Array.isArray(v.tabs)) return { tabs: [], active: null, split: null };
    const tabs = (v.tabs as Tab[])
      .filter((t) => t && typeof t.key === "string" && restored(t))
      .map((t) => (t.kind === "note" ? { ...t, jump: undefined, fresh: undefined } : t.kind === "terminal" ? { ...t, command: undefined } : t));
    const active = tabs.some((t) => t.key === v.active) ? v.active : tabs[tabs.length - 1]?.key ?? null;
    const sp = v.split as Split | null;
    const split = sp && sp.other !== active && tabs.some((t) => t.key === sp.other) && (sp.dir === "row" || sp.dir === "column") ? sp : null;
    return { tabs, active, split };
  } catch {
    return { tabs: [], active: null, split: null };
  }
}

type Tree = { dirs: Map<string, Tree>; files: FileEntry[] };

/** How notes are ordered in the sidebar. Folders follow the same order, by their newest note when sorting by date. */
type NoteSort = "name" | "name-desc" | "modified" | "modified-old";
const NOTE_SORTS: { value: NoteSort; label: string; icon: LucideIcon }[] = [
  { value: "name", label: "Name (A → Z)", icon: ArrowDownAZ },
  { value: "name-desc", label: "Name (Z → A)", icon: ArrowUpZA },
  { value: "modified", label: "Modified (newest first)", icon: Clock },
  { value: "modified-old", label: "Modified (oldest first)", icon: History },
];
const SORT_KEY = "marq.noteSort";

/** The chosen order, remembered across launches. */
function useNoteSort() {
  const [sort, setSort] = useState<NoteSort>(() => {
    try {
      const v = localStorage.getItem(SORT_KEY);
      if (NOTE_SORTS.some((s) => s.value === v)) return v as NoteSort;
    } catch {}
    return "name";
  });
  useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, sort);
    } catch {}
  }, [sort]);
  return [sort, setSort] as const;
}

/** The newest change under a folder. */
function newest(t: Tree, memo: Map<Tree, number>): number {
  let n = memo.get(t);
  if (n === undefined) {
    n = Math.max(0, ...t.files.map((f) => f.modified), ...[...t.dirs.values()].map((d) => newest(d, memo)));
    memo.set(t, n);
  }
  return n;
}

function sortTree(t: Tree, sort: NoteSort, memo = new Map<Tree, number>()) {
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  // +1 is ascending (A → Z, oldest first).
  const dir = sort === "name" || sort === "modified-old" ? 1 : -1;
  const date = sort.startsWith("modified");
  t.files.sort((a, b) => (date && dir * (a.modified - b.modified)) || dir * byName(a.rel, b.rel));
  const sorted = [...t.dirs].sort((a, b) => (date && dir * (newest(a[1], memo) - newest(b[1], memo))) || dir * byName(a[0], b[0]));
  t.dirs = new Map(sorted);
  for (const [, sub] of sorted) sortTree(sub, sort, memo);
}

/** Folders come from `dirs` too, so empty ones are shown. */
function buildTree(files: FileEntry[], dirs: string[], sort: NoteSort): Tree {
  const root: Tree = { dirs: new Map(), files: [] };
  const dirOf = (parts: string[]) => {
    let node = root;
    for (const dir of parts) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
      node = node.dirs.get(dir)!;
    }
    return node;
  };
  for (const d of dirs) dirOf(d.split("/"));
  for (const f of files) dirOf(f.rel.split("/").slice(0, -1)).files.push(f);
  sortTree(root, sort);
  return root;
}

/** How the Notes list is divided: by folder as on disk, or by what the frontmatter says, without moving a file. */
type NoteView = string;
/** The views: `folder`, `tag`, `type`, `project`, and `field:<key>` for each of the user's own keys. `none` names the group of notes without the property. */
function noteViews(keys: string[]): { value: NoteView; label: string; none: string }[] {
  return [
    { value: "folder", label: "By folder", none: "" },
    { value: "tag", label: "By tag", none: "Untagged" },
    { value: "type", label: "By type", none: "note" },
    { value: "project", label: "By project", none: "No project" },
    ...keys.map((k) => ({ value: `field:${k}`, label: `By ${k}`, none: `No ${k}` })),
  ];
}
const VIEW_KEY = "marq.noteView";

/** Where a view's groups are kept apart from folders of the same name, among the collapsed paths. */
const viewPrefix = (view: NoteView) => (view === "folder" ? "" : `@${view}:`);

/**
 * Notes under a group each instead of their folder: one per tag (a note with several is under each),
 * per type, per project or per value of one of the user's own keys. Session logs are left out (Recent lists sessions), and so are plain text
 * files where they could only land in the group for notes without the property. That group is last.
 */
function buildGroupTree(files: FileEntry[], view: NoteView, none: string, sort: NoteSort): Tree {
  const key = view.startsWith("field:") ? view.slice(6) : "";
  const root: Tree = { dirs: new Map(), files: [] };
  const add = (label: string, f: FileEntry) => {
    if (!root.dirs.has(label)) root.dirs.set(label, { dirs: new Map(), files: [] });
    root.dirs.get(label)!.files.push(f);
  };
  for (const f of files) {
    if (f.rel.startsWith("sessions/") || (f.kind === "file" && view !== "type")) continue;
    const labels = view === "tag" ? f.tags
      : view === "type" ? [f.kind ?? none]
      : key ? f.fields?.[key] ?? []
      : f.project ? [f.project.split("/").filter(Boolean).slice(-2).join("/")] : [];
    for (const l of labels.length ? labels : [none]) add(l, f);
  }
  sortTree(root, sort);
  if (view !== "type" && root.dirs.has(none)) {
    const last = root.dirs.get(none)!;
    root.dirs.delete(none);
    root.dirs.set(none, last);
  }
  return root;
}

const fileLabel = (f: FileEntry) => f.title ?? f.rel.split("/").pop()!.replace(/\.md$/, "");
/** A file name from a title: words joined by `-`, like the vault's own slugs. */
const slugOf = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";

const DRAG_TYPE = "application/x-marq-path";

type TreeProps = {
  tree: Tree;
  depth: number;
  prefix: string;
  /** Folder paths that are collapsed, for the whole tree. */
  closed: Set<string>;
  /** Toggles a folder; with `deep`, its subfolders follow it. */
  onToggle: (path: string, deep: boolean) => void;
  activePath?: string;
  onOpen: (p: string) => void;
  onNewIn: (dir: string) => void;
  onFileMenu: (e: React.MouseEvent, f: FileEntry) => void;
  onDirMenu: (e: React.MouseEvent, dir: string) => void;
  /** Moves the note or folder at `from` (relative) into folder `to` ("" for the vault root). */
  onDrop: (from: string, to: string) => void;
  /** Keyboard cursor: a folder's relative path or a file's row key. */
  cursor?: string | null;
  /** The groups are not folders: nothing can be moved into them or created in them. */
  virtual?: boolean;
};

/** A file's row: its path, or under a view's groups its group too, since a note can be under several. */
const fileRowKey = (prefix: string, path: string, virtual?: boolean) => (virtual ? `${prefix}\t${path}` : path);

/** Drop target behavior for a folder row or the tree's root. */
function useDropTarget(dir: string, onDrop: (from: string, to: string) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        const from = e.dataTransfer.getData(DRAG_TYPE);
        setOver(false);
        if (!from) return;
        e.preventDefault();
        e.stopPropagation();
        const parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
        // Dropping onto its own folder, or a folder onto itself or into its own subtree, does nothing.
        if (parent === dir || from === dir || dir.startsWith(`${from}/`)) return;
        onDrop(from, dir);
      },
    },
  };
}

function DirRow({ name, path, depth, open, count, hasActive, toggle, props }: {
  name: string; path: string; depth: number; open: boolean; count: number; hasActive: boolean; toggle: (deep: boolean) => void; props: TreeProps;
}) {
  const drop = useDropTarget(path, props.onDrop);
  if (props.virtual) {
    return (
      <a className={`tree-row dir ${hasActive ? "has-active" : ""} ${props.cursor === path ? "cursor" : ""}`} style={{ paddingLeft: indent(depth) }} onClick={() => toggle(false)}>
        <ChevronRight size={12} className={`chev ${open ? "open" : ""}`} />
        <Layers size={13} /> <span className="ellipsis">{name}</span>
        <span className="tree-count">{count}</span>
      </a>
    );
  }
  return (
    <a className={`tree-row dir ${hasActive ? "has-active" : ""} ${drop.over ? "drop" : ""} ${props.cursor === path ? "cursor" : ""}`} style={{ paddingLeft: indent(depth) }} onClick={(e) => toggle(e.altKey)}
      draggable onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, path); e.dataTransfer.effectAllowed = "move"; }}
      title="⌥-click to open or close its subfolders too"
      onContextMenu={(e) => props.onDirMenu(e, path)} {...drop.props}>
      <ChevronRight size={12} className={`chev ${open ? "open" : ""}`} />
      {open ? <FolderOpen size={13} /> : <Folder size={13} />} <span className="ellipsis">{name}</span>
      <span className="tree-count">{count}</span>
      <button className="tree-add" title={`New note in ${path}/`}
        onClick={(e) => { e.stopPropagation(); props.onNewIn(`${path}/`); }}>
        <Plus size={12} />
      </button>
    </a>
  );
}

const INDENT = 14;
const indent = (depth: number) => 8 + depth * INDENT;

/** Whether `path` is one of the files somewhere under `tree`. */
function containsPath(tree: Tree, path?: string | null): boolean {
  if (!path) return false;
  return tree.files.some((f) => f.path === path) || [...tree.dirs.values()].some((t) => containsPath(t, path));
}

/** How many notes are somewhere under `tree`. */
function countFiles(tree: Tree): number {
  return tree.files.length + [...tree.dirs.values()].reduce((n, t) => n + countFiles(t), 0);
}

/** An icon for notes with a special kind; plain notes get none. */
function fileIcon(f: FileEntry) {
  if (f.rel.startsWith("sessions/")) return <MessageSquare size={13} />;
  if (f.kind === "request") return <Inbox size={13} />;
  if (f.kind === "scratch") return <StickyNote size={13} />;
  if (f.rel === "instructions.md") return <ScrollText size={13} />;
  if (f.kind === "glossary") return <BookA size={13} />;
  if (f.kind === "knowledge") return <Lightbulb size={13} />;
  if (f.kind === "spec") return <ClipboardList size={13} />;
  if (f.kind === "playbook") return <ListOrdered size={13} />;
  if (f.kind === "workspace") return <FolderGit2 size={13} />;
  if (f.kind === "environment") return <Server size={13} />;
  if (f.kind === "schedule") return <Timer size={13} />;
  if (f.kind === "board") return <Columns3 size={13} />;
  if (f.kind === "query") return <Braces size={13} />;
  return null;
}

function TreeView(props: TreeProps) {
  const { tree, depth, prefix, activePath, onOpen, onFileMenu, closed, onToggle } = props;
  return (
    <>
      {[...tree.dirs.entries()].map(([name, sub]) => {
        const path = `${prefix}${name}`;
        return (
          <div key={name}>
            <DirRow name={name} path={path} depth={depth} open={!closed.has(path)} count={countFiles(sub)}
              hasActive={containsPath(sub, activePath)} toggle={(deep) => onToggle(path, deep)} props={props} />
            {!closed.has(path) && (
              <div className={`tree-children ${containsPath(sub, activePath) ? "active" : ""}`}
                style={{ "--guide": `${indent(depth) + 6}px` } as React.CSSProperties}>
                <TreeView {...props} tree={sub} depth={depth + 1} prefix={`${path}/`} />
              </div>
            )}
          </div>
        );
      })}
      {tree.files.map((f) => (
        <a key={f.path} className={`tree-row ${activePath === f.path ? "on" : ""} ${props.cursor === fileRowKey(prefix, f.path, props.virtual) ? "cursor" : ""}`}
          style={{ paddingLeft: indent(depth) }} onClick={() => onOpen(f.path)} title={f.rel}
          draggable={!props.virtual && !f.rel.startsWith("sessions/")}
          onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, f.rel); e.dataTransfer.effectAllowed = "move"; }}
          onContextMenu={(e) => onFileMenu(e, f)}>
          <span className="chev-slot" />
          <span className="icon-slot">{fileIcon(f)}</span>
          <span className="ellipsis">{fileLabel(f)}</span>
          {f.status && (f.kind === "request" || (f.kind === "knowledge" && f.status === "draft")) && <span className={`dot status-${f.status}`} title={f.status} />}
        </a>
      ))}
    </>
  );
}

/** The whole tree, with the empty area below it as a drop target for the vault root. */
/** Every folder path in the tree. */
function dirPaths(tree: Tree, prefix = ""): string[] {
  return [...tree.dirs.entries()].flatMap(([name, sub]) => [`${prefix}${name}`, ...dirPaths(sub, `${prefix}${name}/`)]);
}

const CLOSED_KEY = "marq.closedDirs";

/** Collapsed folders, remembered across launches. `sessions` starts collapsed. */
function useClosedDirs() {
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      const v = localStorage.getItem(CLOSED_KEY);
      if (v) return new Set(JSON.parse(v));
    } catch {}
    return new Set(["sessions"]);
  });
  useEffect(() => {
    try {
      localStorage.setItem(CLOSED_KEY, JSON.stringify([...closed]));
    } catch {}
  }, [closed]);
  return [closed, setClosed] as const;
}

type Row = { key: string; dir: boolean; parent: string | null; /** A file's path. */ path?: string };

/** Rows in display order, skipping collapsed folders' contents. */
function visibleRows(tree: Tree, closed: Set<string>, virtual: boolean, prefix = "", parent: string | null = null): Row[] {
  const out: Row[] = [];
  for (const [name, sub] of tree.dirs) {
    const path = `${prefix}${name}`;
    out.push({ key: path, dir: true, parent });
    if (!closed.has(path)) out.push(...visibleRows(sub, closed, virtual, `${path}/`, path));
  }
  for (const f of tree.files) out.push({ key: fileRowKey(prefix, f.path, virtual), dir: false, parent, path: f.path });
  return out;
}

const NotesTree = forwardRef<HTMLDivElement, Omit<TreeProps, "depth"> & { onBlur: () => void }>(function NotesTree(
  { onBlur, ...props },
  ref,
) {
  const drop = useDropTarget("", props.onDrop);
  return (
    <div ref={ref} tabIndex={-1} onBlur={onBlur} className={`notes-tree ${!props.virtual && drop.over ? "drop" : ""}`} {...(props.virtual ? {} : drop.props)}>
      <TreeView {...props} depth={0} />
    </div>
  );
});

const GROUPS = [
  // Finished sessions with changes that nobody has marked done or turned into a PR yet.
  { key: "review", label: "Needs review", match: (s: SessionInfo) =>
      s.status !== "running" && !s.review && (s.additions ?? 0) + (s.deletions ?? 0) > 0 },
];

/**
 * `active`: every running session and every one that needs the user, those waiting first.
 * The rest is `recent`.
 */
function groupSessions(sessions: SessionInfo[]) {
  const active = sessions.filter((s) => s.status === "waiting" || s.status === "running")
    .sort((a, b) => Number(b.status === "waiting") - Number(a.status === "waiting"));
  const used = new Set(active.map((s) => s.id));
  const groups = GROUPS.map((g) => {
    const items = sessions.filter((s) => !used.has(s.id) && g.match(s));
    items.forEach((s) => used.add(s.id));
    return { ...g, items };
  }).filter((g) => g.items.length);
  return { active, groups, recent: sessions.filter((s) => !used.has(s.id)) };
}

/** `every 1h · 14:30`, `daily 09:00 · tomorrow`: how often and when next. */
function scheduleLabel(s: Schedule) {
  if (!s.enabled) return "paused";
  const how = s.at ? `daily ${s.at}` : `every ${s.every ?? "?"}`;
  if (!s.next_run) return how;
  const next = new Date(s.next_run);
  const today = new Date().toDateString() === next.toDateString();
  const time = next.toTimeString().slice(0, 5);
  return `${how} · ${next <= new Date() ? "now" : today ? time : `${next.getMonth() + 1}/${next.getDate()} ${time}`}`;
}

/** `5m`, `3h`, `2d`; the date after a month. */
function ago(iso: string) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  if (m < 60 * 24 * 30) return `${Math.round(m / 60 / 24)}d`;
  return iso.slice(5, 10);
}

function storedFlag(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function storedList(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
}

/** An open/closed state remembered per sidebar section. */
function useSectionOpen(key: string, defaultOpen = true) {
  const storage = `marq.section.${key}`;
  const [open, setOpen] = useState(() => storedFlag(storage, defaultOpen));
  const set = (v: boolean) => {
    setOpen(v);
    const flag = v ? "1" : "0";
    try {
      localStorage.setItem(storage, flag);
    } catch {}
  };
  return [open, set] as const;
}

/** Past this a section is not capped: it is as tall as its rows. */
const UNCAPPED = 4000;

/** The icon-only sidebar: `panel` is the list open over the content, null while all are closed. */
const RailContext = createContext<{ rail: boolean; panel: string | null }>({ rail: false, panel: null });

/** Queued schedules, follow-ups and cards come back at once if dismissed (move a card out of its queue list instead), so only the rest can be. */
function dismissable(e: InboxEvent) {
  return e.status === "failed" || (e.status === "pending" && e.kind !== "schedule" && e.kind !== "followup" && e.kind !== "card");
}

function Collapsible({ title, icon, count, children, defaultOpen = true, action, size, fill, panel }: {
  /** Which icon of the icon-only sidebar opens this section. */
  panel?: string;
  title: string; icon?: React.ReactNode; count?: number; children: React.ReactNode; defaultOpen?: boolean;
  /** Takes the sidebar's remaining height and scrolls on its own, instead of having a handle. */
  fill?: boolean;
  /** A button shown at the right of the title. */
  action?: React.ReactNode;
  /** Where its height is remembered and how tall it starts; by default it is keyed by title and as tall as its rows. */
  size?: { key: string; initial: number };
}) {
  const [openState, setOpen] = useSectionOpen(title, defaultOpen);
  const rail = useContext(RailContext);
  // Over the content only the chosen list shows, and it is open whatever it was in the full sidebar.
  const open = rail.rail || openState;
  const away = rail.rail && !!panel && rail.panel !== panel;
  // Dragging the handle under a section caps its height, and its rows scroll; double-click lifts the cap again.
  const height = usePaneSize(size?.key ?? `section.${title}`, size?.initial ?? UNCAPPED, 40, UNCAPPED);
  const body = useRef<HTMLDivElement>(null);
  // Once dragged the height is fixed, so a section can also be made taller than its rows;
  // until then a starting size only caps it.
  const sectionStyle = fill || height.size >= UNCAPPED ? undefined
    : height.touched ? { height: height.size } : { maxHeight: height.size };
  return (
    <div className={`section ${fill ? "fill" : ""} ${open ? "" : "closed"} ${away ? "rail-away" : ""}`}>
      <a className="section-title" onClick={() => !rail.rail && setOpen(!open)}>
        <ChevronRight size={11} className={`chev ${open ? "open" : ""}`} /> {icon} {title}
        {count !== undefined && count > 0 && <span className="count">{count}</span>}
        {action && <span className="section-actions" onClick={(e) => e.stopPropagation()}>{action}</span>}
      </a>
      {open && (
        <>
          <div ref={body} className="section-body" style={sectionStyle}>{children}</div>
          {!fill && <Resizer axis="y" sign={1} pane={height} measure={() => body.current?.offsetHeight ?? height.size}
            preview={(v) => body.current && Object.assign(body.current.style, { height: v < UNCAPPED ? `${v}px` : "", maxHeight: "" })} />}
        </>
      )}
    </div>
  );
}

/**
 * A tab's content. Hidden tabs keep running (their own streams and listeners update them), but the app's
 * re-renders skip them until they are shown again or their tab changes: with many tabs open, every
 * sidebar refresh or tab switch would otherwise re-render all of them.
 */
const TabPane = memo(
  function TabPane({ active, slot, focused, onFocus, children }: {
    tab: Tab; vault: string; active: boolean;
    /** With the screen split: 0 for the left or top pane, 1 for the other. */
    slot?: 0 | 1; focused?: boolean; onFocus?: () => void;
    children: React.ReactNode;
  }) {
    return (
      <div className={`pane-inner ${slot !== undefined ? `slot-${slot}` : ""} ${focused ? "focused" : ""}`} tabIndex={-1} hidden={!active}
        onMouseDownCapture={focused ? undefined : onFocus}>
        <TabErrorBoundary>{children}</TabErrorBoundary>
      </div>
    );
  },
  (a, b) => !a.active && !b.active && a.tab === b.tab && a.vault === b.vault,
);

/** A state update that keeps the previous value when the new one has the same contents. */
const same = <T,>(next: T) => (prev: T) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next);

const parentOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

export default function App() {
  const [vault, setVault] = useState<string | null>(loadVault);
  const [files, setFiles] = useState<FileEntry[]>([]);
  // The preview and editor resolve [[links]] against these.
  useEffect(() => setVaultFiles(files), [files]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [newSchedule, setNewSchedule] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>(() => loadTabs(vault).tabs);
  const [active, setActive] = useState<string | null>(() => loadTabs(vault).active);
  const [split, setSplit] = useState<Split | null>(() => loadTabs(vault).split);
  // Restored note and board tabs are checked against the vault's files once they are listed.
  const pruneTabs = useRef<string | null>(vault);
  const [filesVault, setFilesVault] = useState<string | null>(null);
  useEffect(() => {
    if (!vault) return;
    try {
      localStorage.setItem(tabsKey(vault), JSON.stringify({ tabs, active, split }));
    } catch {}
  }, [vault, tabs, active, split]);
  // Showing the tab in the other pane moves the focus there; the panes keep their tabs.
  const prevActive = useRef(active);
  useLayoutEffect(() => {
    const prev = prevActive.current;
    prevActive.current = active;
    if (split && active === split.other) {
      setSplit(prev && prev !== active && tabs.some((t) => t.key === prev) ? { ...split, other: prev, side: split.side ? 0 : 1 } : null);
    }
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  // The split ends when the other pane's tab goes.
  useEffect(() => {
    if (split && !tabs.some((t) => t.key === split.other)) setSplit(null);
  }, [tabs, split]);
  const splitSize = usePaneSize("tabSplit", 500, 150, 850);
  const paneRef = useRef<HTMLElement>(null);
  // Which way the screen was last split, for the next time.
  const [splitDir, setSplitDir] = useState<Split["dir"]>(() => (storedFlag("marq.splitColumn", false) ? "column" : "row"));
  const setDir = (dir: Split["dir"]) => {
    setSplitDir(dir);
    setSplit((s) => (s ? { ...s, dir } : s));
    const flag = dir === "column" ? "1" : "0";
    try { localStorage.setItem("marq.splitColumn", flag); } catch {}
  };
  /** Shows `key` in the other pane, focused. The tab shown is kept next to it. */
  const openToSide = (key: string) => {
    if (split && (key === active || key === split.other)) return setActive(key);
    if (key === active) {
      const i = tabs.findIndex((t) => t.key === key);
      const other = (tabs[i - 1] ?? tabs[i + 1])?.key;
      if (other) setSplit({ other, dir: splitDir, side: 1 });
      return;
    }
    if (!active) return setActive(key);
    setSplit({ other: active, dir: splitDir, side: split ? (split.side ? 0 : 1) : 1 });
    prevActive.current = key;
    setActive(key);
  };
  // ⌥-click on anything that opens a tab opens it to the side.
  const sideClick = useRef(0);
  useEffect(() => {
    const on = (e: MouseEvent) => { sideClick.current = e.altKey ? performance.now() : 0; };
    window.addEventListener("click", on, true);
    return () => window.removeEventListener("click", on, true);
  }, []);

  const [showNewTask, setShowNewTask] = useState(false);
  const [taskPrompt, setTaskPrompt] = useState("");
  const [taskReview, setTaskReview] = useState<"on" | "off" | undefined>();
  // Runs once the task started from a card has begun, to move the card.
  const taskAfter = useRef<(() => void) | null>(null);
  // mq results the New task dialog hands to the agent, from a Run agent button.
  const [taskContext, setTaskContext] = useState<QueryContext | null>(null);
  const [sending, setSending] = useState<{ excerpt: Excerpt; exclude?: string } | null>(null);
  const sidebar = usePaneSize("sidebar", 300, 200, 600);
  const sidebarRef = useRef<HTMLElement>(null);
  // Hidden with ⌘B; remembered across launches.
  const [sidebarOpen, setSidebarOpenState] = useState(() => storedFlag("marq.sidebar", true));
  const setSidebarOpen = (v: boolean) => {
    setSidebarOpenState(v);
    const flag = v ? "1" : "0";
    try {
      localStorage.setItem("marq.sidebar", flag);
    } catch {}
  };
  const [naming, setNaming] = useState<{ kind: "note" | "spec" | "workspace" | "playbook"; initial: string } | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  // New folder, rename and move share one name dialog.
  const [pathDialog, setPathDialog] = useState<{ mode: "folder" | "rename" | "move" | "keep"; from?: string; initial: string } | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [deleting, setDeleting] = useState<SessionInfo | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [theme, setTheme, themeFromConfig] = useTheme();
  // Pinned tabs get a row of their own above the others, or lead the one row.
  const settingsNow = useSettings();
  const tabSettings = settingsNow.tabs;
  // Icons only: one icon opens its list over the content (`railPanel`), closed with Esc, a click outside or a pick.
  const railOn = settingsNow.appearance?.sidebar === "rail";
  const [railPanel, setRailPanel] = useState<string | null>(null);
  const setSidebarMode = (mode: "full" | "rail") => {
    setRailPanel(null);
    api.writeConfig({ "appearance.sidebar": mode === "rail" ? "rail" : null })
      .then(() => setSettings({ ...getSettings(), appearance: { ...getSettings().appearance, sidebar: mode === "rail" ? "rail" : undefined } }))
      .catch((e) => void message(String(e), { kind: "error" }));
  };
  const pinnedRow = tabSettings?.pinned_layout === "row";
  // Tabs that do not fit flow onto more rows, or scroll with a count of those out of sight.
  const wrapTabs = tabSettings?.overflow === "wrap";
  const themeMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        ...PALETTES.map((p): MenuItem => ({
          label: p.label, icon: theme.palette === p.key ? Check : Palette, onClick: () => setTheme({ ...theme, palette: p.key }),
        })),
        "separator",
        ...([["system", "System", Monitor], ["light", "Light", Sun], ["dark", "Dark", Moon]] as const).map(([mode, label, icon]): MenuItem => ({
          label, icon: theme.mode === mode ? Check : icon, onClick: () => setTheme({ ...theme, mode }),
        })),
      ],
    });
  };

  // Files only; the session list is much slower.
  const refreshFiles = useCallback(async () => {
    if (!vault) return;
    const [fs, ds, sc] = await Promise.all([api.listFiles(vault), api.listDirs(vault), api.schedulesList(vault)]);
    // Unchanged lists keep their identity, so nothing that takes them renders again for nothing.
    setFiles(same(fs));
    setFilesVault(vault);
    setDirs(same(ds));
    setSchedules(same(sc));
  }, [vault]);


  // Schedules and the inbox run for the open vault, and only while Marq runs.
  useEffect(() => {
    if (vault) api.automationWatch(vault).catch(() => {});
  }, [vault]);

  const refresh = useCallback(async () => {
    if (!vault) return;
    await refreshFiles();
    const [list, approvals] = await Promise.all([api.listSessions(vault), api.listApprovals()]);
    const waiting = new Set(approvals.map((a) => a.session_id));
    setSessions(same(list.map((s) => (waiting.has(s.id) ? { ...s, status: "waiting" } : s))));
  }, [vault, refreshFiles]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    // Coalesce bursts of events into one refresh.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    };
    const uns = ["session://exit", "session://turn", "session://approval", "vault://changed", "sessions://changed"].map((ev) => listen(ev, soon));
    return () => {
      clearTimeout(timer);
      uns.forEach((u) => u.then((f) => f()));
    };
  }, [refresh]);

  // Sessions the schedules and the inbox start on their own.
  useEffect(() => {
    const un = listen<{ session_id: string; title: string; from: string }>("automation://started", (e) => {
      void notify(`Started: ${e.payload.title}`, `From ${e.payload.from}`);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // ---- inbox: what waits for you ----
  const [inboxEvents, setInboxEvents] = useState<InboxEvent[]>([]);
  const loadInbox = useCallback(() => {
    if (vault) api.inboxList(vault).then(setInboxEvents).catch(() => {});
  }, [vault]);
  useEffect(() => {
    loadInbox();
    const un = listen("inbox://changed", loadInbox);
    return () => {
      un.then((f) => f());
    };
  }, [loadInbox]);

  // ---- notifications and unread results ----
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const watch = useRef({ sessions, active });
  useLayoutEffect(() => {
    watch.current = { sessions, active };
  });
  useEffect(() => {
    // A session counts as seen while its tab is open in a focused window.
    const attention = (id: string, body: string, markUnread: boolean) => {
      if (document.hasFocus() && watch.current.active === `session:${id}`) return;
      if (markUnread) setUnread((u) => new Set(u).add(id));
      void notify(watch.current.sessions.find((x) => x.id === id)?.title ?? "Marq", body);
    };
    const uns = [
      listen<{ session_id: string; result?: string }>("session://turn", (e) => {
        attention(e.payload.session_id, summary(e.payload.result ?? "") || "Finished", true);
      }),
      listen<{ session_id: string; status: string; stderr?: string }>("session://exit", (e) => {
        const why = summary(e.payload.stderr?.trim().split("\n").pop() ?? "", 140);
        if (e.payload.status === "error") attention(e.payload.session_id, `Stopped with an error${why ? `: ${why}` : ""}`, true);
      }),
      listen<{ session_id: string; tool_name?: string; title?: string; input?: Record<string, unknown>; answered?: boolean }>("session://approval", (e) => {
        if (e.payload.answered) return;
        const { tool_name, title, input } = e.payload;
        // What it wants to do: the SDK's title, else the command, file or URL.
        const what = title ?? [input?.command, input?.file_path, input?.url].find((x) => typeof x === "string") as string | undefined;
        attention(e.payload.session_id, `Needs your approval${tool_name ? ` · ${tool_name}` : ""}${what ? `\n${summary(what, 140)}` : ""}`, false);
      }),
    ];
    return () => uns.forEach((u) => u.then((f) => f()));
  }, []);
  useEffect(() => {
    const clear = () => {
      if (!document.hasFocus() || !active?.startsWith("session:")) return;
      const id = active.slice("session:".length);
      setUnread((u) => (u.has(id) ? new Set([...u].filter((x) => x !== id)) : u));
    };
    clear();
    window.addEventListener("focus", clear);
    return () => window.removeEventListener("focus", clear);
  }, [active]);
  // The Dock badge counts what is waiting for you.
  useEffect(() => {
    const n = unread.size + sessions.filter((s) => s.status === "waiting").length;
    getCurrentWindow().setBadgeCount(n || undefined).catch(() => {});
  }, [unread, sessions]);

  const [noteSort, setNoteSort] = useNoteSort();
  // Requests waiting to run, and knowledge notes an agent wrote that nobody has checked yet.
  const inboxFiles = useMemo(() => files.filter((f) =>
    (f.kind === "request" && f.status === "todo") || (f.kind === "knowledge" && f.status === "draft")), [files]);
  // Done and dismissed events are history; queued, running and failed ones are still open.
  // A result or error of a session that was marked done or deleted needs nothing more.
  const openEvents = useMemo(() => inboxEvents.filter((e) => {
    if (e.status !== "pending" && e.status !== "running" && e.status !== "failed") return false;
    // A finished turn is not an inbox item: Needs review lists what there is to check.
    if (e.kind === "result") return false;
    if (e.kind !== "error") return true;
    const s = sessions.find((x) => x.id === e.session_id);
    return sessions.length === 0 || (!!s && !s.review);
  }), [inboxEvents, sessions]);
  // Requests already queued show as their event, not twice.
  const waitingFiles = useMemo(() => inboxFiles.filter((f) => !openEvents.some((e) => e.kind === "request" && e.source === f.path)), [inboxFiles, openEvents]);
  const inboxCount = openEvents.length + waitingFiles.length;
  const ownKeys = organizeKeys(settingsNow);
  const views = noteViews(ownKeys);
  const [noteViewState, setNoteViewState] = useState<NoteView>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) ?? "folder";
    } catch {
      return "folder";
    }
  });
  // A view of a key that is no longer in the settings falls back to folders.
  const noteView = views.some((v) => v.value === noteViewState) ? noteViewState : "folder";
  const setNoteView = (v: NoteView) => {
    setNoteViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch { /* not remembered */ }
  };
  const treePrefix = viewPrefix(noteView);
  const viewNone = views.find((v) => v.value === noteView)?.none ?? "";
  const tree = useMemo(() => (noteView === "folder" ? buildTree(files, dirs, noteSort) : buildGroupTree(files, noteView, viewNone, noteSort)), [files, dirs, noteSort, noteView, viewNone]);
  // Newest first: their names are the time they were made.
  // Untitled notes are named by what they say, so their tabs follow as the text changes.
  useEffect(() => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.kind !== "note") return t;
        const f = files.find((x) => x.path === t.path);
        const title = f && fileLabel(f);
        if (!title || title === t.title) return t;
        changed = true;
        return { ...t, title };
      });
      return changed ? next : prev;
    });
  }, [files]);
  const boards = useMemo(() => files.filter((f) => f.kind === "board"), [files]);
  const [newBoard, setNewBoard] = useState(false);
  // Workspaces with how many sessions ran on each.
  const workspaces = useMemo(() => files.filter((f) => f.kind === "workspace").map((f) => ({ f, count: sessions.filter((s) => namesWorkspace(s.workspace, f)).length })), [files, sessions]);
  const [closedDirs, setClosedDirs] = useClosedDirs();
  const allDirs = useMemo(() => dirPaths(tree, treePrefix), [tree, treePrefix]);

  // Reveal the open note in the tree, once it is listed.
  const activeTab = tabs.find((t) => t.key === active);
  const activeNote = activeTab?.kind === "note" ? activeTab.path : undefined;

  // Notes and boards opened recently, for ⌘P.
  const [recentFiles, setRecentFiles] = useState<string[]>(() => storedList("marq.recentFiles"));
  const activeFile = activeTab?.kind === "note" || activeTab?.kind === "board" ? activeTab.path : undefined;
  useEffect(() => {
    if (!activeFile) return;
    setRecentFiles((r) => {
      const next = [activeFile, ...r.filter((p) => p !== activeFile)].slice(0, 20);
      try {
        localStorage.setItem("marq.recentFiles", JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [activeFile]);
  // Once per note, so folding afterwards sticks.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!activeNote || !vault || !activeNote.startsWith(`${vault}/`)) return;
    if (revealed.current === activeNote || !files.some((f) => f.path === activeNote)) return;
    revealed.current = activeNote;
    const parts = activeNote.slice(vault.length + 1).split("/").slice(0, -1);
    const ancestors = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    setClosedDirs((s) => (ancestors.some((d) => s.has(d)) ? new Set([...s].filter((d) => !ancestors.includes(d))) : s));
    requestAnimationFrame(() => document.querySelector(".notes-tree .tree-row.on")?.scrollIntoView({ block: "nearest" }));
  }, [activeNote, vault, files, setClosedDirs]);
  const toggleDir = (path: string, deep: boolean) =>
    setClosedDirs((s) => {
      const n = new Set(s);
      const close = !n.has(path);
      for (const d of deep ? allDirs.filter((d) => d === path || d.startsWith(`${path}/`)) : [path]) {
        if (close) n.add(d);
        else n.delete(d);
      }
      return n;
    });

  // Restored tabs on notes deleted or moved while the vault was closed.
  useEffect(() => {
    if (!vault || pruneTabs.current !== vault || filesVault !== vault) return;
    pruneTabs.current = null;
    const exists = new Set(files.map((f) => f.path));
    // Files outside the vault are not in the list; opening them again reports a missing file.
    const keep = tabs.filter((t) => !((t.kind === "note" || t.kind === "board") && t.path.startsWith(`${vault}/`) && !exists.has(t.path)));
    if (keep.length === tabs.length) return;
    setTabs(keep);
    if (!keep.some((t) => t.key === active)) setActive(keep[keep.length - 1]?.key ?? null);
  }, [vault, files, filesVault, tabs, active]);

  // Keep open tabs on notes that moved.
  useEffect(() => {
    const un = listen<{ from: string; to: string }[]>("vault://moved", (e) => {
      const to = new Map(e.payload.map((m) => [m.from, m.to]));
      setTabs((prev) =>
        prev.map((t) => (t.kind === "note" && to.has(t.path) ? { ...t, path: to.get(t.path)!, key: `note:${to.get(t.path)}` } : t)),
      );
      setActive((a) => (a?.startsWith("note:") && to.has(a.slice(5)) ? `note:${to.get(a.slice(5))}` : a));
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const move = async (from: string, to: string) => {
    try {
      const r = await api.movePath(vault!, from, to);
      await refresh();
      return r;
    } catch (err) {
      await message(String(err), { title: "Could not move", kind: "error" });
    }
  };
  const { active: activeSessions, groups, recent } = useMemo(() => groupSessions(sessions), [sessions]);
  // Active sessions under their project, the one with something waiting for you first.
  const activeByProject = useMemo(() => {
    const by = new Map<string, SessionInfo[]>();
    for (const s of activeSessions) {
      const name = projectName(s);
      by.set(name, [...(by.get(name) ?? []), s]);
    }
    return [...by.entries()];
  }, [activeSessions]);
  const recentHeight = usePaneSize("recent", 180, 60, 600);
  const recentRef = useRef<HTMLDivElement>(null);
  const [recentOpen, setRecentOpen] = useSectionOpen("Recent");
  // Recent can be narrowed by typing and divided by date, project or workspace.
  const [recentFilter, setRecentFilter] = useState<string | null>(null);
  const groupChoices = recentGroups(ownKeys);
  const [recentGroupState, setRecentGroupState] = useState<RecentGroup>(() => {
    try {
      return localStorage.getItem("marq.recent.group") ?? "none";
    } catch {
      return "none";
    }
  });
  const recentGroup = groupChoices.some((g) => g.value === recentGroupState) ? recentGroupState : "none";
  const setRecentGroup = (g: RecentGroup) => {
    setRecentGroupState(g);
    try {
      localStorage.setItem("marq.recent.group", g);
    } catch { /* not remembered */ }
  };
  // Unfiltered, only the newest are listed; a filter reaches every session.
  const recentShown = useMemo(() => {
    const q = recentFilter?.trim() ?? "";
    const found = filterSessions(recent, q, files);
    const shown = found.slice(0, q ? 300 : 100);
    return { groups: groupRecent(shown, recentGroup, files), found: found.length, hidden: found.length - shown.length, filtered: !!q };
  }, [recent, recentFilter, recentGroup, files]);

  // A session got a new title (named from its prompt, or renamed): its tab follows.
  useEffect(() => {
    const un = listen<{ session_id: string; title: string }>("sessions://renamed", (e) => {
      setTabs((prev) => prev.map((t) => (t.kind === "session" && t.id === e.payload.session_id ? { ...t, title: e.payload.title } : t)));
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const switchVault = (dir: string) => {
    try {
      localStorage.setItem(VAULT_KEY, dir);
      localStorage.setItem(RECENT_KEY, JSON.stringify([dir, ...loadRecentVaults().filter((v) => v !== dir)].slice(0, 8)));
    } catch {}
    if (dir === vault) return;
    const saved = loadTabs(dir);
    setVault(dir);
    setTabs(saved.tabs);
    setActive(saved.active);
    setSplit(saved.split);
    prevActive.current = saved.active;
    pruneTabs.current = dir;
  };

  const pickVault = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") switchVault(dir);
  };

  const vaultMenu = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const recent = [vault!, ...loadRecentVaults().filter((v) => v !== vault)];
    setMenu({
      x: r.left + 8,
      y: r.bottom,
      items: [
        ...recent.map((dir): MenuItem => ({
          label: dir.replace(/^\/Users\/[^/]+/, "~"), icon: dir === vault ? Check : FolderOpen, onClick: () => switchVault(dir),
        })),
        "separator",
        { label: "Open another folder…", icon: FolderInput, onClick: pickVault },
      ],
    });
  };

  /** Runs an open as if it were ⌥-clicked: the tab it opens goes to the side. */
  const beside = (open: () => void) => {
    sideClick.current = performance.now();
    open();
  };

  const openTab = (tab: Tab) => {
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.key === tab.key);
      if (i < 0) return [...prev, tab];
      const next = [...prev];
      next[i] = { ...prev[i], ...tab } as Tab;
      return next;
    });
    if (performance.now() - sideClick.current < 500) {
      sideClick.current = 0;
      openToSide(tab.key);
    } else setActive(tab.key);
  };

  /** `fresh`: just created, open in the editor. */
  const openNote = (path: string, line?: number, fresh = false) => {
    const f = files.find((x) => x.path === path);
    openTab({
      key: `note:${path}`,
      kind: "note",
      path,
      title: f ? fileLabel(f) : path.split("/").pop()!.replace(/\.md$/, ""),
      jump: line === undefined ? undefined : { line, nonce: Date.now() },
      ...(fresh ? { fresh } : {}),
    });
  };

  const openSearch = (initial: string) =>
    openTab({ key: "search", kind: "search", title: "Search", initial, nonce: Date.now() });

  const openBoard = (path: string) =>
    openTab({ key: `board:${path}`, kind: "board", path, title: path.split("/").pop()!.replace(/\.md$/, "") });
  /** Boards open as boards; everything else as a note. */
  /** Any text file, from a dialog: one outside the vault is edited in place. */
  const openAnyFile = async () => {
    const picked = await open({ multiple: false, directory: false });
    if (typeof picked === "string") openNote(picked);
  };
  const openFile = (path: string) => (files.find((f) => f.path === path)?.kind === "board" ? openBoard(path) : openNote(path));

  const openTerminal = (cwd: string, title?: string, command?: string) => {
    const id = crypto.randomUUID();
    openTab({ key: `terminal:${id}`, kind: "terminal", id, cwd, command, title: title ?? cwd.split("/").pop() ?? "Terminal" });
  };

  // Other views (e.g. the Changes panel) ask for a terminal with this event.
  useEffect(() => {
    const on = (e: Event) => {
      const { cwd, title } = (e as CustomEvent<{ cwd: string; title?: string }>).detail;
      openTerminal(cwd, title);
    };
    window.addEventListener("marq:terminal", on);
    return () => window.removeEventListener("marq:terminal", on);
  });

  // A tag clicked in a note's properties searches for it.
  useEffect(() => {
    const on = (e: Event) => openSearch((e as CustomEvent<string>).detail);
    window.addEventListener("marq:search", on);
    return () => window.removeEventListener("marq:search", on);
  });
  useEffect(() => {
    const on = (e: Event) => { setTaskContext((e as CustomEvent<QueryContext>).detail); setShowNewTask(true); };
    window.addEventListener(RUN_AGENT_EVENT, on);
    return () => window.removeEventListener(RUN_AGENT_EVENT, on);
  }, []);

  const openSession = (id: string, title: string) => {
    openTab({ key: `session:${id}`, kind: "session", id, title });
    // Looking at a session handles what it had waiting, except an approval, which needs an answer.
    if (inboxEvents.some((e) => e.session_id === id && e.kind !== "approval")) {
      api.inboxResolve({ sessionId: id }).catch(() => {});
    }
    refresh();
  };

  // The active session after the one shown, so repeated clicks go through them all.
  const nextActive = () => {
    if (!activeSessions.length) return;
    const at = activeSessions.findIndex((s) => active === `session:${s.id}`);
    const s = activeSessions[(at + 1) % activeSessions.length];
    openSession(s.id, s.title);
  };

  const runSchedule = (s: Schedule) =>
    api.scheduleRun(vault!, s.path).then(
      (id) => (id ? openSession(id, s.title ?? s.rel) : void message("The schedule's query found nothing, so no session was started.")),
      (e) => void message(String(e), { kind: "error" }),
    );

  const openCompare = (ids: string[], title: string) => {
    openTab({ key: `compare:${ids.slice().sort().join(",")}`, kind: "compare", ids, title: `Compare: ${title}` });
    refresh();
  };


  /** Pinned tabs move to the end of the pinned ones; unpinned ones to the start of the rest. */
  const togglePin = (key: string) => {
    setTabs((prev) => {
      const t = prev.find((x) => x.key === key);
      if (!t) return prev;
      const moved = { ...t, pinned: !t.pinned };
      const rest = prev.filter((x) => x.key !== key);
      const at = rest.filter((x) => x.pinned).length;
      return [...rest.slice(0, at), moved, ...rest.slice(at)];
    });
  };

  /** Puts `key` where `target` is; crossing into or out of the pinned group pins or unpins it. */
  const moveTab = (key: string, target: string) => {
    if (key === target) return;
    setTabs((prev) => {
      const from = prev.findIndex((x) => x.key === key);
      const to = prev.findIndex((x) => x.key === target);
      if (from < 0 || to < 0) return prev;
      const next = prev.slice();
      next.splice(from, 1);
      next.splice(to, 0, { ...prev[from], pinned: prev[to].pinned });
      return next;
    });
  };
  const [dragTab, setDragTab] = useState<string | null>(null);

  const closeTab = (key: string) => {
    const closing = tabs.find((t) => t.key === key);
    // An untitled note or memo closed with nothing in it is not kept. After the editor's save on close lands.
    if (closing?.kind === "note" && vault) {
      const v = vault;
      setTimeout(() => api.discardUntitled(v, closing.path).then((gone) => { if (gone) void refreshFiles(); }).catch(() => {}), 1000);
    }
    // Closing a tab in the split leaves the other one on its own.
    if (split && key === active) {
      setSplit(null);
      setTabs((prev) => prev.filter((t) => t.key !== key));
      setActive(split.other);
      return;
    }
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      if (active === key) setActive(next[next.length - 1]?.key ?? null);
      return next;
    });
  };

  /** ⌥⌘N / ⇧⌘M: a note or scratch memo without a name, open for typing. Its title comes from what you write. */
  const createUntitled = async (scratch: boolean) => {
    const path = await api.createUntitled(vault!, scratch);
    await refreshFiles();
    openNote(path, undefined, true);
  };

  // Empty untitled notes left behind, and scratch memos past `[scratch] keep_days`, once per vault.
  useEffect(() => {
    if (vault) api.sweepScratch(vault).then((r) => { if (r.removed.length || r.trashed.length) void refreshFiles(); }).catch(() => {});
  }, [vault]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (rel: string) => {
    const path = await api.createNote(vault!, rel, "note");
    openNote(path, undefined, true);
    refreshFiles();
    return path;
  };

  const createNamed = async (kind: "note" | "spec" | "workspace" | "playbook", name: string) => {
    if (kind === "spec" || kind === "workspace" || kind === "playbook") {
      const path = kind === "spec" ? await api.newSpec(vault!, name) : kind === "playbook" ? await api.newPlaybook(vault!, name) : await api.createWorkspace(vault!, name, "", []);
      openNote(path, undefined, true);
      refreshFiles();
      return;
    }
    const rel = /\.(md|mq|txt|json|ya?ml|toml|csv|html|css|[jt]sx?|py|rs|go|sh|sql|xml)$/i.test(name) ? name : `${name}.md`;
    await create(rel.replace(/^\/+/, ""));
  };

  /** Runs of the same request that have their own worktree, to compare. */
  const siblings = (s: SessionInfo) =>
    s.worktree && s.origin ? sessions.filter((x) => x.origin === s.origin && x.worktree) : [];

  const sessionMenu = (e: React.MouseEvent, s: SessionInfo) => {
    e.preventDefault();
    const running = s.status === "running" || s.status === "waiting";
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Open", icon: ExternalLink, onClick: () => openSession(s.id, s.title) },
        { label: "Open to the side", icon: Columns2, onClick: () => beside(() => openSession(s.id, s.title)) },
        { label: "Rename…", icon: Pencil, onClick: () => setRenamingSession({ id: s.id, title: s.title }) },
        {
          label: "Open origin note",
          icon: CornerUpLeft,
          onClick: async () => {
            const o = await api.sessionOrigin(vault!, s.id);
            if (o) openNote(o.path, o.line);
          },
        },
        ...(siblings(s).length > 1
          ? [{ label: "Compare runs", icon: GitCompare, onClick: () => openCompare(siblings(s).map((x) => x.id), s.title) }]
          : []),
        ...(s.worktree
          ? [{ label: "Reveal worktree in Finder", icon: FolderOpen, onClick: () => api.openIn(s.worktree!.path, "finder") }]
          : []),
        ...(running ? [{ label: "Stop", icon: Square, onClick: () => api.stopSession(s.id) }] : []),
        ...(running
          ? []
          : s.review
            ? [{ label: "Reopen for review", icon: CircleDashed, onClick: () => api.setSessionReview(vault!, s.id, "open").then(refresh) }]
            : [{ label: "Mark as done", icon: CircleCheck, onClick: () => api.setSessionReview(vault!, s.id, "done").then(refresh) }]),
        ...(s.pr_url ? [{ label: "Open pull request", icon: GitPullRequest, onClick: () => openUrl(s.pr_url!) }] : []),
        ...(s.status === "interrupted" || s.status === "error"
          ? [{
              label: "Resume",
              icon: RotateCw,
              onClick: async () => {
                try {
                  await api.resumeSession(vault!, s.id);
                  openSession(s.id, s.title);
                } catch (err) {
                  await message(String(err), { title: "Could not resume the session", kind: "error" });
                }
              },
            }]
          : []),
        "separator",
        { label: "Delete session…", icon: Trash2, danger: true, onClick: () => setDeleting(s) },
      ],
    });
  };

  const fileMenu = (e: React.MouseEvent, f: FileEntry) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Open", icon: ExternalLink, onClick: () => openNote(f.path) },
        { label: "Open to the side", icon: Columns2, onClick: () => beside(() => openNote(f.path)) },
        ...(f.kind === "scratch"
          ? [{ label: "Keep as note…", icon: NotebookPen, onClick: () => setPathDialog({ mode: "keep", from: f.rel, initial: `notes/${slugOf(fileLabel(f))}` }) }]
          : []),
        { label: "Reveal in Finder", icon: FolderOpen, onClick: () => api.openIn(f.path, "reveal") },
        ...(f.rel.startsWith("sessions/")
          ? []
          : ([
              "separator",
              { label: "Rename…", icon: Pencil, onClick: () => setPathDialog({ mode: "rename", from: f.rel, initial: f.rel.replace(/\.md$/, "") }) },
              { label: "Move to…", icon: FolderInput, onClick: () => setPathDialog({ mode: "move", from: f.rel, initial: parentOf(f.rel) }) },
            ] as MenuItem[])),
        ...(f.kind === "request"
          ? ([
              "separator",
              ...([
                ["done", "Mark as done", CircleCheck],
                ["todo", "Back to todo", CircleDashed],
                ["dropped", "Drop", CircleSlash],
              ] as const)
                .filter(([st]) => st !== f.status)
                .map(([st, label, icon]) => ({
                  label,
                  icon,
                  onClick: async () => {
                    await api.setNoteStatus(vault!, f.path, st);
                    refresh();
                  },
                })),
            ] as MenuItem[])
          : []),
        "separator",
        {
          label: "Move to Trash",
          icon: Trash2,
          danger: true,
          onClick: async () => {
            const ok = await ask(`Move "${f.rel}" to the Trash?`, { title: "Delete note", kind: "warning", okLabel: "Move to Trash" });
            if (!ok) return;
            try {
              await api.deleteNote(vault!, f.path);
              closeTab(`note:${f.path}`);
              refresh();
            } catch (err) {
              await message(String(err), { title: "Could not delete the note", kind: "error" });
            }
          },
        },
      ],
    });
  };

  const dirMenu = (e: React.MouseEvent, dir: string) => {
    e.preventDefault();
    e.stopPropagation();
    const managed = dir === "sessions" || dir.startsWith("sessions/");
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "New note here", icon: FilePlus2, onClick: () => setNaming({ kind: "note", initial: `${dir}/` }) },
        { label: "New folder here", icon: FolderPlus, onClick: () => setPathDialog({ mode: "folder", initial: `${dir}/` }) },
        { label: "Reveal in Finder", icon: FolderOpen, onClick: () => api.openIn(`${vault}/${dir}`, "finder") },
        ...(managed
          ? []
          : ([
              "separator",
              { label: "Rename…", icon: Pencil, onClick: () => setPathDialog({ mode: "rename", from: dir, initial: dir }) },
              { label: "Move to…", icon: FolderInput, onClick: () => setPathDialog({ mode: "move", from: dir, initial: parentOf(dir) }) },
              "separator",
              {
                label: "Move folder to Trash",
                icon: Trash2,
                danger: true,
                onClick: async () => {
                  const n = files.filter((f) => f.rel.startsWith(`${dir}/`)).length;
                  const ok = await ask(`Move "${dir}" and its ${n} note${n === 1 ? "" : "s"} to the Trash?`, {
                    title: "Delete folder", kind: "warning", okLabel: "Move to Trash",
                  });
                  if (!ok) return;
                  try {
                    await api.deleteNote(vault!, `${vault}/${dir}`);
                    setTabs((prev) => prev.filter((t) => !(t.kind === "note" && t.path.startsWith(`${vault}/${dir}/`))));
                    refresh();
                  } catch (err) {
                    await message(String(err), { title: "Could not delete the folder", kind: "error" });
                  }
                },
              },
            ] as MenuItem[])),
      ],
    });
  };

  // ---- keyboard ----
  const [keymap, setKeymap] = useState<Keymap>(() => mergeKeys(null));
  const [mode, setMode] = useState<Mode>("normal");
  const [showPalette, setShowPalette] = useState(false);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<{ id: string; title: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [treeFocus, setTreeFocus] = useState(false);
  // A terminal has focus: only ⌘ keys are taken, the rest go to the shell (and zellij or tmux in it).
  const [termFocus, setTermFocus] = useState(false);
  useEffect(() => {
    const h = () => setTermFocus(!!document.activeElement?.closest(".terminal-view"));
    window.addEventListener("focusin", h);
    window.addEventListener("focusout", h);
    return () => {
      window.removeEventListener("focusin", h);
      window.removeEventListener("focusout", h);
    };
  }, []);
  const [treeCursor, setTreeCursor] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const loadConfig = () =>
    api.readConfig().then((c) => {
      setKeymap(mergeKeys(c));
      setSettings(c as Settings);
      themeFromConfig((c as Settings).appearance?.palette, (c as Settings).appearance?.mode);
    }, (e) => console.error(e));

  const editConfigFile = () =>
    api.configPath().then((p) => openTerminal(p.replace(/\/[^/]*$/, ""), "config.toml", `\${EDITOR:-vi} '${p}'`));

  // Settings… in the native menu.
  useEffect(() => {
    const un = listen("menu://settings", () => setShowSettings(true));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Menu items run the command with their id, the same ones ⌘K lists.
  const runCommand = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    const un = listen<string>("menu://command", (e) => runCommand.current(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Reloaded on focus, so edits to config.toml apply without a restart.
  useEffect(() => {
    loadConfig();
    window.addEventListener("focus", loadConfig);
    return () => window.removeEventListener("focus", loadConfig);
  }, []);

  const rows = useMemo(() => visibleRows(tree, closedDirs, noteView !== "folder", treePrefix), [tree, closedDirs, noteView, treePrefix]);

  const focusTree = () => {
    if (railOn) {
      // Icons only: the Notes list opens over the content.
      setSidebarOpen(true);
      setRailPanel("notes");
      requestAnimationFrame(() => treeRef.current?.focus());
    } else if (!sidebarOpen) {
      // The tree is not focusable while the sidebar is hidden.
      setSidebarOpen(true);
      requestAnimationFrame(() => treeRef.current?.focus());
    }
    const keys = rows.map((r) => r.key);
    setTreeCursor((c) => (c && keys.includes(c) ? c : rows.find((r) => activeNote && r.path === activeNote)?.key ?? keys[0] ?? null));
    setTreeFocus(true);
    treeRef.current?.focus();
  };

  const focusContent = () => {
    setTreeFocus(false);
    const pane = document.querySelector<HTMLElement>(".pane-inner:not([hidden])");
    const target = pane?.querySelector<HTMLElement>(".cm-content, .xterm-helper-textarea, textarea, input") ?? pane;
    target?.focus();
  };

  const moveTree = (d: number) => {
    const i = rows.findIndex((r) => r.key === treeCursor);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + d))];
    if (next) setTreeCursor(next.key);
  };

  const cycleTab = (d: number) => {
    const i = tabs.findIndex((t) => t.key === active);
    if (tabs.length) setActive(tabs[(i + d + tabs.length) % tabs.length].key);
  };

  /**
   * A terminal opens where the current tab works: its terminal, its session's worktree or project. Elsewhere it
   * is the project New task last used, else the vault.
   */
  const terminalCwd = () => {
    if (activeTab?.kind === "terminal") return activeTab.cwd;
    if (activeTab?.kind === "session") {
      const s = sessions.find((x) => x.id === activeTab.id);
      return s?.worktree?.path || s?.cwd || lastProject() || vault!;
    }
    return lastProject() || vault!;
  };

  /** Asks the active terminal tab's panes to act; false if it is not a terminal or no pane took it. */
  const terminalPane = (action: PaneAction): boolean => {
    if (activeTab?.kind !== "terminal") return false;
    const req: PaneRequest = { id: activeTab.id, action };
    window.dispatchEvent(new CustomEvent(PANE_EVENT, { detail: req }));
    return !!req.handled;
  };

  const commands: Record<string, { label: string; run: () => void }> = {
    "mode.normal": { label: "Normal mode", run: () => setMode("normal") },
    "mode.tab": { label: "Tab mode", run: () => setMode("tab") },
    "mode.pane": { label: "Pane mode", run: () => setMode("pane") },
    "mode.locked": { label: "Lock: send every key to the focused view", run: () => setMode("locked") },
    palette: { label: "Command palette", run: () => setShowPalette(true) },
    "file.open": { label: "Open a note, board or session…", run: () => setShowQuickOpen(true) },
    "search.open": { label: "Search notes", run: () => openSearch("") },
    find: { label: "Find in this note or in the changes", run: () => active && window.dispatchEvent(new CustomEvent(FIND_EVENT, { detail: active })) },
    "knowledge.gardening": {
      label: "Knowledge: merge session learnings into knowledge notes (daily schedule)",
      run: () => void api.knowledgeGardening(vault!).then((p) => { refreshFiles(); openNote(p); }),
    },
    "knowledge.hardening": {
      label: "Knowledge: propose rules, checks and setup from repeated failures (weekly schedule)",
      run: () => void api.knowledgeHardening(vault!).then((p) => { refreshFiles(); openNote(p); }),
    },
    "knowledge.promotion": {
      label: "Knowledge: write reviewed knowledge into a project's CLAUDE.md and skills (weekly schedule)",
      run: () => void api.knowledgePromotion(vault!).then((p) => { refreshFiles(); openNote(p); }),
    },
    "workspace.new": { label: "New workspace (a project and other directories to pick for tasks)", run: () => setNaming({ kind: "workspace", initial: "" }) },
    "environment.new": {
      label: "New environment note (ports, variables and rules for running next to other sessions), for the last task's project",
      run: () => void api.createEnvironmentNote(vault!, lastProject()).then((p) => { refreshFiles(); openNote(p); }),
    },
    "environment.repo": {
      label: "Create .marq/environment.md in the last task's project (shared with the repository)",
      run: () => void api.createEnvironmentFile(lastProject()).then(
        (p) => api.openIn(p, "vscode").catch(() => api.openIn(p, "reveal")),
        (e) => message(`${e}\n\nStart a task in the project first, so that Marq knows which one it is.`, { title: "Environment file", kind: "warning" }),
      ),
    },
    "playbook.new": { label: "New playbook (the phases a kind of task runs in, and what each is told)", run: () => setNaming({ kind: "playbook", initial: "" }) },
    "spec.new": { label: "New spec (requirements, design, tasks and acceptance, broken down into a board)", run: () => setNaming({ kind: "spec", initial: "" }) },
    "instructions.open": { label: "Standing instructions: rules every session follows", run: () => void api.instructionsPath(vault!).then((p) => openNote(p)) },
    "glossary.open": { label: "Glossary: terms, aliases and broader/narrower terms", run: () => void api.glossaryPath(vault!).then((p) => openNote(p)) },
    "task.new": { label: "New task", run: () => setShowNewTask(true) },
    "file.openAny": { label: "Open any text file… (also outside the vault)", run: () => void openAnyFile() },
    "note.new": { label: "New note", run: () => setNaming({ kind: "note", initial: "notes/" }) },
    "note.quick": { label: "Quick note (untitled, in notes/)", run: () => void createUntitled(false) },
    "scratch.new": { label: "Scratch memo (temporary, in scratch/)", run: () => void createUntitled(true) },
    "board.new": { label: "New board", run: () => setNewBoard(true) },
    "query.open": { label: "mq query", run: () => openTab({ key: "query", kind: "query", title: "mq query" }) },
    "terminal.new": { label: "New terminal", run: () => openTerminal(terminalCwd()) },
    // In a terminal tab with split panes, ⌘W closes the focused pane first; the tab goes with its last pane.
    "tab.close": { label: "Close tab (or the focused terminal pane)", run: () => active && !terminalPane("close") && closeTab(active) },
    "terminal.splitRight": { label: "Terminal: split the pane, new one on the right", run: () => void terminalPane("splitRight") },
    "terminal.splitDown": { label: "Terminal: split the pane, new one below", run: () => void terminalPane("splitDown") },
    "terminal.paneNext": { label: "Terminal: focus the next pane", run: () => void terminalPane("next") },
    "terminal.paneLeft": { label: "Terminal: focus the pane on the left", run: () => void terminalPane("left") },
    "terminal.paneRight": { label: "Terminal: focus the pane on the right", run: () => void terminalPane("right") },
    "terminal.paneUp": { label: "Terminal: focus the pane above", run: () => void terminalPane("up") },
    "terminal.paneDown": { label: "Terminal: focus the pane below", run: () => void terminalPane("down") },
    "terminal.paneZoom": { label: "Terminal: zoom the focused pane (toggle)", run: () => void terminalPane("zoom") },
    "terminal.paneClose": { label: "Terminal: close the focused pane", run: () => void terminalPane("close") },
    "tab.next": { label: "Next tab", run: () => cycleTab(1) },
    "tab.prev": { label: "Previous tab", run: () => cycleTab(-1) },
    "tab.pin": { label: "Pin or unpin tab", run: () => active && togglePin(active) },
    "split.open": { label: "Split: show the tab next to the one before it", run: () => active && openToSide(active) },
    "split.focus": { label: "Split: focus the other pane", run: () => split && setActive(split.other) },
    "split.direction": { label: "Split: side by side or one above the other", run: () => setDir(splitDir === "row" ? "column" : "row") },
    "split.close": { label: "Split: close (keep the focused tab)", run: () => setSplit(null) },
    "tab.rename": {
      label: "Rename tab or session",
      run: () => activeTab?.kind === "terminal" ? setRenaming(activeTab.key)
        : activeTab?.kind === "session" && setRenamingSession({ id: activeTab.id, title: activeTab.title }),
    },
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tab.goto.${n}`, {
      label: n === 9 ? "Go to last tab" : `Go to tab ${n}`,
      run: () => {
        const t = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
        if (t) setActive(t.key);
      },
    }])),
    "tree.focus": { label: "Focus the notes tree", run: focusTree },
    "sidebar.toggle": { label: "Show or hide the sidebar", run: () => setSidebarOpen(!sidebarOpen) },
    "content.focus": { label: "Focus the content", run: focusContent },
    "tree.down": { label: "Tree: down", run: () => moveTree(1) },
    "tree.up": { label: "Tree: up", run: () => moveTree(-1) },
    "tree.open": {
      label: "Tree: open",
      run: () => {
        const row = rows.find((r) => r.key === treeCursor);
        if (row?.dir && closedDirs.has(row.key)) toggleDir(row.key, false);
        else if (row?.dir) moveTree(1);
        else if (row) openNote(row.path ?? row.key);
      },
    },
    "tree.close": {
      label: "Tree: close folder",
      run: () => {
        const row = rows.find((r) => r.key === treeCursor);
        if (row?.dir && !closedDirs.has(row.key)) toggleDir(row.key, false);
        else if (row?.parent) setTreeCursor(row.parent);
      },
    },
    "tree.leave": { label: "Tree: leave", run: focusContent },
    "theme.next": {
      label: "Next theme",
      run: () => setTheme({ ...theme, palette: PALETTES[(PALETTES.findIndex((p) => p.key === theme.palette) + 1) % PALETTES.length].key }),
    },
    "vault.switch": { label: "Open another vault…", run: () => void pickVault() },
    "settings.open": { label: "Settings", run: () => setShowSettings(true) },
    "settings.file": { label: "Settings: edit config.toml", run: editConfigFile },
    "note.toggleEdit": {
      label: "Note: switch between preview and edit",
      run: () => activeTab?.kind === "note" && window.dispatchEvent(new CustomEvent("marq:note-toggle", { detail: activeTab.path })),
    },
    "session.nextActive": { label: "Go to the next running or waiting session", run: nextActive },
    "schedule.new": { label: "New schedule…", run: () => setNewSchedule(true) },
  };

  useLayoutEffect(() => {
    runCommand.current = (id) => vault && commands[id]?.run();
  });

  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  // Kept current after each render; the listener below calls the latest.
  useLayoutEffect(() => {
  onKey.current = (e) => {
    if (e.isComposing || !vault) return;
    const key = eventKey(e);
    if (!key) return;
    // Dialogs and menus keep their own keys.
    if (showQuickOpen || showPalette || showNewTask || naming || pathDialog || sending || deleting || menu || renaming || renamingSession || newBoard || showSettings || newSchedule) return;
    let cmd: string | undefined;
    if (mode === "normal") {
      // ⌃T, ⌃P, ⌃G… belong to whatever runs in a terminal; the ⌘ shortcuts still work there.
      // Likewise in the note editor with Vim keys on.
      if (!key.includes("Cmd") && (e.target as Element).closest?.(".terminal-view, .marq-vim")) return;
      cmd = lookup(keymap.normal, key) ?? (treeFocus ? lookup(TREE_KEYS, key) : undefined);
      // Unmodified keys never steal typing from editors and terminals.
      const typing = (e.target as Element).closest?.("input, textarea, [contenteditable=true], .cm-editor");
      if (cmd && !key.includes("+") && typing && !treeFocus) cmd = undefined;
    } else {
      cmd = lookup(keymap[mode], key);
      // Other keys do nothing in tab and pane modes; in locked mode they pass through.
      if (!cmd && mode !== "locked") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    if (!cmd || !commands[cmd]) return;
    e.preventDefault();
    e.stopPropagation();
    commands[cmd].run();
    // Actions that open something end the mode, like zellij.
    if (mode !== "normal" && ["terminal.new", "tab.close", "tab.rename", "tree.focus", "content.focus"].includes(cmd)) setMode("normal");
  };
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey.current(e);
    // Capture, so the editor and terminal never see bound keys.
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  useEffect(() => {
    if (treeFocus) treeRef.current?.querySelector(".tree-row.cursor")?.scrollIntoView({ block: "nearest" });
  }, [treeCursor, treeFocus]);

  // Back into the active tab after a dialog or menu closes, and on tab switches.
  const dialogOpen = !!(showQuickOpen || showPalette || showNewTask || naming || pathDialog || sending || deleting || renaming || renamingSession || menu || newBoard || showSettings || newSchedule);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !dialogOpen && !treeFocus) requestAnimationFrame(focusContent);
    wasOpen.current = dialogOpen;
  }, [dialogOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!treeFocus && !dialogOpen) requestAnimationFrame(focusContent);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listed when the palette opens, not on every render (some handlers read refs, which render must not).
  const paletteCommands = () => Object.entries(commands)
    .filter(([id]) => !id.startsWith("tree.") || id === "tree.focus")
    .map(([id, c]) => ({ id, label: c.label, keys: keymap.normal[id] ?? [] }));

  /** The tab that was already active at the first click of a double-click, if any. */
  const renameArmed = useRef<string | null>(null);

  if (!vault) {
    return (
      <div className="welcome">
        <div className="welcome-card">
          <div className="logo"><LogoMark size={44} /></div>
          <h1>Marq</h1>
          <p>Mark up your notes, query them with mq: every note can start an agent session, and every session comes back as a note.</p>
          <ul className="welcome-points">
            <li><Sparkles size={14} /> Ask from any heading</li>
            <li><ArrowLeftRight size={14} /> Jump between notes and sessions</li>
            <li><Braces size={14} /> Query notes with mq, live in the preview</li>
          </ul>
          <button className="primary big" onClick={pickVault}>Open a vault folder</button>
        </div>
      </div>
    );
  }

  const current = tabs.find((t) => t.key === active);
  const pinned = tabs.filter((t) => t.pinned);
  const unpinned = tabs.filter((t) => !t.pinned);

  const renameTab = (t: Tab) => (t.kind === "terminal" ? setRenaming(t.key) : t.kind === "session" && setRenamingSession({ id: t.id, title: t.title }));

  const tabMenu = (e: React.MouseEvent, t: Tab) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        t.pinned ? { label: "Unpin", icon: PinOff, onClick: () => togglePin(t.key) } : { label: "Pin", icon: Pin, onClick: () => togglePin(t.key) },
        ...(t.kind === "terminal" || t.kind === "session" ? [{ label: "Rename…", icon: Pencil, onClick: () => renameTab(t) }] : []),
        ...(split && (t.key === active || t.key === split.other)
          ? [{ label: "Close split", icon: PanelRightClose, onClick: () => { setSplit(null); setActive(t.key); } }]
          : [{ label: "Open to the side", icon: Columns2, onClick: () => openToSide(t.key) }]),
        { label: "Close", icon: X, onClick: () => closeTab(t.key) },
      ],
    });
  };

  // What a tab's sessions are doing, most urgent first: a comparison shows its runs.
  const tabStatus = (t: Tab): string | undefined => {
    const ids = t.kind === "session" ? [t.id] : t.kind === "compare" ? t.ids : [];
    const of = ids.map((id) => sessions.find((x) => x.id === id)?.status);
    return ["waiting", "running", "error"].find((st) => of.includes(st)) ?? (ids.some((id) => unread.has(id)) ? "unread" : undefined);
  };
  const STATUS_LABEL: Record<string, string> = { waiting: "Needs you", running: "Running", error: "Stopped with an error", unread: "New output" };

  const tabIcon = (t: Tab) => t.kind === "session" ? MessageSquare : t.kind === "compare" ? GitCompare : t.kind === "query" ? Braces
    : t.kind === "terminal" ? SquareTerminal : t.kind === "board" ? Columns3 : t.kind === "search" ? Search : FileText;
  /** The tabs scrolled out of sight, to pick one from. */
  const hiddenTabsMenu = (keys: string[], x: number, y: number) => setMenu({
    x, y,
    items: keys.flatMap((k) => {
      const t = tabs.find((x) => x.key === k);
      return t ? [{ label: t.title, icon: tabIcon(t), onClick: () => setActive(k) }] : [];
    }),
  });
  const tabEl = (t: Tab) => {
    const status = tabStatus(t);
    const Icon = tabIcon(t);
    return (
    <div key={t.key} data-key={t.key} className={`tab ${t.key === active ? "on" : ""} ${t.key === split?.other ? "side" : ""} ${t.pinned ? "pinned" : ""} ${t.key === dragTab ? "dragging" : ""} ${status ? `is-${status}` : ""}`}
      title={status ? `${t.title} — ${STATUS_LABEL[status]}` : t.title}
      onClick={(e) => (e.altKey ? openToSide(t.key) : setActive(t.key))}
      draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragTab(t.key); }}
      onDragEnter={() => dragTab && moveTab(dragTab, t.key)}
      onDragOver={(e) => dragTab && e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
      onDragEnd={() => setDragTab(null)}
      onAuxClick={(e) => e.button === 1 && closeTab(t.key)}
      onContextMenu={(e) => tabMenu(e, t)}
      onMouseDown={(e) => { if (e.detail === 1) renameArmed.current = t.key === active ? t.key : null; }}
      onDoubleClick={(e) => {
        // Only a double-click on the tab already shown renames it, so quickly switching tabs (or a
        // click that lands right after the ✕ or pin) never opens the dialog.
        if (renameArmed.current !== t.key || (e.target as Element).closest("button")) return;
        renameTab(t);
      }}>
      <span className={`tab-icon kind-${t.kind}`}>
        <Icon size={12} />
        {status && <span className={`tab-status ${status}`} />}
      </span>
      <span className="ellipsis">{t.title}</span>
      {status === "waiting" && <span className="tab-badge">needs you</span>}
      {t.pinned
        ? <button className="tab-close tab-pin" title="Unpin" onClick={(e) => { e.stopPropagation(); togglePin(t.key); }}><Pin size={11} /></button>
        : <button className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.key); }}><X size={12} /></button>}
    </div>
    );
  };

  // At the end of the tab bar: split the screen, or turn and close the split.
  const splitControls = split ? (
    <span className="split-controls">
      <button className="icon" title={split.dir === "row" ? "Put the panes one above the other" : "Put the panes side by side"}
        onClick={() => setDir(split.dir === "row" ? "column" : "row")}>
        {split.dir === "row" ? <Rows2 size={14} /> : <Columns2 size={14} />}
      </button>
      <button className="icon" title="Close the split (keep the focused tab)" onClick={() => setSplit(null)}><PanelRightClose size={14} /></button>
    </span>
  ) : tabs.length > 1 && (
    <span className="split-controls">
      <button className="icon" title="Split the screen: two tabs side by side (⌘\). Or ⌥-click any tab, note or session to open it to the side"
        onClick={() => active && openToSide(active)}><Columns2 size={14} /></button>
    </span>
  );

  // At the start of the tab bar while the sidebar is hidden.
  const showSidebar = !sidebarOpen && (
    <button className="icon sidebar-show" title="Show the sidebar (⌘B)" onClick={() => setSidebarOpen(true)}>
      <PanelLeftOpen size={15} />
    </button>
  );

  return (
    <div className="app-shell">
    <div className="app">
      {/* Kept mounted while hidden, so the tree's scroll and open folders survive. */}
      {railOn && sidebarOpen && (
        <nav className="rail">
          <button className="rail-btn logo" title={`${vault}\nSwitch vaults`} onClick={vaultMenu}><LogoMark size={20} /></button>
          <button className="rail-btn" title="Search notes and sessions (⇧⌘F)" onClick={() => openSearch("")}><Search size={17} /></button>
          <button className="rail-btn accent" title="New task (⌘N)" onClick={() => setShowNewTask(true)}><Plus size={18} /></button>
          <span className="rail-sep" />
          {([
            ...(inboxCount ? [["inbox", "Inbox", Inbox, inboxCount] as [string, string, LucideIcon, number]] : []),
            ["active", "Active", Activity, activeSessions.length],
            ...(groups.length ? [["sessions", "Needs review", GitPullRequest, groups.reduce((n, g) => n + g.items.length, 0)] as [string, string, LucideIcon, number]] : []),
            ["recent", "Recent", History, 0],
            ["boards", "Boards", Columns3, 0],
            ["workspaces", "Workspaces", FolderGit2, 0],
            ["schedules", "Schedules", Timer, 0],
            ["notes", "Notes", FileText, 0],
          ] as [string, string, LucideIcon, number][]).map(([id, label, Icon, n]) => (
            <button key={id} className={`rail-btn ${railPanel === id ? "on" : ""}`} title={label}
              onClick={() => setRailPanel(railPanel === id ? null : id)}>
              <Icon size={17} />
              {n > 0 && <span className={`rail-badge ${id === "active" ? activeSessions[0]?.status ?? "" : ""}`}>{n}</span>}
            </button>
          ))}
          <span className="rail-spacer" />
          <button className="rail-btn" title="New note" onClick={() => setNaming({ kind: "note", initial: "notes/" })}><FilePlus2 size={16} /></button>
          <button className="rail-btn" title="mq query" onClick={() => openTab({ key: "query", kind: "query", title: "mq query" })}><Braces size={16} /></button>
          <button className="rail-btn" title="Terminal" onClick={() => openTerminal(terminalCwd())}><SquareTerminal size={16} /></button>
          <button className="rail-btn" title="Theme" onClick={themeMenu}><Palette size={16} /></button>
          <button className="rail-btn" title="Settings (⌘,)" onClick={() => setShowSettings(true)}><SettingsIcon size={16} /></button>
          <button className="rail-btn" title="Show the full sidebar" onClick={() => setSidebarMode("full")}><PanelLeftOpen size={16} /></button>
        </nav>
      )}
      {railOn && sidebarOpen && railPanel && <div className="rail-backdrop" onMouseDown={() => setRailPanel(null)} />}
      <RailContext.Provider value={{ rail: railOn, panel: railPanel }}>
      <aside ref={sidebarRef} className={`sidebar ${railOn ? "flyout" : ""}`} data-panel={railOn ? railPanel ?? "" : undefined}
        style={{ width: sidebar.size, display: sidebarOpen && (!railOn || railPanel) ? undefined : "none" }}
        onKeyDown={(e) => { if (railOn && e.key === "Escape") setRailPanel(null); }}
        // Picking a session, note or board puts the list away; folders, toggles and buttons keep it.
        onClick={(e) => {
          if (!railOn) return;
          const t = e.target as Element;
          if (t.closest("button, .section-actions, .tree-row.dir")) return;
          if (t.closest(".active-row, .session-row, .recent-row, .inbox-row, .tree-row")) setRailPanel(null);
        }}>
        <div className="vault" title={`${vault}\nClick to switch vaults`} onClick={vaultMenu}>
          <div className="logo small"><LogoMark size={18} /></div>
          <span className="ellipsis">{vault.split("/").pop()}</span>
          <ChevronsUpDown size={12} className="vault-switch" />
          <button className="theme-btn" title="Theme" onClick={themeMenu}><Palette size={14} /></button>
          <button className="theme-btn" title="Settings (⌘,)" onClick={(e) => (e.stopPropagation(), setShowSettings(true))}><SettingsIcon size={14} /></button>
          <button className="theme-btn" title="Icons only" onClick={(e) => (e.stopPropagation(), setSidebarMode("rail"))}><PanelLeft size={14} /></button>
          <button className="theme-btn" title="Hide the sidebar (⌘B)" onClick={(e) => (e.stopPropagation(), setSidebarOpen(false))}><PanelLeftClose size={14} /></button>
        </div>
        <button className="side-search" onClick={() => openSearch("")} title="Search the text of notes and sessions (⇧⌘F). Open a note or session by name: ⌘P">
          <Search size={13} /> <span>Search</span> <kbd>⇧⌘F</kbd>
        </button>
        <button className="new-task" onClick={() => setShowNewTask(true)}>
          <Plus size={15} /> New task <kbd>⌘N</kbd>
        </button>
        <div className="quick">
          <button onClick={() => setNaming({ kind: "note", initial: "notes/" })} title="New note"><FilePlus2 size={14} /> Note</button>
          <button onClick={() => openTab({ key: "query", kind: "query", title: "mq query" })} title="mq query">
            <Braces size={14} /> Query
          </button>
          <button onClick={() => openTerminal(terminalCwd())} title="Terminal in the project New task last used (the vault if none)"><SquareTerminal size={14} /> Terminal</button>
        </div>
        <div className="side-scroll">
          {inboxCount > 0 && (
            <Collapsible title="Inbox" panel="inbox" icon={<Inbox size={11} />} count={inboxCount}
              action={openEvents.some((e) => dismissable(e)) ? (
                <button className="row-action" title="Dismiss all" onClick={(e) => { e.stopPropagation(); api.inboxClear(); }}><X size={12} /></button>
              ) : undefined}>
              {openEvents.map((e) => {
                const s = sessions.find((x) => x.id === e.session_id);
                const work = e.kind === "schedule" || e.kind === "request" || e.kind === "followup" || e.kind === "card";
                const sub = work
                  ? e.status === "pending" ? (e.kind === "followup" ? `Follow-up due${e.body ? ` · ${summary(e.body, 50)}` : ""}` : "Queued")
                    : e.status === "running" ? "Starting…" : `Failed${e.body ? ` · ${summary(e.body, 60)}` : ""}`
                  : e.kind === "result" ? summary(e.body, 80) || e.title
                  : !s ? summary(e.body, 80) || e.title : `${e.title}${e.body ? ` · ${summary(e.body, 60)}` : ""}`;
                const dot = work ? (e.status === "failed" ? "error" : "status-todo") : e.kind === "approval" ? "waiting" : e.kind === "error" ? "error" : "status-review";
                return (
                  <a key={e.id} className={`inbox-row ib-${e.kind} ib-${e.status}`} title={e.body || e.title}
                    onClick={() => (e.session_id ? openSession(e.session_id, s?.title ?? "Session") : e.kind !== "followup" && openNote(e.kind === "card" ? e.source.slice(0, e.source.lastIndexOf("#")) : e.source))}>
                    <span className={`dot ${dot}`} />
                    <span className="inbox-text">
                      <span className="ellipsis">{work ? e.title : s?.title ?? e.title}</span>
                      <span className="inbox-sub ellipsis">{sub}</span>
                    </span>
                    {dismissable(e) && (
                      <button className="row-action" title="Dismiss" onClick={(ev) => { ev.stopPropagation(); api.inboxResolve({ id: e.id, status: "dismissed" }); }}><X size={12} /></button>
                    )}
                  </a>
                );
              })}
              {waitingFiles.map((f) => (
                <a key={f.path} className={`inbox-row ${current?.kind === "note" && current.path === f.path ? "on" : ""}`}
                  onClick={() => openNote(f.path)} onContextMenu={(e) => fileMenu(e, f)}>
                  <span className={`pill status-${f.status}`}>{f.status}</span>
                  <span className="ellipsis">{fileLabel(f)}</span>
                  {f.kind === "request" && (
                    <button className="row-action" title="Queue: start it when there is room"
                      onClick={(ev) => { ev.stopPropagation(); api.inboxQueueRequest(f.path, fileLabel(f)); }}><Play size={12} /></button>
                  )}
                </a>
              ))}
            </Collapsible>
          )}
          <Collapsible title="Active" panel="active" count={activeSessions.length}
            icon={activeSessions.length ? <span className={`dot ${activeSessions[0].status}`} /> : undefined}>
            {activeByProject.map(([project, list]) => (
              <div key={project} className="active-group">
                <div className="active-project" title={list[0].worktree?.repo ?? list[0].cwd}><FolderGit2 size={11} /> {project}</div>
                {list.map((s) => (
                  <a key={s.id} className={`active-row ${s.status} ${current?.kind === "session" && current.id === s.id ? "on" : ""} ${unread.has(s.id) ? "unread" : ""}`}
                    onClick={() => openSession(s.id, s.title)} onContextMenu={(e) => sessionMenu(e, s)}
                    title={[s.title, s.worktree?.branch, s.started.slice(0, 16).replace("T", " ")].filter(Boolean).join("\n")}>
                    <span className={`dot ${s.status}`} />
                    <span className="active-body">
                      <span className="active-title">
                        <span className="ellipsis">{s.title}</span>
                        {s.status === "waiting" && <span className="row-badge waiting">needs you</span>}
                      </span>
                      <span className="active-meta">
                        {(s.additions || s.deletions) ? <span className="active-diff"><b>+{s.additions ?? 0}</b> <i>−{s.deletions ?? 0}</i></span> : null}
                        <span className="active-ago">{ago(s.started)}</span>
                      </span>
                    </span>
                  </a>
                ))}
              </div>
            ))}
            {activeSessions.length === 0 && <div className="muted small" style={{ padding: "2px 12px 6px" }}>Nothing is running.</div>}
          </Collapsible>
          {groups.map((g) => (
            <Collapsible key={g.key} title={g.label} panel="sessions" count={g.items.length}
              action={<button className="section-action" title={`Mark all ${g.items.length} as done`}
                onClick={() => {
                  const ids = new Set(g.items.map((s) => s.id));
                  // Leave the list at once; the saves and the diffstats behind them take a moment.
                  setSessions((all) => all.map((s) => (ids.has(s.id) ? { ...s, review: "done" } : s)));
                  Promise.all([...ids].map((id) => api.setSessionReview(vault!, id, "done"))).then(refresh, refresh);
                }}>
                <CheckCheck size={13} /></button>}>
              {g.items.map((s) => (
                <a key={s.id} className={`session-row ${current?.kind === "session" && current.id === s.id ? "on" : ""} ${unread.has(s.id) ? "unread" : ""}`}
                  onClick={() => openSession(s.id, s.title)} onContextMenu={(e) => sessionMenu(e, s)}
                  title={[s.title, s.worktree?.branch, s.origin_path].filter(Boolean).join("\n")}>
                  <span className={`dot ${s.status}`} />
                  <span className="session-row-body">
                    <span className="session-row-title">{s.title}</span>
                    <span className="session-row-meta muted small">
                      {s.worktree ? (
                        <span className="session-row-branch"><GitBranch size={10} /> <span className="ellipsis">{s.worktree.branch}</span></span>
                      ) : (
                        <span className="ellipsis">{s.started.slice(5, 16).replace("T", " ")}</span>
                      )}
                      {!s.verifies && <VerifyBadge state={s.verification} />}
                      {s.review === "pr" && <span className="row-badge pr" title={s.pr_url ?? ""}><GitPullRequest size={10} /> PR</span>}
                      {s.review === "done" && <span className="row-badge done"><CircleCheck size={10} /> done</span>}
                      {!s.review && s.additions !== null && (s.additions! + s.deletions!) > 0 && (
                        <span className="diffstat small"><span className="add">+{s.additions}</span> <span className="del">−{s.deletions}</span></span>
                      )}
                    </span>
                  </span>
                </a>
              ))}
            </Collapsible>
          ))}
          <Collapsible title="Boards" panel="boards" icon={<Columns3 size={11} />} count={boards.length}
            action={<button className="section-action" title="New board" onClick={() => setNewBoard(true)}><Plus size={13} /></button>}>
            {boards.map((f) => (
              <a key={f.path} className={`inbox-row ${current?.kind === "board" && current.path === f.path ? "on" : ""}`}
                onClick={() => openBoard(f.path)} onContextMenu={(e) => fileMenu(e, f)} title={f.rel}>
                <Columns3 size={13} /> <span className="ellipsis">{fileLabel(f)}</span>
              </a>
            ))}
            {boards.length === 0 && <a className="muted small pad" onClick={() => setNewBoard(true)}>Create a board for your tasks</a>}
          </Collapsible>
          {(
            <Collapsible title="Workspaces" panel="workspaces" icon={<FolderGit2 size={11} />} count={workspaces.length} defaultOpen={false}
              action={<button className="section-action" title="New workspace" onClick={() => setNaming({ kind: "workspace", initial: "" })}><Plus size={13} /></button>}>
              {workspaces.map(({ f, count }) => (
                <a key={f.path} className={`inbox-row schedule-row ${current?.kind === "note" && current.path === f.path ? "on" : ""}`}
                  onClick={() => openNote(f.path)} onContextMenu={(e) => fileMenu(e, f)}
                  title={`${f.rel}${f.project ? `\n${f.project}` : ""}\nIts sessions, requests and documents are in the note's side panel`}>
                  <FolderGit2 size={13} /> <span className="ellipsis">{fileLabel(f)}</span>
                  <span className="spacer" />
                  {count > 0 && <span className="count">{count}</span>}
                  <button className="icon row-action" title="Show its sessions in Recent"
                    onClick={(e) => { e.stopPropagation(); setRecentOpen(true); setRecentFilter(fileLabel(f)); if (railOn) setRailPanel("recent"); }}><ListFilter size={11} /></button>
                </a>
              ))}
              {workspaces.length === 0 && (
                <div className="muted small" style={{ padding: "2px 12px 6px" }}>
                  A project and the other directories its tasks work on, saved to pick again. <a onClick={() => setNaming({ kind: "workspace", initial: "" })}>New workspace</a>
                </div>
              )}
            </Collapsible>
          )}
          <Collapsible title="Schedules" panel="schedules" icon={<Timer size={11} />} count={schedules.length} defaultOpen={false}
            action={<button className="section-action" title="New schedule" onClick={() => setNewSchedule(true)}><Plus size={13} /></button>}>
            {schedules.map((s) => (
              <a key={s.path} className={`inbox-row schedule-row ${s.enabled ? "" : "off"} ${current?.kind === "note" && current.path === s.path ? "on" : ""}`}
                onClick={() => openNote(s.path)} title={`${s.rel}${s.last_run ? `\nLast run ${s.last_run.slice(0, 16).replace("T", " ")}` : ""}`}>
                {s.running ? <span className="dot running" /> : <Timer size={13} />}
                <span className="ellipsis">{s.title ?? s.rel}</span>
                <span className="spacer" />
                <span className="muted small schedule-when">{scheduleLabel(s)}</span>
                <button className="icon row-action" title="Run now" disabled={s.running}
                  onClick={(e) => { e.stopPropagation(); runSchedule(s); }}><Play size={11} /></button>
                <button className="icon row-action" title={s.enabled ? "Pause" : "Resume"}
                  onClick={(e) => { e.stopPropagation(); api.scheduleSetEnabled(vault, s.path, !s.enabled).then(refreshFiles); }}>
                  {s.enabled ? <Pause size={11} /> : <RotateCw size={11} />}
                </button>
              </a>
            ))}
            {schedules.length === 0 && (
              <div className="muted small" style={{ padding: "2px 12px 6px" }}>
                Prompts that run on their own every so often while Marq is open. <a onClick={() => setNewSchedule(true)}>New schedule</a>
              </div>
            )}
          </Collapsible>
          <Collapsible title="Notes" panel="notes" icon={<FileText size={11} />} fill
            action={<>
              <button className={`section-action ${noteView !== "folder" ? "on" : ""}`} title="View notes by folder, tag, type or project" onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({
                  x: r.left, y: r.bottom + 4,
                  items: views.map((v) => ({ label: `${v.value === noteView ? "✓" : "\u2003"} ${v.label}`, onClick: () => setNoteView(v.value) })),
                });
              }}>
                <Layers size={13} />
              </button>
              {/* Only this view's groups: folders keep their state while another view is shown. */}
              <button className="section-action" title="Expand all" onClick={() => setClosedDirs((s) => new Set([...s].filter((d) => !allDirs.includes(d))))}>
                <ChevronsUpDown size={13} />
              </button>
              <button className="section-action" title="Collapse all" onClick={() => setClosedDirs((s) => new Set([...s, ...allDirs]))}>
                <ChevronsDownUp size={13} />
              </button>
              <button className="section-action" title="Sort notes" onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({
                  x: r.left, y: r.bottom + 4,
                  items: NOTE_SORTS.map((s) => ({ label: `${s.value === noteSort ? "✓" : "\u2003"} ${s.label}`, icon: s.icon, onClick: () => setNoteSort(s.value) })),
                });
              }}>
                <ArrowDownUp size={13} />
              </button>
              <button className="section-action" title="New folder" onClick={() => setPathDialog({ mode: "folder", initial: "" })}>
                <FolderPlus size={13} />
              </button>
            </>}>
            <NotesTree ref={treeRef} cursor={treeFocus ? treeCursor : null} onBlur={() => setTreeFocus(false)}
              tree={tree} prefix={treePrefix} virtual={noteView !== "folder"} closed={closedDirs} onToggle={toggleDir} activePath={current?.kind === "note" ? current.path : undefined}
              onOpen={openFile} onNewIn={(dir) => setNaming({ kind: "note", initial: dir })} onFileMenu={fileMenu}
              onDirMenu={dirMenu} onDrop={(from, to) => { move(from, to ? `${to}/` : ""); }} />
          </Collapsible>
        </div>
        {recent.length > 0 && (
          <div className="recent-dock">
            {recentOpen && <Resizer axis="y" sign={-1} pane={recentHeight}
              preview={(v) => recentRef.current && (recentRef.current.style.height = `${v}px`)} />}
            <a className="section-title" onClick={() => setRecentOpen(!recentOpen)}>
              <ChevronRight size={11} className={`chev ${recentOpen ? "open" : ""}`} /> Recent
              <span className="count">{recentShown.filtered ? `${recentShown.found} / ${recent.length}` : recent.length}</span>
              <span className="section-actions" onClick={(e) => e.stopPropagation()}>
                <button className={`section-action ${recentFilter !== null ? "on" : ""}`} title="Filter by title, project, branch, workspace, status or date"
                  onClick={() => { setRecentOpen(true); setRecentFilter(recentFilter === null ? "" : null); }}>
                  <ListFilter size={13} />
                </button>
                <button className={`section-action ${recentGroup !== "none" ? "on" : ""}`} title="Group sessions" onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({
                    x: r.left, y: r.bottom + 4,
                    items: groupChoices.map((g) => ({ label: `${g.value === recentGroup ? "✓" : "\u2003"} ${g.label}`, onClick: () => { setRecentOpen(true); setRecentGroup(g.value); } })),
                  });
                }}>
                  <Layers size={13} />
                </button>
              </span>
            </a>
            {recentOpen && recentFilter !== null && (
              <input className="recent-filter" autoFocus value={recentFilter} placeholder="Filter sessions…"
                onChange={(e) => setRecentFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (composing(e)) return;
                  if (e.key === "Escape") { e.stopPropagation(); setRecentFilter(null); }
                  const first = recentShown.groups[0]?.items[0];
                  if (e.key === "Enter" && first) openSession(first.id, first.title);
                }} />
            )}
            {recentOpen && (
              <div ref={recentRef} className="recent-list" style={{ height: recentHeight.size }}>
                {recentShown.found === 0 && <div className="muted small recent-note">No session matches.</div>}
                {recentShown.groups.map((g) => (
                  <div key={g.label} className="recent-group">
                  {g.label && <div className="active-project" title={g.label}>{g.label} <span className="recent-group-count">{g.items.length}</span></div>}
                  {g.items.map((s) => (
                  <a key={s.id} className={`recent-row ${current?.kind === "session" && current.id === s.id ? "on" : ""} ${unread.has(s.id) ? "unread" : ""}`}
                    onClick={() => openSession(s.id, s.title)} onContextMenu={(e) => sessionMenu(e, s)}
                    title={[s.title, s.worktree?.branch, s.started.slice(0, 16).replace("T", " ")].filter(Boolean).join("\n")}>
                    <span className={`dot ${s.status}`} />
                    <span className="ellipsis">{s.title}</span>
                    {s.review === "pr" && <GitPullRequest size={11} className="muted" />}
                    {s.review === "done" && <CircleCheck size={11} className="muted" />}
                    <span className="recent-ago">{ago(s.started)}</span>
                  </a>
                  ))}
                  </div>
                ))}
                {recentShown.hidden > 0 && (
                  <div className="muted small recent-note">
                    +{recentShown.hidden} older. {recentShown.filtered ? "Narrow the filter to see them." : <a onClick={() => setRecentFilter("")}>Filter</a>}
                    {!recentShown.filtered && " to find them."}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </aside>
      </RailContext.Provider>
      {sidebarOpen && !railOn && <Resizer axis="x" sign={1} pane={sidebar}
        preview={(v) => sidebarRef.current && (sidebarRef.current.style.width = `${v}px`)} />}
      <main>
        {/* With no tabs, the bar has nothing to hold (unless it carries the show-sidebar button), so it is left out. */}
        {tabs.length === 0 && !showSidebar ? null : pinnedRow ? (
          <>
            {pinned.length > 0 && <TabStrip className="pinned-row" lead={showSidebar} trail={unpinned.length === 0 ? splitControls : undefined} wrap={wrapTabs} active={active} onShowHidden={hiddenTabsMenu} onBlankDoubleClick={() => void createUntitled(false)}>
              {pinned.map(tabEl)}
            </TabStrip>}
            {/* Nothing to show (no unpinned tabs, no sidebar button, no split controls): leave the row out. */}
            {(unpinned.length > 0 || (pinned.length === 0 && (showSidebar || splitControls))) && (
              <TabStrip lead={pinned.length === 0 && showSidebar} trail={splitControls} wrap={wrapTabs} active={active} onShowHidden={hiddenTabsMenu} onBlankDoubleClick={() => void createUntitled(false)}>
                {unpinned.map(tabEl)}
              </TabStrip>
            )}
          </>
        ) : (
          <TabStrip lead={showSidebar} trail={splitControls} wrap={wrapTabs} active={active} onShowHidden={hiddenTabsMenu} onBlankDoubleClick={() => void createUntitled(false)}>
            {pinned.map(tabEl)}
            {pinned.length > 0 && unpinned.length > 0 && <span className="tab-sep" />}
            {unpinned.map(tabEl)}
          </TabStrip>
        )}
        <section ref={paneRef} className={`pane ${split ? `split ${split.dir}` : ""}`}
          style={split ? { "--split-first": `${splitSize.size / 10}%` } as React.CSSProperties : undefined}>
          {split && (
            <Resizer axis={split.dir === "row" ? "x" : "y"} sign={1} pane={splitSize}
              scale={() => ((split.dir === "row" ? paneRef.current?.clientWidth : paneRef.current?.clientHeight) ?? 1000) / 1000}
              preview={(v) => paneRef.current?.style.setProperty("--split-first", `${v / 10}%`)} />
          )}
          {/* Tabs stay mounted so editor state and session streams survive switching. */}
          {tabs.map((t) => (
            <TabPane key={t.key} tab={t} vault={vault} active={t.key === active || t.key === split?.other}
              slot={!split ? undefined : t.key === active ? split.side : t.key === split.other ? (split.side ? 0 : 1) : undefined}
              focused={!!split && t.key === active} onFocus={() => setActive(t.key)}>
              {t.kind === "note" && <NoteEditor vault={vault} path={t.path} active={t.key === active || t.key === split?.other} jump={t.jump} fresh={t.fresh} onOpenSession={openSession} onOpenFile={openFile}
                onSendExcerpt={(excerpt) => setSending({ excerpt })} />}
              {t.kind === "compare" && <CompareView vault={vault} ids={t.ids} sessions={sessions} onOpenSession={openSession} onChanged={refresh} />}
              {t.kind === "session" && <SessionView vault={vault} sessionId={t.id} onOpenOrigin={openNote} onOpenSession={openSession}
                onSendExcerpt={(excerpt) => setSending({ excerpt, exclude: t.id })} />}
              {t.kind === "terminal" && <TerminalView id={t.id} cwd={t.cwd} command={t.command} active={t.key === active}
                onTitle={(title) => setTabs((prev) => {
                  // Programs set the same title over and over; only a new one is worth a render.
                  const cur = prev.find((x) => x.key === t.key);
                  if (cur?.kind !== "terminal" || cur.named || cur.title === title) return prev;
                  return prev.map((x) => (x === cur ? { ...x, title } : x));
                })} />}
              {t.kind === "board" && <BoardView vault={vault} path={t.path} files={files} recent={recentFiles} sessions={sessions}
                onOpenMarkdown={() => openNote(t.path)} onOpenFile={openFile} onCreateNote={(rel) => create(rel)}
                onStartTask={(prompt, after, review) => { taskAfter.current = after ?? null; setTaskReview(review); setTaskPrompt(prompt); setShowNewTask(true); }} />}
              {t.kind === "search" && <SearchView key={t.nonce} vault={vault} initial={t.initial} active={t.key === active} files={files} sessions={sessions}
                onOpen={(p, line) => (files.find((f) => f.path === p)?.kind === "board" ? openBoard(p) : openNote(p, line))}
                onOpenSession={openSession} />}
              {t.kind === "query" && <QueryView vault={vault} saved={files.filter((f) => f.kind === "query")} onOpenNote={(p) => openNote(p)} />}
            </TabPane>
          ))}
          {!current && (
            <div className="empty">
              <span className="empty-mark"><LogoMark size={44} /></span>
              <p>Start a task, or open a note from the sidebar.</p>
              <div className="row">
                <button className="primary" onClick={() => setShowNewTask(true)}><Plus size={14} /> New task</button>
              </div>
            </div>
          )}
        </section>
      </main>
      <ContextMenu menu={menu} onClose={closeMenu} />
      {deleting && (
        <DeleteSessionDialog
          vault={vault}
          session={deleting}
          onDeleted={() => {
            closeTab(`session:${deleting.id}`);
            refresh();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
      {pathDialog && (
        <NameDialog
          title={pathDialog.mode === "folder" ? "New folder" : pathDialog.mode === "rename" ? "Rename" : pathDialog.mode === "keep" ? "Keep as note" : "Move to folder"}
          label={pathDialog.mode === "move" ? "Folder, relative to the vault (empty for the top level)" : "Path, relative to the vault"}
          initial={pathDialog.initial}
          placeholder={pathDialog.mode === "folder" ? "e.g. projects/website" : pathDialog.mode === "move" ? "e.g. archive" : ""}
          suggestions={pathDialog.mode === "move" ? dirs : undefined}
          hint={pathDialog.mode === "folder"
            ? "Parent folders are created as needed."
            : pathDialog.mode === "keep"
              ? "The memo becomes an ordinary note there, so it is no longer cleaned up."
              : "Relative links between notes are updated. Nothing is overwritten."}
          submit={pathDialog.mode === "folder" ? "Create" : pathDialog.mode === "rename" ? "Rename" : pathDialog.mode === "keep" ? "Keep" : "Move"}
          allowEmpty={pathDialog.mode === "move"}
          onSubmit={async (v) => {
            if (pathDialog.mode === "folder") {
              await api.createFolder(vault, v);
              await refresh();
            } else if (pathDialog.mode === "rename") {
              await api.movePath(vault, pathDialog.from!, v);
              await refresh();
            } else if (pathDialog.mode === "keep") {
              await api.keepScratch(vault, pathDialog.from!, v);
              await refresh();
            } else {
              await api.movePath(vault, pathDialog.from!, v ? `${v.replace(/\/+$/, "")}/` : "");
              await refresh();
            }
          }}
          onClose={() => setPathDialog(null)}
        />
      )}
      {naming && (
        <NameDialog
          title={{ spec: "New spec", workspace: "New workspace", playbook: "New playbook", note: "New note" }[naming.kind]}
          label={{ spec: "What is it for? (its title)", workspace: "Name", playbook: "Name", note: "Path, relative to the vault" }[naming.kind]}
          initial={naming.initial}
          placeholder={{ spec: "e.g. Show types on hover", workspace: "e.g. mq + docs", playbook: "e.g. release-notes, or bug-fix to edit Marq's own", note: "e.g. notes/meeting-2026-10" }[naming.kind]}
          hint={{
            spec: "Saved in specs/ with Requirements, Design, Tasks and Acceptance to fill in (or ask an agent: /marq:spec). Break down puts the tasks on a board.",
            playbook: "Saved as playbooks/<name>.md. Each ## heading is a phase, run in order in a new session; its text is what that session is told. Pick it with / in New task, or playbook: <name> in a request. The name of one of Marq's own (plan-first, bug-fix, refactor) gives you a copy to edit.",
            workspace: "Saved in workspaces/. Set its project and directories in the note, or save them from the New task dialog instead.",
            note: "Folders are created as needed. .md is added if you leave it out.",
          }[naming.kind]}
          submit="Create"
          onSubmit={(v) => createNamed(naming.kind, v)}
          onClose={() => setNaming(null)}
        />
      )}
      {sending && (
        <SendToSessionDialog
          vault={vault}
          excerpt={sending.excerpt}
          exclude={sending.exclude}
          onSent={(id, title, stay) => {
            refresh();
            if (stay) return;
            // Asked from a document about itself: with the screen split, the answer shows next to the document.
            if (split && sending.excerpt.target === id) {
              setTabs((prev) => (prev.some((t) => t.key === `session:${id}`) ? prev : [...prev, { key: `session:${id}`, kind: "session", id, title }]));
              openToSide(`session:${id}`);
            } else openSession(id, title);
          }}
          onNewTask={(prompt) => { setTaskPrompt(prompt); setShowNewTask(true); }}
          onClose={() => setSending(null)}
        />
      )}
      {newSchedule && vault && (
        <ScheduleDialog vault={vault} queries={files.filter((f) => f.kind === "query")} onClose={() => setNewSchedule(false)} onCreated={(p) => { refreshFiles(); openNote(p); }} />
      )}
      {showNewTask && (
        <NewTaskDialog vault={vault} initialPrompt={taskPrompt} initialReview={taskReview} context={taskContext ?? undefined}
          onClose={() => { setShowNewTask(false); setTaskPrompt(""); setTaskReview(undefined); setTaskContext(null); taskAfter.current = null; }}
          onStarted={(id, title) => { refresh(); openSession(id, title); taskAfter.current?.(); }}
          onSaved={(rel, queued) => { refresh(); if (!queued) openNote(`${vault}/${rel}`); }}
          onStartedCompare={(ids, title) => { openCompare(ids, title); taskAfter.current?.(); }} />
      )}
      {showQuickOpen && (
        <QuickOpen files={files} recent={recentFiles} sessions={sessions} onClose={() => setShowQuickOpen(false)}
          placeholder="Open a note, board or session…  (Tab narrows, ⇧↵ searches the text)"
          onOpen={(f) => openFile(f.path)}
          onOpenSession={(s) => openSession(s.id, s.title)} onSearch={openSearch} />
      )}
      {showPalette && (
        <CommandPalette getCommands={paletteCommands} onClose={() => setShowPalette(false)}
          onRun={(id) => commands[id]?.run()} />
      )}
      {newBoard && (
        <NameDialog title="New board" label="Board name" placeholder="e.g. sprint-12 or personal" submit="Create"
          hint="Saved as boards/<name>.md with Todo, Doing and Done. Add lists on the board or as ## headings in the Markdown."
          onSubmit={async (v) => openBoard(await api.boardCreate(vault, v))} onClose={() => setNewBoard(false)} />
      )}
      {showSettings && (
        <SettingsDialog onSaved={loadConfig} onClose={() => setShowSettings(false)}
          onOpenFile={() => (setShowSettings(false), void editConfigFile())} />
      )}
      {renamingSession && (
        <NameDialog title="Rename session" label="Title" initial={renamingSession.title} submit="Rename"
          onSubmit={async (v) => { await api.renameSession(vault, renamingSession.id, v); refresh(); }}
          onClose={() => setRenamingSession(null)} />
      )}
      {renaming && (
        <NameDialog title="Rename tab" label="Title" initial={tabs.find((t) => t.key === renaming)?.title ?? ""} submit="Rename"
          onSubmit={async (v) => setTabs((prev) => prev.map((t) => (t.key === renaming && t.kind === "terminal" ? { ...t, title: v, named: true } : t)))}
          onClose={() => setRenaming(null)} />
      )}
    </div>
    <StatusBar mode={mode} keymap={keymap} treeFocus={treeFocus} termFocus={termFocus}
      running={activeSessions.filter((s) => s.status === "running").length}
      waiting={activeSessions.filter((s) => s.status === "waiting").length} onActive={nextActive} />
    </div>
  );
}
