import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api";
import { getSettings, useSettings } from "./settings";

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

/** A login shell (or `command`) in `cwd`. It lives as long as the tab. */
export function TerminalView({ id, cwd, command, active, onTitle }: {
  id: string; cwd: string; command?: string; active: boolean; onTitle: (title: string) => void;
}) {
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    // A PTY per mount, so a remount (StrictMode) never sees the old shell's exit.
    const pty = `${id}:${crypto.randomUUID().slice(0, 8)}`;
    const t = getSettings().terminal;
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
      fontSize: t?.font_size ?? 13,
      cursorStyle: t?.cursor ?? "block",
      cursorBlink: true,
      theme: themeFromCss(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const unData = listen<{ id: string; data: string }>("terminal://data", (e) => {
      if (e.payload.id === pty) term.write(e.payload.data);
    });
    const unExit = listen<{ id: string }>("terminal://exit", (e) => {
      if (e.payload.id === pty) setExited(true);
    });
    const input = term.onData((d) => api.terminalWrite(pty, d).catch(() => {}));
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
      term.dispose();
    };
  }, [id, cwd, command]);

  // Settings edited while the terminal is open.
  const settings = useSettings();
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-mono");
    term.options.fontSize = settings.terminal?.font_size ?? 13;
    term.options.cursorStyle = settings.terminal?.cursor ?? "block";
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
    <div className="terminal-view">
      <div ref={host} className="terminal-host" />
      {exited && <div className="terminal-exited muted small">The shell exited. Close the tab or open a new terminal.</div>}
    </div>
  );
}
