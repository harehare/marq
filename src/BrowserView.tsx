import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Monitor, RotateCw, Smartphone } from "lucide-react";
import { api } from "./api";
import { composing } from "./keys";

const isLocal = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/.test(u);

/** What the user typed as a URL: http(s) as is, a path as a file, a bare host as https. */
async function normalize(input: string): Promise<string> {
  const v = input.trim();
  if (/^(https?|asset|file):/.test(v)) return v;
  if (v.startsWith("~/")) return `file://${(await homeDir()).replace(/\/$/, "")}${v.slice(1)}`;
  if (v.startsWith("/")) return `file://${v}`;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?/.test(v)) return `http://${v}`;
  return `https://${v}`;
}

/** Local files go through the asset protocol, since the webview cannot load file:// in a frame. */
const frameSrc = (url: string) => (url.startsWith("file://") ? convertFileSrc(decodeURI(url.slice(7))) : url);

/** A browser tab: an iframe with an address bar, for dev servers and local HTML (SPEC §25). */
export function BrowserView({ url: initial, nonce, onTitle }: { url: string; nonce?: number; onTitle: (t: string) => void }) {
  // Pages opened in this tab; links followed inside the frame are not tracked (it is another origin).
  const [nav, setNav] = useState<{ list: string[]; at: number }>({ list: [], at: -1 });
  const { list: history, at } = nav;
  const push = (u: string) => setNav((n) => (n.list[n.at] === u ? n : { list: [...n.list.slice(0, n.at + 1), u], at: n.at + 1 }));
  const step = (d: number) => setNav((n) => ({ ...n, at: Math.max(0, Math.min(n.list.length - 1, n.at + d)) }));
  const [input, setInput] = useState(initial);
  const [reload, setReload] = useState(0);
  const [mobile, setMobile] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const url = history[at] ?? "";

  const go = async (raw: string) => {
    if (!raw.trim()) return;
    push(await normalize(raw));
  };

  // The first URL, and again when reopened (e.g. open_preview for the same session): show it and reload.
  useEffect(() => {
    if (!initial) return void inputRef.current?.focus();
    normalize(initial).then((u) => {
      push(u);
      setReload((r) => r + 1);
    });
  }, [initial, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setInput(url);
    setBlocked(null);
    if (!url) return;
    onTitle(url.replace(/^[a-z]+:\/\//, "").replace(/\/$/, "").slice(0, 40));
    // Most public sites refuse to be framed; say so instead of showing a blank page.
    if (/^https?:/.test(url) && !isLocal(url)) {
      api.probeUrl(url).then((r) => !r.frameable && setBlocked(url), () => {});
    }
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="icon" disabled={at <= 0} onClick={() => step(-1)} title="Back"><ArrowLeft size={14} /></button>
        <button className="icon" disabled={at >= history.length - 1} onClick={() => step(1)} title="Forward"><ArrowRight size={14} /></button>
        <button className="icon" disabled={!url} onClick={() => setReload((r) => r + 1)} title="Reload"><RotateCw size={14} /></button>
        <input ref={inputRef} className="browser-url" value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false}
          placeholder="localhost:5173, https://…, or a file path" onFocus={(e) => e.target.select()}
          onKeyDown={(e) => !composing(e) && e.key === "Enter" && go(input)} />
        <button className={`icon ${mobile ? "on" : ""}`} onClick={() => setMobile(!mobile)} title={mobile ? "Full width" : "Phone width (390px)"}>
          {mobile ? <Monitor size={14} /> : <Smartphone size={14} />}
        </button>
        <button className="icon" disabled={!url} onClick={() => openUrl(url)} title="Open in your browser"><ExternalLink size={14} /></button>
      </div>
      <div className={`browser-frame ${mobile ? "mobile" : ""}`}>
        {blocked === url ? (
          <div className="browser-msg">
            <Globe size={28} className="muted" />
            <p>This site does not allow being shown inside another app.</p>
            <button className="primary" onClick={() => openUrl(url)}><ExternalLink size={14} /> Open in your browser</button>
          </div>
        ) : url ? (
          <iframe key={`${url}#${reload}`} src={frameSrc(url)} title={url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" />
        ) : (
          <div className="browser-msg muted">
            <Globe size={28} />
            <p>Type a URL: a dev server (localhost:5173), a local HTML file, or a site that allows embedding.</p>
          </div>
        )}
      </div>
    </div>
  );
}
