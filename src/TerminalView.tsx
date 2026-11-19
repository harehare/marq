import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api";
import { getSettings, quote, useSettings, type Settings } from "./settings";

/** xterm colors from the app's CSS tokens. */
function themeFromCss(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--bg"),
    foreground: v("--fg"),
    cursor: v("--accent"),
    cursorAccent: v("--bg"),
    selectionBackground: v("--selection"),
    red: v("--err"),
    green: v("--ok"),
    yellow: v("--accent"),
    blue: v("--info"),
    magenta: v("--info"),
    cyan: v("--run"),
  };
}

/** `[terminal] font`, else the app's monospace font. */
function fontFamily(t: Settings["terminal"]) {
  return t?.font ? `${quote(t.font)}, ui-monospace, Menlo, monospace` : getComputedStyle(document.documentElement).getPropertyValue("--font-mono");
}

/** `[terminal] ligatures`: off unless asked for, since they cost the GPU renderer. */
const wantsLigatures = (t: Settings["terminal"]) => t?.ligatures === true;

/**
 * Draws with the GPU, much faster than the DOM renderer on heavy output, unless ligatures are on: the WebGL
 * renderer draws glyph by glyph, so it cannot shape them. Falls back to the DOM if WebGL is unavailable or lost.
 */
function attachRenderer(term: Terminal, ligatures: boolean): () => void {
  if (ligatures) return () => {};
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
    return () => gl.dispose();
  } catch {
    return () => {};
  }
}

/** A login shell (or `command`) in `cwd`. It lives as long as its pane. */
function TerminalPane({ id, cwd, command, active, multi, focused, style, onTitle, onExit, onFocus }: {
  id: string; cwd: string; command?: string;
  /** The pane is the one that takes the keys, in a tab that is shown. */
  active: boolean;
  /** The tab has more than one pane; `focused` marks the one with the keys. */
  multi: boolean; focused: boolean;
  style: React.CSSProperties;
  onTitle: (title: string) => void; onExit: () => void; onFocus: () => void;
}) {
  const onTitleRef = useRef(onTitle);
  const onExitRef = useRef(onExit);
  useLayoutEffect(() => {
    onTitleRef.current = onTitle;
    onExitRef.current = onExit;
  });
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // Disposes the WebGL renderer, if one is attached.
  const rendererRef = useRef<() => void>(() => {});
  const ligaturesRef = useRef(wantsLigatures(getSettings().terminal));
  const [exited, setExited] = useState(false);

  useEffect(() => {
    // A PTY per mount, so a remount (StrictMode) never sees the old shell's exit.
    const pty = `${id}:${crypto.randomUUID().slice(0, 8)}`;
    const t = getSettings().terminal;
    const term = new Terminal({
      fontFamily: fontFamily(t),
      fontSize: t?.font_size ?? 13,
      cursorStyle: t?.cursor ?? "block",
      cursorBlink: true,
      theme: themeFromCss(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();
    rendererRef.current = attachRenderer(term, wantsLigatures(t));
    termRef.current = term;
    fitRef.current = fit;

    const unData = listen<{ id: string; data: string }>("terminal://data", (e) => {
      if (e.payload.id === pty) term.write(e.payload.data);
    });
    const unExit = listen<{ id: string }>("terminal://exit", (e) => {
      if (e.payload.id !== pty) return;
      setExited(true);
      onExitRef.current();
    });
    // One write at a time, in order: writes run off the main thread, so two in flight could land swapped,
    // and a swapped reply to a query of the shell's (cursor position, device attributes) shows up as raw
    // escape codes. What is typed while one is in flight goes in the next.
    let pending = "";
    let writing = false;
    const send = async (d: string) => {
      pending += d;
      if (writing) return;
      writing = true;
      while (pending) {
        const data = pending;
        pending = "";
        await api.terminalWrite(pty, data).catch(() => {});
      }
      writing = false;
    };
    const input = term.onData(send);
    // xterm sends a bare CR for Enter whatever the modifiers, so Shift+Enter would submit. Send
    // ESC CR instead (Meta+Enter), which Claude Code and most line editors take as a new line.
    term.attachCustomKeyEventHandler((e) => {
      if (e.key !== "Enter" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return true;
      if (e.type === "keydown") {
        e.preventDefault();
        send("\x1b\r");
      }
      return false;
    });
    const title = term.onTitleChange((t) => t && onTitleRef.current(t));
    const resize = term.onResize(({ cols, rows }) => api.terminalResize(pty, cols, rows).catch(() => {}));
    // Start the shell once listening, so its first prompt is not lost; close it if unmounted meanwhile.
    let disposed = false;
    Promise.all([unData, unExit])
      .then(() => api.terminalOpen(pty, cwd, term.cols, term.rows, command))
      .then(() => {
        if (disposed) api.terminalClose(pty);
      })
      .catch((e: unknown) => term.write(`\r\n${e}\r\n`));

    // Follow window resizes and theme switches.
    const ro = new ResizeObserver(() => host.current?.offsetParent && fit.fit());
    ro.observe(host.current!);
    const retheme = () => (term.options.theme = themeFromCss());
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", retheme);

    return () => {
      disposed = true;
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", retheme);
      input.dispose();
      resize.dispose();
      title.dispose();
      unData.then((f) => f());
      unExit.then((f) => f());
      api.terminalClose(pty);
      rendererRef.current();
      rendererRef.current = () => {};
      term.dispose();
    };
  }, [id, cwd, command]);

  // Settings edited while the terminal is open.
  const settings = useSettings();
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontFamily(settings.terminal);
    term.options.fontSize = settings.terminal?.font_size ?? 13;
    term.options.cursorStyle = settings.terminal?.cursor ?? "block";
    const ligatures = wantsLigatures(settings.terminal);
    if (ligatures !== ligaturesRef.current) {
      ligaturesRef.current = ligatures;
      rendererRef.current();
      rendererRef.current = attachRenderer(term, ligatures);
    }
    fitRef.current?.fit();
  }, [settings]);

  // Hidden tabs have no size; fit and focus when shown again.
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
  }, [active]);

  return (
    <div className={`terminal-pane ${multi ? "multi" : ""} ${multi && focused ? "focused" : ""}`} style={style} onFocus={onFocus}>
      <div ref={host} className="terminal-host" />
      {exited && <div className="terminal-exited muted small">The shell exited. Close the {multi ? "pane" : "tab"} or open a new terminal.</div>}
    </div>
  );
}

