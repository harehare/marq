import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  CalendarDays, Inbox, FilePlus2, ListPlus, Braces, ChevronRight, FileText, Folder, MessageSquare, X,
  ArrowLeftRight, Sparkles, Plus, ChevronsDownUp, ChevronsUpDown, GitBranch, Trash2, FolderOpen, CornerUpLeft, Square, ExternalLink, Pencil, FolderInput, FolderPlus, CircleCheck, CircleDashed, CircleSlash, RotateCw, GitPullRequest,
  Users, Palette, Check, Monitor, Sun, Moon, SquareTerminal, Columns3, Search, Globe,
} from "lucide-react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, FileEntry, SessionInfo } from "./api";
import { NoteEditor } from "./NoteEditor";
import { SessionView } from "./SessionView";
import { CrewView } from "./CrewView";
import { QueryView } from "./QueryView";
import { TerminalView } from "./TerminalView";
import { BoardView } from "./BoardView";
import { QuickOpen } from "./QuickOpen";
import { SearchView } from "./SearchView";
import { BrowserView } from "./BrowserView";
import { CommandPalette } from "./CommandPalette";
import { StatusBar } from "./StatusBar";
import { DEFAULT_KEYS, Keymap, Mode, TREE_KEYS, eventKey, lookup, mergeKeys } from "./keys";
import { NewTaskDialog } from "./NewTaskDialog";
import { LogoMark } from "./Logo";
import { Resizer, usePaneSize } from "./Resizer";
import { Excerpt, SendToSessionDialog } from "./SendToSessionDialog";
import { NameDialog } from "./NameDialog";
import { ContextMenu, MenuItem, MenuState } from "./ContextMenu";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { PALETTES, useTheme } from "./theme";
import { Settings, setSettings } from "./settings";
import "./App.css";
import { notify } from "./notify";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Tab =
  | { key: string; kind: "note"; path: string; title: string; jump?: { line: number; nonce: number }; fresh?: boolean }
  | { key: string; kind: "session"; id: string; title: string }
  | { key: string; kind: "query"; title: string }
  /** `crew` is the crew note's vault-relative path when the tab was opened. */
  | { key: string; kind: "crew"; crew: string; title: string }
  | { key: string; kind: "board"; path: string; title: string }
  /** `initial` changes (with a new nonce) when a search is started from elsewhere. */
  | { key: string; kind: "search"; title: string; initial: string; nonce: number }
  /** `nonce` changes when the same tab is asked to show `url` again. */
  | { key: string; kind: "browser"; url: string; title: string; nonce?: number }
  /** `named`: renamed by the user, so the shell's title no longer applies. */
  | { key: string; kind: "terminal"; id: string; cwd: string; title: string; command?: string; named?: boolean };

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

const INDENT = 16;
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
  { key: "waiting", label: "Needs you", match: (s: SessionInfo) => s.status === "waiting" },
  { key: "running", label: "Running", match: (s: SessionInfo) => s.status === "running" },
  // Finished sessions with changes that nobody has marked done or turned into a PR yet.
  { key: "review", label: "Needs review", match: (s: SessionInfo) =>
      s.status !== "running" && !s.review && (s.additions ?? 0) + (s.deletions ?? 0) > 0 },
  { key: "recent", label: "Recent", match: () => true },
];

/** Crew members are listed under their crew, except when they need the user. */
function groupSessions(sessions: SessionInfo[]) {
  const used = new Set<string>();
  return GROUPS.map((g) => {
    const items = sessions.filter((s) => !used.has(s.id) && g.match(s) && (!s.crew || g.key === "waiting")).slice(0, g.key === "recent" ? 30 : undefined);
    items.forEach((s) => used.add(s.id));
    return { ...g, items };
  }).filter((g) => g.items.length);
}

