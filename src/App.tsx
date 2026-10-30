import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  Inbox, FilePlus2, Braces, ChevronRight, FileText, Folder, MessageSquare, X,
  ArrowLeftRight, Sparkles, Plus, ChevronsDownUp, ChevronsUpDown, GitBranch, Trash2, FolderOpen, CornerUpLeft, Square, ExternalLink, Pencil, FolderInput, FolderPlus, CircleCheck, CircleDashed, CircleSlash, RotateCw, GitPullRequest, GitCompare,
  Users, Palette, Settings as SettingsIcon, Check, Monitor, Sun, Moon, SquareTerminal, Columns3, Search, Timer, Play, Pause, Pin, PinOff, Bot,
} from "lucide-react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, FileEntry, Helper, Schedule, SessionInfo } from "./api";
import { ScheduleDialog } from "./AutomationDialogs";
import { setVaultFiles } from "./wikilinks";
import { NoteEditor } from "./NoteEditor";
import { SessionView } from "./SessionView";
import { CrewView } from "./CrewView";
import { QueryView } from "./QueryView";
import { TerminalView } from "./TerminalView";
import { BoardView } from "./BoardView";
import { QuickOpen } from "./QuickOpen";
import { SearchView } from "./SearchView";
import { CommandPalette } from "./CommandPalette";
import { StatusBar } from "./StatusBar";
import { DEFAULT_KEYS, FIND_EVENT, Keymap, Mode, TREE_KEYS, eventKey, lookup, mergeKeys } from "./keys";
import { NewTaskDialog } from "./NewTaskDialog";
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
import { Settings, setSettings, useSettings } from "./settings";
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
  /** `crew` is the crew note's vault-relative path when the tab was opened. */
  | { key: string; kind: "crew"; crew: string; title: string }
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

// Terminals are not restored: their shell ended with the app. Kinds no longer in the app are dropped too.
const RESTORED_KINDS = new Set(["note", "session", "query", "compare", "crew", "board", "search"]);

/**
 * The tabs open when the vault was last shown.
 * One-off state (a jump to a line, a just-created note) is dropped too.
 */
function loadTabs(vault: string | null): { tabs: Tab[]; active: string | null } {
  try {
    const v = vault && JSON.parse(localStorage.getItem(tabsKey(vault)) ?? "null");
    if (!v || !Array.isArray(v.tabs)) return { tabs: [], active: null };
    const tabs = (v.tabs as Tab[])
      .filter((t) => t && typeof t.key === "string" && RESTORED_KINDS.has(t.kind))
      .map((t) => (t.kind === "note" ? { ...t, jump: undefined, fresh: undefined } : t));
    return { tabs, active: tabs.some((t) => t.key === v.active) ? v.active : tabs[tabs.length - 1]?.key ?? null };
  } catch {
    return { tabs: [], active: null };
  }
}

type Tree = { dirs: Map<string, Tree>; files: FileEntry[] };

/** Folders come from `dirs` too, so empty ones are shown. */
function buildTree(files: FileEntry[], dirs: string[]): Tree {
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
  return root;
}

const fileLabel = (f: FileEntry) => f.title ?? f.rel.split("/").pop()!.replace(/\.md$/, "");

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
  /** Keyboard cursor: a folder's relative path or a file's path. */
  cursor?: string | null;
};

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

function DirRow({ name, path, depth, open, toggle, props }: {
  name: string; path: string; depth: number; open: boolean; toggle: (deep: boolean) => void; props: TreeProps;
}) {
  const drop = useDropTarget(path, props.onDrop);
  return (
    <a className={`tree-row dir ${drop.over ? "drop" : ""} ${props.cursor === path ? "cursor" : ""}`} style={{ paddingLeft: indent(depth) }} onClick={(e) => toggle(e.altKey)}
      draggable onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, path); e.dataTransfer.effectAllowed = "move"; }}
      title="⌥-click to open or close its subfolders too"
      onContextMenu={(e) => props.onDirMenu(e, path)} {...drop.props}>
      <ChevronRight size={12} className={`chev ${open ? "open" : ""}`} />
      {open ? <FolderOpen size={13} /> : <Folder size={13} />} <span className="ellipsis">{name}</span>
      <button className="tree-add" title={`New note in ${path}/`}
        onClick={(e) => { e.stopPropagation(); props.onNewIn(`${path}/`); }}>
        <Plus size={12} />
      </button>
    </a>
  );
}

const INDENT = 12;
const indent = (depth: number) => 8 + depth * INDENT;

/** Whether `path` is one of the files somewhere under `tree`. */
function containsPath(tree: Tree, path?: string | null): boolean {
  if (!path) return false;
  return tree.files.some((f) => f.path === path) || [...tree.dirs.values()].some((t) => containsPath(t, path));
}