/** The panes of a tab as a tree: a leaf is a shell, a split puts two subtrees side by side (`row`) or one above the other. */
type Node = { k: "leaf"; id: string } | { k: "split"; dir: "row" | "column"; ratio: number; a: Node; b: Node };
type Rect = { x: number; y: number; w: number; h: number };
type Divider = { path: string; dir: "row" | "column"; at: number; r: Rect };

const FULL: Rect = { x: 0, y: 0, w: 100, h: 100 };

/** Where each pane and divider goes, in percent of the tab. */
function layout(n: Node, r: Rect, path: string, leaves: { id: string; r: Rect }[], dividers: Divider[]) {
  if (n.k === "leaf") return void leaves.push({ id: n.id, r });
  const row = n.dir === "row";
  const first = row ? r.w * n.ratio : r.h * n.ratio;
  layout(n.a, row ? { ...r, w: first } : { ...r, h: first }, path + "a", leaves, dividers);
  layout(n.b, row ? { ...r, x: r.x + first, w: r.w - first } : { ...r, y: r.y + first, h: r.h - first }, path + "b", leaves, dividers);
  dividers.push({ path, dir: n.dir, at: (row ? r.x : r.y) + first, r });
}

const leafIds = (n: Node): string[] => (n.k === "leaf" ? [n.id] : [...leafIds(n.a), ...leafIds(n.b)]);

const splitLeaf = (n: Node, id: string, dir: "row" | "column", fresh: string): Node =>
  n.k === "leaf"
    ? n.id === id ? { k: "split", dir, ratio: 0.5, a: n, b: { k: "leaf", id: fresh } } : n
    : { ...n, a: splitLeaf(n.a, id, dir, fresh), b: splitLeaf(n.b, id, dir, fresh) };

/** The tree without the pane; its sibling takes the space. */
function removeLeaf(n: Node, id: string): Node | null {
  if (n.k === "leaf") return n.id === id ? null : n;
  const a = removeLeaf(n.a, id);
  const b = removeLeaf(n.b, id);
  return !a ? b : !b ? a : { ...n, a, b };
}

const setRatio = (n: Node, path: string, ratio: number): Node =>
  n.k === "leaf" ? n
    : !path ? { ...n, ratio }
    : path[0] === "a" ? { ...n, a: setRatio(n.a, path.slice(1), ratio) } : { ...n, b: setRatio(n.b, path.slice(1), ratio) };

/** The pane nearest to `from` in a direction, preferring ones that share its rows or columns. */
function neighbor(leaves: { id: string; r: Rect }[], from: string, dir: "left" | "right" | "up" | "down"): string | null {
  const me = leaves.find((l) => l.id === from)?.r;
  if (!me) return null;
  const mid = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const c = mid(me);
  let best: { id: string; d: number } | null = null;
  for (const l of leaves) {
    if (l.id === from) continue;
    const o = mid(l.r);
    const [along, across] = dir === "left" ? [c.x - o.x, o.y - c.y] : dir === "right" ? [o.x - c.x, o.y - c.y]
      : dir === "up" ? [c.y - o.y, o.x - c.x] : [o.y - c.y, o.x - c.x];
    if (along <= 0) continue;
    const d = along + Math.abs(across) * 2;
    if (!best || d < best.d) best = { id: l.id, d };
  }
  return best?.id ?? null;
}