function Collapsible({ title, icon, count, children, defaultOpen = true, action }: {
  title: string; icon?: React.ReactNode; count?: number; children: React.ReactNode; defaultOpen?: boolean;
  /** A button shown at the right of the title. */
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [taskPrompt, setTaskPrompt] = useState("");
  const [sending, setSending] = useState<{ excerpt: Excerpt; exclude?: string } | null>(null);
  const sidebar = usePaneSize("sidebar", 300, 200, 600);
  const [naming, setNaming] = useState<{ kind: "note" | "request" | "crew"; initial: string } | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  // New folder, rename and move share one name dialog.
  const [pathDialog, setPathDialog] = useState<{ mode: "folder" | "rename" | "move"; from?: string; initial: string } | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [deleting, setDeleting] = useState<SessionInfo | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [theme, setTheme, themeFromConfig] = useTheme();
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
    const [fs, ds] = await Promise.all([api.listFiles(vault), api.listDirs(vault)]);
    setFiles(fs);
    setDirs(ds);
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
    const uns = ["claude://exit", "claude://turn", "claude://approval", "vault://changed", "sessions://changed"].map((ev) => listen(ev, soon));
    return () => {
      clearTimeout(timer);
      uns.forEach((u) => u.then((f) => f()));
    };
  }, [refresh]);

  // Only requests nobody has started. Started ones show up as sessions instead.
  const inbox = useMemo(() => files.filter((f) => f.kind === "request" && f.status === "todo"), [files]);
  const tree = useMemo(() => buildTree(files, dirs), [files, dirs]);
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
      listen<{ session_id: string }>("claude://turn", (e) => {
        // Crew members take many short turns, and the crew view shows them.
        if (!watch.current.sessions.find((x) => x.id === e.payload.session_id)?.crew) attention(e.payload.session_id, "Finished", true);
      }),
      listen<{ session_id: string; status: string }>("claude://exit", (e) => {
        if (e.payload.status === "error") attention(e.payload.session_id, "Stopped with an error", true);
      }),
      listen<{ session_id: string; tool_name?: string; answered?: boolean }>("claude://approval", (e) => {
        if (!e.payload.answered) attention(e.payload.session_id, `Needs your approval${e.payload.tool_name ? `: ${e.payload.tool_name}` : ""}`, false);
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

  const crews = useMemo(() => files.filter((f) => f.kind === "crew"), [files]);
  const boards = useMemo(() => files.filter((f) => f.kind === "board"), [files]);
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
  const groups = useMemo(() => groupSessions(sessions), [sessions]);

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
    setVault(dir);
    setTabs([]);
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

  /** A browser tab; `key` reuses one (e.g. a session's preview tab). */
  const openBrowser = (url = "", title?: string, key?: string) =>
    openTab({ key: key ?? `browser:${crypto.randomUUID()}`, kind: "browser", url, title: title ?? "Browser", nonce: Date.now() });

  // open_preview from a session: one preview tab per session, reloaded on each call.
  useEffect(() => {
    const un = listen<{ session: string; url: string; title?: string }>("marq://preview", (e) =>
      openBrowser(e.payload.url, e.payload.title ?? "Preview", `browser:preview:${e.payload.session}`));
    return () => {
      un.then((f) => f());
    };
  });

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

  const openSession = (id: string, title: string) => {
    openTab({ key: `session:${id}`, kind: "session", id, title });
    refresh();
  };

  const openCrewAt = (rel: string, title: string) => openTab({ key: `crew:${rel}`, kind: "crew", crew: rel, title });
  const openCrew = (f: FileEntry) => openCrewAt(f.rel, fileLabel(f));

  const closeTab = (key: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      if (active === key) setActive(next[next.length - 1]?.key ?? null);
      return next;
    });
  };

  const today = () => new Date().toISOString().slice(0, 10);

  const create = async (rel: string, kind: "note" | "request" | "daily" | "crew") => {
    const path = await api.createNote(vault!, rel, kind);
    openNote(path, undefined, true);
    refreshFiles();
  };

  const openDaily = async () => {
    if (!vault) return;
    const rel = `daily/${today()}.md`;
    // An existing daily note is simply opened.
    if (files.some((f) => f.rel === rel)) openNote(`${vault}/${rel}`);
    else await create(rel, "daily").catch(() => openNote(`${vault}/${rel}`));
  };

  const createNamed = async (kind: "note" | "request" | "crew", name: string) => {
    const slug = name.replace(/\.md$/, "").replace(/[\s/]+/g, "-");
    const rel =
      kind === "request"
        ? `requests/${today()}-${slug}.md`
        : kind === "crew"
          ? `crews/${slug}.md`
          : name.endsWith(".md") ? name : `${name}.md`;
    await create(rel.replace(/^\/+/, ""), kind);
  };

  const sessionMenu = (e: React.MouseEvent, s: SessionInfo) => {
    e.preventDefault();
    const running = s.status === "running" || s.status === "waiting";
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Open", icon: ExternalLink, onClick: () => openSession(s.id, s.title) },
        {
          label: "Open origin note",
          icon: CornerUpLeft,
          onClick: async () => {
            const o = await api.sessionOrigin(vault!, s.id);
            if (o) openNote(o.path, o.line);
          },
        },
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
  const [treeFocus, setTreeFocus] = useState(false);
  const [treeCursor, setTreeCursor] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // Reloaded on focus, so edits to config.toml apply without a restart.
  useEffect(() => {
    const load = () =>
      api.readConfig().then((c) => {
        setKeymap(mergeKeys(c));
        setSettings(c as Settings);
        themeFromConfig((c as Settings).appearance?.palette, (c as Settings).appearance?.mode);
      }, (e) => console.error(e));
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
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
    "file.open": { label: "Open a note…", run: () => setShowQuickOpen(true) },
    "search.open": { label: "Search notes", run: () => openSearch("") },
    "task.new": { label: "New task", run: () => setShowNewTask(true) },
    "note.new": { label: "New note", run: () => setNaming({ kind: "note", initial: "notes/" }) },
    "daily.open": { label: "Today's note", run: () => void openDaily() },
    "board.new": { label: "New board", run: () => setNewBoard(true) },
    "query.open": { label: "mq query", run: () => openTab({ key: "query", kind: "query", title: "mq query" }) },
    "browser.new": { label: "New browser tab", run: () => openBrowser() },
    "terminal.new": { label: "New terminal", run: () => openTerminal(terminalCwd()) },
    "tab.close": { label: "Close tab", run: () => active && closeTab(active) },
    "tab.next": { label: "Next tab", run: () => cycleTab(1) },
    "tab.prev": { label: "Previous tab", run: () => cycleTab(-1) },
    "tab.rename": { label: "Rename terminal tab", run: () => activeTab?.kind === "terminal" && setRenaming(activeTab.key) },
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
    "settings.open": {
      label: "Settings (config.toml)",
      run: () => api.configPath().then((p) => openTerminal(p.replace(/\/[^/]*$/, ""), "config.toml", `\${EDITOR:-vi} '${p}'`)),
    },
  };

  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (e.isComposing || !vault) return;
    const key = eventKey(e);
    if (!key) return;
    // Dialogs and menus keep their own keys.
    if (showQuickOpen || showPalette || showNewTask || naming || pathDialog || sending || deleting || menu || renaming || newBoard) return;
    let cmd: string | undefined;
    if (mode === "normal") {
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
  const dialogOpen = !!(showQuickOpen || showPalette || showNewTask || naming || pathDialog || sending || deleting || renaming || menu || newBoard);
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
          <div className="logo"><LogoMark size={30} /></div>
          <h1>Marq</h1>
          <p>Mark up your notes, query them with mq: every note can start a Claude session, and every session comes back as a note.</p>
          <ul className="welcome-points">
            <li><Sparkles size={14} /> Ask Claude from any heading</li>
            <li><ArrowLeftRight size={14} /> Jump between notes and sessions</li>
            <li><Braces size={14} /> Query notes with mq, live in the preview</li>
          </ul>
          <button className="primary big" onClick={pickVault}>Open a vault folder</button>
        </div>
      </div>
    );
  }

  const current = tabs.find((t) => t.key === active);

  return (
    <div className="app-shell">
    <div className="app">
      <aside className="sidebar" style={{ width: sidebar.size }}>
        <div className="vault" title={`${vault}\nClick to switch vaults`} onClick={vaultMenu}>
          <div className="logo small"><LogoMark size={15} /></div>
          <span className="ellipsis">{vault.split("/").pop()}</span>
          <ChevronsUpDown size={12} className="vault-switch" />
          <button className="theme-btn" title="Theme" onClick={themeMenu}><Palette size={14} /></button>
        </div>
        <button className="side-search" onClick={() => setShowQuickOpen(true)} title="Open a note (⌘P) or search notes (⇧⌘F)">
          <Search size={13} /> <span>Search</span> <kbd>⌘P</kbd>
        </button>
        <button className="new-task" onClick={() => setShowNewTask(true)}>
          <Plus size={15} /> New task <kbd>⌘N</kbd>
        </button>
        <div className="quick">
          <button onClick={openDaily} title="Today's note"><CalendarDays size={14} /> Today</button>
          <button onClick={() => setNaming({ kind: "note", initial: "notes/" })} title="New note"><FilePlus2 size={14} /> Note</button>
          <button onClick={() => setNaming({ kind: "request", initial: "" })} title="New request note"><ListPlus size={14} /> Request</button>
          <button onClick={() => openTab({ key: "query", kind: "query", title: "mq query" })} title="mq query">
            <Braces size={14} /> Query
          </button>
          <button onClick={() => openTerminal(vault)} title="Terminal in the vault"><SquareTerminal size={14} /> Terminal</button>
        </div>
        <div className="side-scroll">
          {groups.map((g) => (
            <Collapsible key={g.key} title={g.label} count={g.items.length}
              icon={g.key === "running" ? <span className="dot running" /> : g.key === "waiting" ? <span className="dot waiting" /> : undefined}>
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
          <Collapsible title="Crews" icon={<Users size={11} />} count={crews.length}
            action={<button className="section-action" title="New crew" onClick={() => setNaming({ kind: "crew", initial: "" })}>
              <Plus size={13} />
            </button>}>
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
            {crews.length === 0 && (
              <div className="muted small" style={{ padding: "2px 12px 6px" }}>
                Sessions that work on one project together. <a onClick={() => setNaming({ kind: "crew", initial: "" })}>New crew</a>
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
      </aside>
      <Resizer axis="x" sign={1} pane={sidebar} />
      <main>
        <nav className="tabs">
          {tabs.map((t) => (
            <div key={t.key} className={`tab ${t.key === active ? "on" : ""}`} onClick={() => setActive(t.key)}
              onAuxClick={(e) => e.button === 1 && closeTab(t.key)}
              onDoubleClick={() => t.kind === "terminal" && setRenaming(t.key)}>
              {t.kind === "session" ? <MessageSquare size={15} /> : t.kind === "query" ? <Braces size={15} />
                : t.kind === "crew" ? <Users size={15} /> : t.kind === "terminal" ? <SquareTerminal size={15} />
                : t.kind === "board" ? <Columns3 size={15} /> : t.kind === "search" ? <Search size={15} />
                : t.kind === "browser" ? <Globe size={15} /> : <FileText size={15} />}
              <span className="ellipsis">{t.title}</span>
              <button className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.key); }}><X size={13} /></button>
            </div>
          ))}
        </nav>
        <section className="pane">
          {/* Tabs stay mounted so editor state and session streams survive switching. */}
          {tabs.map((t) => (
            <div key={t.key} className="pane-inner" tabIndex={-1} hidden={t.key !== active}>
              {t.kind === "note" && <NoteEditor vault={vault} path={t.path} jump={t.jump} fresh={t.fresh} onOpenSession={openSession}
                onSendExcerpt={(excerpt) => setSending({ excerpt })} />}
              {t.kind === "session" && <SessionView vault={vault} sessionId={t.id} onOpenOrigin={openNote} onOpenSession={openSession}
                onOpenCrew={openCrewAt}
                onSendExcerpt={(excerpt) => setSending({ excerpt, exclude: t.id })} />}
              {t.kind === "terminal" && <TerminalView id={t.id} cwd={t.cwd} command={t.command} active={t.key === active}
                onTitle={(title) => setTabs((prev) => prev.map((x) => (x.key === t.key && x.kind === "terminal" && !x.named ? { ...x, title } : x)))} />}
              {t.kind === "board" && <BoardView vault={vault} path={t.path} onOpenMarkdown={() => openNote(t.path)}
                onStartTask={(prompt) => { setTaskPrompt(prompt); setShowNewTask(true); }} />}
              {t.kind === "browser" && <BrowserView url={t.url} nonce={t.nonce}
                onTitle={(title) => setTabs((prev) => prev.map((x) => (x.key === t.key ? { ...x, title } : x)))} />}
              {t.kind === "search" && <SearchView key={t.nonce} vault={vault} initial={t.initial} active={t.key === active}
                onOpen={(p, line) => (files.find((f) => f.path === p)?.kind === "board" ? openBoard(p) : openNote(p, line))} />}
              {t.kind === "query" && <QueryView vault={vault} saved={files.filter((f) => f.kind === "query")} onOpenNote={(p) => openNote(p)} />}
              {t.kind === "crew" && <CrewView vault={vault} crewKey={t.crew} onOpenNote={openNote} onOpenSession={openSession}
                onSendExcerpt={(excerpt) => setSending({ excerpt })} onOpenCrew={openCrewAt} />}
            </div>
          ))}
          {!current && (
            <div className="empty">
              <span className="empty-mark"><LogoMark size={44} /></span>
              <p>Start a task, or open a note from the sidebar.</p>
              <div className="row">
                <button className="primary" onClick={() => setShowNewTask(true)}><Plus size={14} /> New task</button>
                <button onClick={openDaily}><CalendarDays size={14} /> Today</button>
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
          title={naming.kind === "request" ? "New request" : naming.kind === "crew" ? "New crew" : "New note"}
          label={naming.kind === "request" ? "What is the request about? (a short name)" : naming.kind === "crew" ? "What will the crew work on? (a short name)" : "Path, relative to the vault"}
          initial={naming.initial}
          placeholder={naming.kind === "request" ? "e.g. fix-login-timeout" : naming.kind === "crew" ? "e.g. checkout-redesign" : "e.g. notes/meeting-2026-10"}
          hint={naming.kind === "request"
            ? `Saved as requests/${today()}-<name>.md. Use New task to write the prompt and start right away.`
            : naming.kind === "crew"
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
          onSent={(id, title) => { refresh(); openSession(id, title); }}
          onNewTask={(prompt) => { setTaskPrompt(prompt); setShowNewTask(true); }}
          onClose={() => setSending(null)}
        />
      )}
      {showNewTask && (
        <NewTaskDialog vault={vault} initialPrompt={taskPrompt}
          onClose={() => { setShowNewTask(false); setTaskPrompt(""); }}
          onStarted={(id, title) => { refresh(); openSession(id, title); }}
          onStartedCrew={(rel, title) => { refresh(); openCrewAt(rel, title); }} />
      )}
      {showQuickOpen && (
        <QuickOpen files={files} recent={recentFiles} onClose={() => setShowQuickOpen(false)}
          onOpen={(f) => openFile(f.path)} onSearch={openSearch} />
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
      {renaming && (
        <NameDialog title="Rename tab" label="Title" initial={tabs.find((t) => t.key === renaming)?.title ?? ""} submit="Rename"
          onSubmit={async (v) => setTabs((prev) => prev.map((t) => (t.key === renaming && t.kind === "terminal" ? { ...t, title: v, named: true } : t)))}
          onClose={() => setRenaming(null)} />
      )}
    </div>
    <StatusBar mode={mode} keymap={keymap} treeFocus={treeFocus} />
    </div>
  );
}