/** An icon for notes with a special kind; plain notes get none. */
function fileIcon(f: FileEntry) {
  if (f.rel.startsWith("sessions/")) return <MessageSquare size={13} />;
  if (f.kind === "request") return <Inbox size={13} />;
  if (f.kind === "crew") return <Users size={13} />;
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
            <DirRow name={name} path={path} depth={depth} open={!closed.has(path)} toggle={(deep) => onToggle(path, deep)} props={props} />
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
        <a key={f.path} className={`tree-row ${activePath === f.path ? "on" : ""} ${props.cursor === f.path ? "cursor" : ""}`}
          style={{ paddingLeft: indent(depth) }} onClick={() => onOpen(f.path)} title={f.rel}
          draggable={!f.rel.startsWith("sessions/")}
          onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, f.rel); e.dataTransfer.effectAllowed = "move"; }}
          onContextMenu={(e) => onFileMenu(e, f)}>
          <span className="chev-slot" />
          <span className="icon-slot">{fileIcon(f)}</span>
          <span className="ellipsis">{fileLabel(f)}</span>
          {f.status && f.kind === "request" && <span className={`dot status-${f.status}`} />}
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

type Row = { key: string; dir: boolean; parent: string | null };

/** Rows in display order, skipping collapsed folders' contents. */
function visibleRows(tree: Tree, closed: Set<string>, prefix = "", parent: string | null = null): Row[] {
  const out: Row[] = [];
  for (const [name, sub] of tree.dirs) {
    const path = `${prefix}${name}`;
    out.push({ key: path, dir: true, parent });
    if (!closed.has(path)) out.push(...visibleRows(sub, closed, `${path}/`, path));
  }
  for (const f of tree.files) out.push({ key: f.path, dir: false, parent });
  return out;
}

const NotesTree = forwardRef<HTMLDivElement, Omit<TreeProps, "depth" | "prefix"> & { onBlur: () => void }>(function NotesTree(
  { onBlur, ...props },
  ref,
) {
  const drop = useDropTarget("", props.onDrop);
  return (
    <div ref={ref} tabIndex={-1} onBlur={onBlur} className={`notes-tree ${drop.over ? "drop" : ""}`} {...drop.props}>
      <TreeView {...props} depth={0} prefix="" />
    </div>
  );
});

const GROUPS = [
  // Finished sessions with changes that nobody has marked done or turned into a PR yet.
  { key: "review", label: "Needs review", match: (s: SessionInfo) =>
      s.status !== "running" && !s.review && (s.additions ?? 0) + (s.deletions ?? 0) > 0 },
];

/**
 * `active`: every running session and every one that needs the user, crew members included, those
 * waiting first. Other crew members are listed under their crew. The rest is `recent`.
 */