/** What `marq:terminal-pane` asks of a tab's panes. `handled` is set when a pane took the request. */
export type PaneAction = "splitRight" | "splitDown" | "close" | "zoom" | "next" | "left" | "right" | "up" | "down";
export type PaneRequest = { id: string; action: PaneAction; handled?: boolean };
export const PANE_EVENT = "marq:terminal-pane";

/** A tab of terminals, split like tmux: each pane has its own shell, which lives as long as the pane. */
export function TerminalView({ id, cwd, command, active, onTitle }: {
  id: string; cwd: string; command?: string; active: boolean; onTitle: (title: string) => void;
}) {
  const [tree, setTree] = useState<Node>({ k: "leaf", id: "p0" });
  const [focus, setFocus] = useState("p0");
  const [zoomed, setZoomed] = useState(false);
  const counter = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const settings = useSettings();

  const leaves: { id: string; r: Rect }[] = [];
  const dividers: Divider[] = [];
  layout(tree, FULL, "", leaves, dividers);
  const multi = leaves.length > 1;

  const act = (action: PaneAction): boolean => {
    const ids = leafIds(tree);
    const split = (dir: "row" | "column") => {
      const fresh = `p${++counter.current}`;
      setTree(splitLeaf(tree, focus, dir, fresh));
      setFocus(fresh);
      setZoomed(false);
    };
    switch (action) {
      case "splitRight": split("row"); return true;
      case "splitDown": split("column"); return true;
      case "close": return closePane(focus);
      case "zoom":
        if (ids.length > 1) setZoomed(!zoomed);
        return ids.length > 1;
      case "next": setFocus(ids[(ids.indexOf(focus) + 1) % ids.length]); return ids.length > 1;
      default: {
        const to = neighbor(leaves, focus, action);
        if (to) setFocus(to);
        return !!to;
      }
    }
  };
  const closePane = (pane: string): boolean => {
    const ids = leafIds(tree);
    const next = removeLeaf(tree, pane);
    if (!next) return false;
    const at = ids.indexOf(pane);
    setTree(next);
    setZoomed(false);
    if (pane === focus) setFocus(leafIds(next)[Math.max(0, at - 1)]);
    return true;
  };
  const actRef = useRef(act);
  const closeRef = useRef(closePane);
  useLayoutEffect(() => {
    actRef.current = act;
    closeRef.current = closePane;
  });
  useEffect(() => {
    const on = (e: Event) => {
      const req = (e as CustomEvent<PaneRequest>).detail;
      if (req.id === id && actRef.current(req.action)) req.handled = true;
    };
    window.addEventListener(PANE_EVENT, on);
    return () => window.removeEventListener(PANE_EVENT, on);
  }, [id]);

  const drag = (d: Divider, e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId) || !box.current) return;
    const b = box.current.getBoundingClientRect();
    const pos = d.dir === "row" ? ((e.clientX - b.left) / b.width) * 100 : ((e.clientY - b.top) / b.height) * 100;
    const [start, size] = d.dir === "row" ? [d.r.x, d.r.w] : [d.r.y, d.r.h];
    const ratio = Math.min(0.9, Math.max(0.1, (pos - start) / size));
    setTree((t) => setRatio(t, d.path, ratio));
  };

  const pct = (r: Rect): React.CSSProperties => ({ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` });
  return (
    // The DOM renderer draws runs of text as one span, so the browser shapes ligatures unless this turns them off.
    // Panes are siblings whatever the tree looks like, so splitting never remounts (and restarts) a shell.
    <div ref={box} className={`terminal-view ${wantsLigatures(settings.terminal) ? "" : "no-ligatures"}`}>
      {leaves.map((l) => {
        const hidden = zoomed && l.id !== focus;
        return (
          <TerminalPane key={l.id} id={`${id}.${l.id}`} cwd={cwd} command={l.id === "p0" ? command : undefined}
            active={active && l.id === focus} multi={multi} focused={l.id === focus}
            style={hidden ? { display: "none" } : pct(zoomed ? FULL : l.r)}
            onTitle={(t) => l.id === focus && onTitle(t)}
            onExit={() => leafIds(tree).length > 1 && closeRef.current(l.id)}
            onFocus={() => setFocus(l.id)} />
        );
      })}
      {!zoomed && dividers.map((d) => (
        <div key={d.path} className={`terminal-divider ${d.dir}`}
          style={d.dir === "row" ? { left: `${d.at}%`, top: `${d.r.y}%`, height: `${d.r.h}%` } : { top: `${d.at}%`, left: `${d.r.x}%`, width: `${d.r.w}%` }}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={(e) => drag(d, e)} />
      ))}
    </div>
  );
}