function groupSessions(sessions: SessionInfo[]) {
  const active = sessions.filter((s) => s.status === "waiting" || s.status === "running")
    .sort((a, b) => Number(b.status === "waiting") - Number(a.status === "waiting"));
  const used = new Set(active.map((s) => s.id));
  const groups = GROUPS.map((g) => {
    const items = sessions.filter((s) => !used.has(s.id) && g.match(s) && !s.crew);
    items.forEach((s) => used.add(s.id));
    return { ...g, items };
  }).filter((g) => g.items.length);
  return { active, groups, recent: sessions.filter((s) => !used.has(s.id) && !s.crew).slice(0, 100) };
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

/** An open/closed state remembered per sidebar section. */
function useSectionOpen(key: string, defaultOpen = true) {
  const storage = `marq.section.${key}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(storage);
      return v === null ? defaultOpen : v === "1";
    } catch {
      return defaultOpen;
    }
  });
  const set = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(storage, v ? "1" : "0");
    } catch {}
  };
  return [open, set] as const;
}

function Collapsible({ title, icon, count, children, defaultOpen = true, action }: {
  title: string; icon?: React.ReactNode; count?: number; children: React.ReactNode; defaultOpen?: boolean;
  /** A button shown at the right of the title. */
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useSectionOpen(title, defaultOpen);
  return (
    <div className="section">
      <a className="section-title" onClick={() => setOpen(!open)}>
        <ChevronRight size={11} className={`chev ${open ? "open" : ""}`} /> {icon} {title}
        {count !== undefined && count > 0 && <span className="count">{count}</span>}
        {action && <span className="section-actions" onClick={(e) => e.stopPropagation()}>{action}</span>}
      </a>
      {open && children}
    </div>
  );
}

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
  // Restored note and board tabs are checked against the vault's files once they are listed.
  const pruneTabs = useRef<string | null>(vault);
  const [filesVault, setFilesVault] = useState<string | null>(null);
  useEffect(() => {
    if (!vault) return;
    try {
      localStorage.setItem(tabsKey(vault), JSON.stringify({ tabs, active }));
    } catch {}
  }, [vault, tabs, active]);
  const [showNewTask, setShowNewTask] = useState(false);
  const [taskPrompt, setTaskPrompt] = useState("");
  // mq results the New task dialog hands to the agent, from a Run agent button.
  const [taskContext, setTaskContext] = useState<QueryContext | null>(null);
  const [sending, setSending] = useState<{ excerpt: Excerpt; exclude?: string } | null>(null);
  const sidebar = usePaneSize("sidebar", 300, 200, 600);
  const [naming, setNaming] = useState<{ kind: "note" | "crew"; initial: string } | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  // New folder, rename and move share one name dialog.
  const [pathDialog, setPathDialog] = useState<{ mode: "folder" | "rename" | "move"; from?: string; initial: string } | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [deleting, setDeleting] = useState<SessionInfo | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [theme, setTheme, themeFromConfig] = useTheme();
  // Pinned tabs get a row of their own above the others, or lead the one row.
  const pinnedRow = useSettings().tabs?.pinned_layout === "row";
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
    setFiles(fs);
    setFilesVault(vault);
    setDirs(ds);
    setSchedules(sc);
  }, [vault]);

  // Helper notes live under helpers/; a send writes the session it started into the note.
  const [helpers, setHelpers] = useState<Helper[]>([]);
  const [newHelper, setNewHelper] = useState(false);
  useEffect(() => {
    if (vault) api.listHelpers(vault).then(setHelpers).catch(() => {});
  }, [vault, files, sessions]);
  /** A helper's conversation, or its note while it has none. */
  const openHelper = (h: Helper) => {
    const s = h.session && sessions.find((x) => x.id === h.session);
    if (s) openSession(s.id, s.title);
    else openNote(h.path);
  };

  // Board queues and schedules run for the open vault, and only while Marq runs.
  useEffect(() => {
    if (vault) api.automationWatch(vault).catch(() => {});
  }, [vault]);

  const refresh = useCallback(async () => {
    if (!vault) return;
    await refreshFiles();
    const [list, approvals] = await Promise.all([api.listSessions(vault), api.listApprovals()]);
    const waiting = new Set(approvals.map((a) => a.session_id));
    setSessions(list.map((s) => (waiting.has(s.id) ? { ...s, status: "waiting" } : s)));
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

  // Sessions the board queues and schedules start on their own.
  useEffect(() => {
    const un = listen<{ session_id: string; title: string; from: string }>("automation://started", (e) => {
      void notify(`Started: ${e.payload.title}`, `From ${e.payload.from}`);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // ---- notifications and unread results ----
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const watch = useRef({ sessions, active });
  watch.current = { sessions, active };
  useEffect(() => {
    // A session counts as seen while its tab is open in a focused window.
    const attention = (id: string, body: string, markUnread: boolean) => {
      if (document.hasFocus() && watch.current.active === `session:${id}`) return;
      if (markUnread) setUnread((u) => new Set(u).add(id));
      void notify(watch.current.sessions.find((x) => x.id === id)?.title ?? "Marq", body);
    };
    const uns = [
      listen<{ session_id: string; result?: string }>("session://turn", (e) => {
        // Crew members take many short turns, and the crew view shows them.
        if (!watch.current.sessions.find((x) => x.id === e.payload.session_id)?.crew) {
          attention(e.payload.session_id, summary(e.payload.result ?? "") || "Finished", true);
        }
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

  // Only requests nobody has started. Started ones show up as sessions instead.
  // Requests waiting to run, and knowledge notes an agent wrote that nobody has checked yet.
  const inbox = useMemo(() => files.filter((f) =>
    (f.kind === "request" && f.status === "todo") || (f.kind === "knowledge" && f.status === "draft")), [files]);
  const tree = useMemo(() => buildTree(files, dirs), [files, dirs]);
  const crews = useMemo(() => files.filter((f) => f.kind === "crew"), [files]);
  // A crew's task board is shown on its Tasks tab, not with the other boards.
  const boards = useMemo(() => files.filter((f) => f.kind === "board" && !f.rel.startsWith("crews/")), [files]);
  const [newBoard, setNewBoard] = useState(false);
  const [closedDirs, setClosedDirs] = useClosedDirs();
  const allDirs = useMemo(() => dirPaths(tree), [tree]);

  // Reveal the open note in the tree, once it is listed.
  const activeTab = tabs.find((t) => t.key === active);
  const activeNote = activeTab?.kind === "note" ? activeTab.path : undefined;

  // Notes and boards opened recently, for ⌘P.
  const [recentFiles, setRecentFiles] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("marq.recentFiles") ?? "[]");
    } catch {
      return [];
    }
  });
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
  // Crews whose member list is open in the sidebar.
  const [openCrews, setOpenCrews] = useState<Set<string>>(new Set());
  const crewMembers = (f: FileEntry) => sessions.filter((s) => s.crew && s.crew.id === f.id);

  // Restored tabs on notes deleted or moved while the vault was closed.
  useEffect(() => {
    if (!vault || pruneTabs.current !== vault || filesVault !== vault) return;
    pruneTabs.current = null;
    const exists = new Set(files.map((f) => f.path));
    const keep = tabs.filter((t) => !((t.kind === "note" || t.kind === "board") && !exists.has(t.path)));
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
  const recentHeight = usePaneSize("recent", 180, 60, 600);
  // The crew list scrolls on its own, so many crews do not push Notes away.
  const crewsHeight = usePaneSize("crews", 240, 80, 800);
  const [recentOpen, setRecentOpen] = useSectionOpen("Recent");

  // A session got a new title (named from its prompt, or renamed): its tab follows.
  useEffect(() => {
    const un = listen<{ session_id: string; title: string }>("sessions://renamed", (e) => {
      setTabs((prev) => prev.map((t) => (t.kind === "session" && t.id === e.payload.session_id ? { ...t, title: e.payload.title } : t)));
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // A session handed its task to a crew (start_crew): show the crew.
  useEffect(() => {
    const un = listen<{ rel: string; title: string }>("crew://started", (e) => {
      setTabs((prev) => (prev.some((t) => t.key === `crew:${e.payload.rel}`)
        ? prev
        : [...prev, { key: `crew:${e.payload.rel}`, kind: "crew", crew: e.payload.rel, title: e.payload.title }]));
      setActive(`crew:${e.payload.rel}`);
      refresh();
    });
    return () => {
      un.then((f) => f());
    };
  }, [refresh]);


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

  const openTab = (tab: Tab) => {
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.key === tab.key);
      if (i < 0) return [...prev, tab];
      const next = [...prev];
      next[i] = { ...prev[i], ...tab } as Tab;
      return next;
    });
    setActive(tab.key);
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

  const openCrewAt = (rel: string, title: string) => openTab({ key: `crew:${rel}`, kind: "crew", crew: rel, title });
  const openCrew = (f: FileEntry) => openCrewAt(f.rel, fileLabel(f));

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
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      if (active === key) setActive(next[next.length - 1]?.key ?? null);
      return next;
    });
  };

  const create = async (rel: string, kind: "note" | "crew") => {
    const path = await api.createNote(vault!, rel, kind);
    openNote(path, undefined, true);
    refreshFiles();
    return path;
  };

  const createNamed = async (kind: "note" | "crew", name: string) => {
    const slug = name.replace(/\.md$/, "").replace(/[\s/]+/g, "-");
    const rel = kind === "crew" ? `crews/${slug}.md` : name.endsWith(".md") ? name : `${name}.md`;
    await create(rel.replace(/^\/+/, ""), kind);
  };

  /** Runs of the same request that have their own worktree, to compare. */
  const siblings = (s: SessionInfo) =>
    s.worktree && s.origin ? sessions.filter((x) => x.origin === s.origin && x.worktree && !x.crew) : [];

  const sessionMenu = (e: React.MouseEvent, s: SessionInfo) => {
    e.preventDefault();
    const running = s.status === "running" || s.status === "waiting";
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Open", icon: ExternalLink, onClick: () => openSession(s.id, s.title) },
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
        ...(f.kind === "crew" ? [{ label: "Open crew", icon: Users, onClick: () => openCrew(f) }] : []),
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
  const [keymap, setKeymap] = useState<Keymap>(DEFAULT_KEYS);
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

  // Reloaded on focus, so edits to config.toml apply without a restart.
  useEffect(() => {
    loadConfig();
    window.addEventListener("focus", loadConfig);
    return () => window.removeEventListener("focus", loadConfig);
  }, []);

  const rows = useMemo(() => visibleRows(tree, closedDirs), [tree, closedDirs]);

  const focusTree = () => {
    const keys = rows.map((r) => r.key);
    setTreeCursor((c) => (c && keys.includes(c) ? c : activeNote && keys.includes(activeNote) ? activeNote : keys[0] ?? null));
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

  /** A terminal opens where the current tab works: its terminal, its session's worktree, or the vault. */
  const terminalCwd = () => {
    if (activeTab?.kind === "terminal") return activeTab.cwd;
    if (activeTab?.kind === "session") return sessions.find((s) => s.id === activeTab.id)?.worktree?.path ?? vault!;
    return vault!;
  };

  const commands: Record<string, { label: string; run: () => void }> = {
    "mode.normal": { label: "Normal mode", run: () => setMode("normal") },
    "mode.tab": { label: "Tab mode", run: () => setMode("tab") },
    "mode.pane": { label: "Pane mode", run: () => setMode("pane") },
    "mode.locked": { label: "Lock: send every key to the focused view", run: () => setMode("locked") },
    palette: { label: "Command palette", run: () => setShowPalette(true) },
    "file.open": { label: "Open a note, board, crew or session…", run: () => setShowQuickOpen(true) },
    "search.open": { label: "Search notes", run: () => openSearch("") },
    find: { label: "Find in this note or in the changes", run: () => active && window.dispatchEvent(new CustomEvent(FIND_EVENT, { detail: active })) },
    "knowledge.gardening": {
      label: "Knowledge: merge session learnings into knowledge notes (daily schedule)",
      run: () => void api.knowledgeGardening(vault!).then((p) => { refreshFiles(); openNote(p); }),
    },
    "glossary.open": { label: "Glossary: terms, aliases and broader/narrower terms", run: () => void api.glossaryPath(vault!).then((p) => openNote(p)) },
    "task.new": { label: "New task", run: () => setShowNewTask(true) },
    "note.new": { label: "New note", run: () => setNaming({ kind: "note", initial: "notes/" }) },
    "board.new": { label: "New board", run: () => setNewBoard(true) },
    "helper.new": { label: "New helper (a standing session with a role, such as a translator)", run: () => setNewHelper(true) },
    "query.open": { label: "mq query", run: () => openTab({ key: "query", kind: "query", title: "mq query" }) },
    "terminal.new": { label: "New terminal", run: () => openTerminal(terminalCwd()) },
    "tab.close": { label: "Close tab", run: () => active && closeTab(active) },
    "tab.next": { label: "Next tab", run: () => cycleTab(1) },
    "tab.prev": { label: "Previous tab", run: () => cycleTab(-1) },
    "tab.pin": { label: "Pin or unpin tab", run: () => active && togglePin(active) },
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
    "content.focus": { label: "Focus the content", run: focusContent },
    "tree.down": { label: "Tree: down", run: () => moveTree(1) },
    "tree.up": { label: "Tree: up", run: () => moveTree(-1) },
    "tree.open": {
      label: "Tree: open",
      run: () => {
        const row = rows.find((r) => r.key === treeCursor);
        if (row?.dir && closedDirs.has(row.key)) toggleDir(row.key, false);
        else if (row?.dir) moveTree(1);
        else if (row) openNote(row.key);
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

  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (e.isComposing || !vault) return;
    const key = eventKey(e);
    if (!key) return;
    // Dialogs and menus keep their own keys.
    if (showQuickOpen || showPalette || showNewTask || naming || pathDialog || sending || deleting || menu || renaming || renamingSession || newBoard || newHelper || showSettings || newSchedule) return;
    let cmd: string | undefined;
    if (mode === "normal") {
      // ⌃T, ⌃P, ⌃G… belong to whatever runs in a terminal; the ⌘ shortcuts still work there.
      if (!key.includes("Cmd") && (e.target as Element).closest?.(".terminal-view")) return;
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
  const dialogOpen = !!(showQuickOpen || showPalette || showNewTask || naming || pathDialog || sending || deleting || renaming || renamingSession || menu || newBoard || newHelper || showSettings || newSchedule);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !dialogOpen && !treeFocus) requestAnimationFrame(focusContent);
    wasOpen.current = dialogOpen;
  }, [dialogOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!treeFocus && !dialogOpen) requestAnimationFrame(focusContent);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const paletteCommands = Object.entries(commands)
    .filter(([id]) => !id.startsWith("tree.") || id === "tree.focus")
    .map(([id, c]) => ({ id, label: c.label, keys: keymap.normal[id] ?? [] }));

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

  const tabMenu = (e: React.MouseEvent, t: Tab) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        t.pinned ? { label: "Unpin", icon: PinOff, onClick: () => togglePin(t.key) } : { label: "Pin", icon: Pin, onClick: () => togglePin(t.key) },
        { label: "Close", icon: X, onClick: () => closeTab(t.key) },
      ],
    });
  };

  const tabEl = (t: Tab) => (
    <div key={t.key} className={`tab ${t.key === active ? "on" : ""} ${t.pinned ? "pinned" : ""} ${t.key === dragTab ? "dragging" : ""}`}
      onClick={() => setActive(t.key)}
      draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragTab(t.key); }}
      onDragEnter={() => dragTab && moveTab(dragTab, t.key)}
      onDragOver={(e) => dragTab && e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
      onDragEnd={() => setDragTab(null)}
      onAuxClick={(e) => e.button === 1 && closeTab(t.key)}
      onContextMenu={(e) => tabMenu(e, t)}
      onDoubleClick={() => (t.kind === "terminal" ? setRenaming(t.key) : t.kind === "session" && setRenamingSession({ id: t.id, title: t.title }))}>
      {t.kind === "session" ? <MessageSquare size={15} /> : t.kind === "compare" ? <GitCompare size={15} /> : t.kind === "query" ? <Braces size={15} />
        : t.kind === "crew" ? <Users size={15} /> : t.kind === "terminal" ? <SquareTerminal size={15} />
        : t.kind === "board" ? <Columns3 size={15} /> : t.kind === "search" ? <Search size={15} /> : <FileText size={15} />}
      <span className="ellipsis">{t.title}</span>
      {t.pinned
        ? <button className="tab-close tab-pin" title="Unpin" onClick={(e) => { e.stopPropagation(); togglePin(t.key); }}><Pin size={12} /></button>
        : <button className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.key); }}><X size={13} /></button>}
    </div>
  );

  return (
    <div className="app-shell">
    <div className="app">
      <aside className="sidebar" style={{ width: sidebar.size }}>
        <div className="vault" title={`${vault}\nClick to switch vaults`} onClick={vaultMenu}>
          <div className="logo small"><LogoMark size={18} /></div>
          <span className="ellipsis">{vault.split("/").pop()}</span>
          <ChevronsUpDown size={12} className="vault-switch" />
          <button className="theme-btn" title="Theme" onClick={themeMenu}><Palette size={14} /></button>
          <button className="theme-btn" title="Settings (⌘,)" onClick={(e) => (e.stopPropagation(), setShowSettings(true))}><SettingsIcon size={14} /></button>
        </div>
        <button className="side-search" onClick={() => setShowQuickOpen(true)} title="Open a note, crew or session (⌘P) or search notes (⇧⌘F)">
          <Search size={13} /> <span>Search</span> <kbd>⌘P</kbd>
        </button>
        <button className="new-task" onClick={() => setShowNewTask(true)}>
          <Plus size={15} /> New task <kbd>⌘N</kbd>
        </button>
        <div className="quick">
          <button onClick={() => setNaming({ kind: "note", initial: "notes/" })} title="New note"><FilePlus2 size={14} /> Note</button>
          <button onClick={() => openTab({ key: "query", kind: "query", title: "mq query" })} title="mq query">
            <Braces size={14} /> Query
          </button>
          <button onClick={() => openTerminal(vault)} title="Terminal in the vault"><SquareTerminal size={14} /> Terminal</button>
        </div>
        <div className="side-scroll">
          <Collapsible title="Active" count={activeSessions.length}
            icon={activeSessions.length ? <span className={`dot ${activeSessions[0].status}`} /> : undefined}>
            {activeSessions.map((s) => (
              <a key={s.id} className={`recent-row ${current?.kind === "session" && current.id === s.id ? "on" : ""}`}
                onClick={() => openSession(s.id, s.title)} onContextMenu={(e) => sessionMenu(e, s)}
                title={[s.title, s.worktree?.branch, s.started.slice(0, 16).replace("T", " ")].filter(Boolean).join("\n")}>
                <span className={`dot ${s.status}`} />
                {s.crew && <Users size={11} className="muted" />}
                <span className="ellipsis">{s.title}</span>
                {s.status === "waiting" && <span className="row-badge waiting">needs you</span>}
                <span className="recent-ago">{ago(s.started)}</span>
              </a>
            ))}
            {activeSessions.length === 0 && <div className="muted small" style={{ padding: "2px 12px 6px" }}>Nothing is running.</div>}
          </Collapsible>
          {groups.map((g) => (
            <Collapsible key={g.key} title={g.label} count={g.items.length}
>
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
          {inbox.length > 0 && (
            <Collapsible title="Inbox" icon={<Inbox size={11} />} count={inbox.length}>
              {inbox.map((f) => (
                <a key={f.path} className={`inbox-row ${current?.kind === "note" && current.path === f.path ? "on" : ""}`}
                  onClick={() => openNote(f.path)} onContextMenu={(e) => fileMenu(e, f)}>
                  <span className={`pill status-${f.status}`}>{f.status}</span>
                  <span className="ellipsis">{fileLabel(f)}</span>
                </a>
              ))}
            </Collapsible>
          )}
          <Collapsible title="Boards" icon={<Columns3 size={11} />} count={boards.length}
            action={<button className="section-action" title="New board" onClick={() => setNewBoard(true)}><Plus size={13} /></button>}>
            {boards.map((f) => (
              <a key={f.path} className={`inbox-row ${current?.kind === "board" && current.path === f.path ? "on" : ""}`}
                onClick={() => openBoard(f.path)} onContextMenu={(e) => fileMenu(e, f)} title={f.rel}>
                <Columns3 size={13} /> <span className="ellipsis">{fileLabel(f)}</span>
              </a>
            ))}
            {boards.length === 0 && <a className="muted small pad" onClick={() => setNewBoard(true)}>Create a board for your tasks</a>}
          </Collapsible>
          <Collapsible title="Helpers" icon={<Bot size={11} />} count={helpers.length}
            action={<button className="section-action" title="New helper" onClick={() => setNewHelper(true)}><Plus size={13} /></button>}>
            {helpers.map((h) => {
              const s = h.session ? sessions.find((x) => x.id === h.session) : undefined;
              const on = s ? current?.kind === "session" && current.id === s.id : current?.kind === "note" && current.path === h.path;
              return (
                <a key={h.path} className={`inbox-row helper-row ${on ? "on" : ""}`} onClick={() => openHelper(h)}
                  title={`${h.summary}\nClick: ${s ? "open its conversation" : "edit its instructions"}`}>
                  <Bot size={13} /> <span className="ellipsis">{h.name}</span>
                  {s && <span className={`dot ${s.status}`} />}
                  <button className="helper-edit" title="Edit its instructions" onClick={(e) => { e.stopPropagation(); openNote(h.path); }}>
                    <Pencil size={11} />
                  </button>
                </a>
              );
            })}
            {helpers.length === 0 && (
              <a className="muted small pad" onClick={() => setNewHelper(true)}>Add a helper, such as a translator, to send requests to</a>
            )}
          </Collapsible>
          <Collapsible title="Crews" icon={<Users size={11} />} count={crews.length}
            action={<button className="section-action" title="New crew" onClick={() => setNaming({ kind: "crew", initial: "" })}>
              <Plus size={13} />
            </button>}>
            {crews.length > 0 && <div className="crew-list" style={{ maxHeight: crewsHeight.size }}>
            {crews.map((f) => {
              const members = crewMembers(f);
              const open = openCrews.has(f.path);
              // The crew's dot shows its most urgent member.
              const status = ["waiting", "running", "error"].find((st) => members.some((m) => m.status === st));
              return (
                <div key={f.path}>
                  <a className={`inbox-row crew-row ${current?.kind === "crew" && current.crew === f.rel ? "on" : ""}`}
                    onClick={() => openCrew(f)} onContextMenu={(e) => fileMenu(e, f)} title={f.rel}>
                    <button className="crew-row-toggle" disabled={!members.length} title={open ? "Hide members" : "Show members"}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenCrews((s) => { const n = new Set(s); n.has(f.path) ? n.delete(f.path) : n.add(f.path); return n; });
                      }}>
                      <ChevronRight size={11} className={`chev ${open ? "open" : ""}`} />
                    </button>
                    <Users size={13} /> <span className="ellipsis">{fileLabel(f)}</span>
                    <span className="spacer" />
                    {status && <span className={`dot ${status}`} />}
                    {members.length > 0 && <span className="count">{members.length}</span>}
                  </a>
                  {open && members.map((s) => (
                    <a key={s.id} className={`crew-member-row ${current?.kind === "session" && current.id === s.id ? "on" : ""}`}
                      onClick={() => openSession(s.id, s.title)} onContextMenu={(e) => sessionMenu(e, s)} title={s.title}>
                      <span className={`dot ${s.status}`} />
                      <span className="ellipsis">{s.crew!.role}</span>
                      {s.worktree && <span className="muted small ellipsis"><GitBranch size={10} /> {s.worktree.branch}</span>}
                    </a>
                  ))}
                </div>
              );
            })}
            </div>}
            {crews.length > 0 && <Resizer axis="y" sign={1} pane={crewsHeight} />}
            {crews.length === 0 && (
              <div className="muted small" style={{ padding: "2px 12px 6px" }}>
                Sessions that work on one project together. <a onClick={() => setNaming({ kind: "crew", initial: "" })}>New crew</a>
              </div>
            )}
          </Collapsible>
          <Collapsible title="Schedules" icon={<Timer size={11} />} count={schedules.length} defaultOpen={false}
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
          <Collapsible title="Notes" icon={<FileText size={11} />}
            action={<>
              <button className="section-action" title="Expand all folders" onClick={() => setClosedDirs(new Set())}>
                <ChevronsUpDown size={13} />
              </button>
              <button className="section-action" title="Collapse all folders" onClick={() => setClosedDirs(new Set(allDirs))}>
                <ChevronsDownUp size={13} />
              </button>
              <button className="section-action" title="New folder" onClick={() => setPathDialog({ mode: "folder", initial: "" })}>
                <FolderPlus size={13} />
              </button>
            </>}>
            <NotesTree ref={treeRef} cursor={treeFocus ? treeCursor : null} onBlur={() => setTreeFocus(false)}
              tree={tree} closed={closedDirs} onToggle={toggleDir} activePath={current?.kind === "note" ? current.path : undefined}
              onOpen={openFile} onNewIn={(dir) => setNaming({ kind: "note", initial: dir })} onFileMenu={fileMenu}
              onDirMenu={dirMenu} onDrop={(from, to) => { move(from, to ? `${to}/` : ""); }} />
          </Collapsible>
        </div>
        {recent.length > 0 && (
          <div className="recent-dock">
            {recentOpen && <Resizer axis="y" sign={-1} pane={recentHeight} />}
            <a className="section-title" onClick={() => setRecentOpen(!recentOpen)}>
              <ChevronRight size={11} className={`chev ${recentOpen ? "open" : ""}`} /> Recent
              <span className="count">{recent.length}</span>
            </a>
            {recentOpen && (
              <div className="recent-list" style={{ height: recentHeight.size }}>
                {recent.map((s) => (
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
            )}
          </div>
        )}
      </aside>
      <Resizer axis="x" sign={1} pane={sidebar} />
      <main>
        {pinnedRow ? (
          <>
            {pinned.length > 0 && <nav className="tabs pinned-row">{pinned.map(tabEl)}</nav>}
            <nav className="tabs">{unpinned.map(tabEl)}</nav>
          </>
        ) : (
          <nav className="tabs">
            {pinned.map(tabEl)}
            {pinned.length > 0 && unpinned.length > 0 && <span className="tab-sep" />}
            {unpinned.map(tabEl)}
          </nav>
        )}
        <section className="pane">
          {/* Tabs stay mounted so editor state and session streams survive switching. */}
          {tabs.map((t) => (
            <div key={t.key} className="pane-inner" tabIndex={-1} hidden={t.key !== active}>
              {t.kind === "note" && <NoteEditor vault={vault} path={t.path} active={t.key === active} jump={t.jump} fresh={t.fresh} onOpenSession={openSession} onOpenFile={openFile}
                onSendExcerpt={(excerpt) => setSending({ excerpt })} />}
              {t.kind === "compare" && <CompareView vault={vault} ids={t.ids} sessions={sessions} onOpenSession={openSession} onChanged={refresh} />}
              {t.kind === "session" && <SessionView vault={vault} sessionId={t.id} onOpenOrigin={openNote} onOpenSession={openSession}
                onOpenCrew={openCrewAt}
                onSendExcerpt={(excerpt) => setSending({ excerpt, exclude: t.id })} />}
              {t.kind === "terminal" && <TerminalView id={t.id} cwd={t.cwd} command={t.command} active={t.key === active}
                onTitle={(title) => setTabs((prev) => prev.map((x) => (x.key === t.key && x.kind === "terminal" && !x.named ? { ...x, title } : x)))} />}
              {t.kind === "board" && <BoardView vault={vault} path={t.path} files={files} recent={recentFiles}
                onOpenMarkdown={() => openNote(t.path)} onOpenFile={openFile} onCreateNote={(rel) => create(rel, "note")}
                onStartTask={(prompt) => { setTaskPrompt(prompt); setShowNewTask(true); }} />}
              {t.kind === "search" && <SearchView key={t.nonce} vault={vault} initial={t.initial} active={t.key === active}
                onOpen={(p, line) => (files.find((f) => f.path === p)?.kind === "board" ? openBoard(p) : openNote(p, line))} />}
              {t.kind === "query" && <QueryView vault={vault} saved={files.filter((f) => f.kind === "query")} onOpenNote={(p) => openNote(p)} />}
              {t.kind === "crew" && <CrewView vault={vault} crewKey={t.crew} onOpenNote={openNote} onOpenSession={openSession}
                onSendExcerpt={(excerpt) => setSending({ excerpt })} onOpenCrew={openCrewAt}
                files={files} recent={recentFiles} onOpenFile={openFile} onCreateNote={(rel) => create(rel, "note")} />}
            </div>
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
          title={pathDialog.mode === "folder" ? "New folder" : pathDialog.mode === "rename" ? "Rename" : "Move to folder"}
          label={pathDialog.mode === "move" ? "Folder, relative to the vault (empty for the top level)" : "Path, relative to the vault"}
          initial={pathDialog.initial}
          placeholder={pathDialog.mode === "folder" ? "e.g. projects/website" : pathDialog.mode === "move" ? "e.g. archive" : ""}
          suggestions={pathDialog.mode === "move" ? dirs : undefined}
          hint={pathDialog.mode === "folder"
            ? "Parent folders are created as needed."
            : "Relative links between notes are updated. Nothing is overwritten."}
          submit={pathDialog.mode === "folder" ? "Create" : pathDialog.mode === "rename" ? "Rename" : "Move"}
          allowEmpty={pathDialog.mode === "move"}
          onSubmit={async (v) => {
            if (pathDialog.mode === "folder") {
              await api.createFolder(vault, v);
              await refresh();
            } else if (pathDialog.mode === "rename") {
              await api.movePath(vault, pathDialog.from!, v);
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
          title={naming.kind === "crew" ? "New crew" : "New note"}
          label={naming.kind === "crew" ? "What will the crew work on? (a short name)" : "Path, relative to the vault"}
          initial={naming.initial}
          placeholder={naming.kind === "crew" ? "e.g. checkout-redesign" : "e.g. notes/meeting-2026-10"}
          hint={naming.kind === "crew"
            ? "Saved as crews/<name>.md with a lead, an implementer and a reviewer. Next, set the project and the goal in the note, then open the crew from the sidebar."
            : "Folders are created as needed. .md is added if you leave it out."}
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
          onSent={(id, title, stay) => { refresh(); if (!stay) openSession(id, title); }}
          onOpenFile={openFile}
          onNewTask={(prompt) => { setTaskPrompt(prompt); setShowNewTask(true); }}
          onClose={() => setSending(null)}
        />
      )}
      {newSchedule && vault && (
        <ScheduleDialog vault={vault} queries={files.filter((f) => f.kind === "query")} onClose={() => setNewSchedule(false)} onCreated={(p) => { refreshFiles(); openNote(p); }} />
      )}
      {showNewTask && (
        <NewTaskDialog vault={vault} initialPrompt={taskPrompt} context={taskContext ?? undefined}
          onClose={() => { setShowNewTask(false); setTaskPrompt(""); setTaskContext(null); }}
          onStarted={(id, title) => { refresh(); openSession(id, title); }}
          onStartedCrew={(rel, title) => { refresh(); openCrewAt(rel, title); }}
          onSaved={(rel) => { refresh(); openNote(`${vault}/${rel}`); }}
          onStartedCompare={(ids, title) => openCompare(ids, title)} />
      )}
      {showQuickOpen && (
        <QuickOpen files={files} recent={recentFiles} sessions={sessions} onClose={() => setShowQuickOpen(false)}
          placeholder="Open a note, board, crew or session…  (⇧↵ searches the text)"
          onOpen={(f) => (f.kind === "crew" ? openCrew(f) : openFile(f.path))}
          onOpenSession={(s) => openSession(s.id, s.title)} onSearch={openSearch} />
      )}
      {showPalette && (
        <CommandPalette commands={paletteCommands} onClose={() => setShowPalette(false)}
          onRun={(id) => commands[id]?.run()} />
      )}
      {newBoard && (
        <NameDialog title="New board" label="Board name" placeholder="e.g. sprint-12 or personal" submit="Create"
          hint="Saved as boards/<name>.md with Todo, Doing and Done. Add lists on the board or as ## headings in the Markdown."
          onSubmit={async (v) => openBoard(await api.boardCreate(vault, v))} onClose={() => setNewBoard(false)} />
      )}
      {newHelper && (
        <NameDialog title="New helper" label="Name" placeholder="e.g. 翻訳 or Proofreader" submit="Create"
          hint="Saved as helpers/<name>.md. Write its role in the note; then pick it in Send to session, or open it here and chat."
          onSubmit={async (v) => { const p = await api.createHelper(vault, v); await refreshFiles(); openNote(p); }}
          onClose={() => setNewHelper(false)} />
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
