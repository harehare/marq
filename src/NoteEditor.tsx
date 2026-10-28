import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror, { EditorView, ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { listen } from "@tauri-apps/api/event";
import { Eye, Columns2, PenLine, Save, Sparkles, PanelRight, AlertCircle, Send } from "lucide-react";
import { api, SessionInfo } from "./api";
import { Preview } from "./markdown/Preview";
import { editorHighlight, editorTheme } from "./editorTheme";
import { Resizer, usePaneSize } from "./Resizer";
import { getSettings } from "./settings";
import { AskDialog, AskOptions } from "./AskDialog";
import { SelectionPopover } from "./SelectionPopover";
import type { Excerpt } from "./SendToSessionDialog";

type Mode = "edit" | "split" | "preview";

type Props = {
  vault: string;
  path: string;
  jump?: { line: number; nonce: number };
  /** Just created: open in the editor, cursor at the end. */
  fresh?: boolean;
  onOpenSession: (id: string, title: string) => void;
  onSendExcerpt: (excerpt: Excerpt) => void;
};

/** `[editor] default_mode`, preview unless set. */
function initialMode(): Mode {
  return getSettings().editor?.default_mode ?? "preview";
}

export function NoteEditor({ vault, path, jump, fresh, onOpenSession, onSendExcerpt }: Props) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<Mode>(() => {
    const m = initialMode();
    return fresh && m === "preview" ? "edit" : m;
  });
  const [showLinks, setShowLinks] = useState(true);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingJump, setPendingJump] = useState<number | null>(null);
  const ref = useRef<ReactCodeMirrorRef>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  // The editor's share of the split, in thousandths, so it is stored as an integer.
  const split = usePaneSize("noteSplit", 500, 200, 800);
  const linksWidth = usePaneSize("noteLinks", 240, 180, 480);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const load = useCallback(async () => {
    setText(await api.readNote(vault, path));
    setDirty(false);
  }, [vault, path]);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, [load]);

  // Reload when marq writes a result back into this note, unless there are unsaved edits.
  useEffect(() => {
    const un = listen<{ path: string }>("vault://changed", (e) => {
      if (e.payload.path !== path) return;
      if (dirtyRef.current) setError("This note was changed on disk. Saving will overwrite it.");
      else load();
    });
    return () => {
      un.then((f) => f());
    };
  }, [path, load]);

  const refreshLinks = useCallback(async (content: string) => {
    const found = await api.noteAnchors(content);
    const all = await api.listSessions(vault);
    const id = content.match(/^id:\s*(\S+)/m)?.[1];
    const origins = new Set([...found.map((a) => a.id), ...(id ? [id] : [])]);
    setSessions(all.filter((s) => origins.has(s.origin)));
  }, [vault]);

  useEffect(() => {
    if (text !== null && !dirty) refreshLinks(text);
  }, [text, dirty, refreshLinks]);

  useEffect(() => {
    const un = listen("claude://exit", () => text !== null && refreshLinks(text));
    return () => {
      un.then((f) => f());
    };
  }, [text, refreshLinks]);

  const goToLine = useCallback((line: number) => {
    const view = ref.current?.view;
    if (!view) return false;
    const l = view.state.doc.line(Math.min(line + 1, view.state.doc.lines));
    view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
    view.focus();
    return true;
  }, []);

  useEffect(() => {
    if (fresh && text !== null) setPendingJump(text.split("\n").length - 1);
  }, [fresh, text === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Jumps from other tabs, and from the preview into the editor once it is mounted.
  useEffect(() => {
    if (jump && text !== null) setPendingJump(jump.line);
  }, [jump?.nonce, text === null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pendingJump === null || text === null) return;
    if (mode === "preview") setMode("split");
    const t = setTimeout(() => goToLine(pendingJump) && setPendingJump(null), 30);
    return () => clearTimeout(t);
  }, [pendingJump, mode, text === null, goToLine]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    if (text === null) return;
    await api.writeNote(vault, path, text);
    setDirty(false);
    setError(null);
  }, [vault, path, text]);

  const cursorLine = () => {
    const view = ref.current?.view;
    return view ? view.state.doc.lineAt(view.state.selection.main.head).number - 1 : 0;
  };

  const rel = path.replace(vault + "/", "");

  /** Sends the editor's selection with its line range (1-based, as shown to people). */
  const sendEditorSelection = () => {
    const view = ref.current?.view;
    if (!view) return;
    const sel = view.state.selection.main;
    const text = view.state.sliceDoc(sel.from, sel.to);
    if (!text.trim()) return;
    const doc = view.state.doc;
    onSendExcerpt({ text, source: rel, lines: [doc.lineAt(sel.from).number, doc.lineAt(sel.to).number] });
  };

  /** Lines of a preview selection, from the source lines on the rendered blocks. */
  const previewLines = (): [number, number] | undefined => {
    const sel = window.getSelection();
    const line = (n: Node | null | undefined) => {
      const el = (n instanceof Element ? n : n?.parentElement)?.closest("[data-line]");
      return el ? Number(el.getAttribute("data-line")) + 1 : undefined;
    };
    const a = line(sel?.anchorNode);
    const b = line(sel?.focusNode);
    return a && b ? [Math.min(a, b), Math.max(a, b)] : undefined;
  };

  // The Ask dialog: a section (line) or a selection, with run options shown for ⌥.
  const [ask, setAsk] = useState<{ line: number; options: boolean; excerpt?: AskOptions["excerpt"] } | null>(null);
  const askClaude = (line: number, withOptions = false) => setAsk({ line, options: withOptions });
  const runClaude = async (line: number, options: AskOptions) => {
    if (dirty) await save();
    const started = await api.runFromNote(vault, path, line, options);
    setText(started.content);
    setDirty(false);
    const first = options.excerpt?.text.trim().split("\n")[0] ?? started.content.split("\n")[line];
    onOpenSession(started.session_id, first?.replace(/^[#\-*\s]+/, "").slice(0, 60) || "session");
  };

  if (text === null) return <div className="pane-msg">{error ?? "Loading…"}</div>;

  const crumbs = rel.split("/");

  return (
    <div className="note">
      <div className="toolbar">
        <span className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i} className={i === crumbs.length - 1 ? "crumb last" : "crumb"}>{c}</span>
          ))}
          {dirty && <span className="dirty" title="Unsaved changes" />}
        </span>
        <div className="segmented">
          <button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")} title="Edit"><PenLine size={14} /></button>
          <button className={mode === "split" ? "on" : ""} onClick={() => setMode("split")} title="Split"><Columns2 size={14} /></button>
          <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")} title="Preview"><Eye size={14} /></button>
        </div>
        <button className="icon" onClick={save} disabled={!dirty} title="Save (⌘S)"><Save size={14} /></button>
        {mode !== "preview" && (
          <button className="icon" onClick={sendEditorSelection} disabled={!hasSelection} title="Send the selection to a session (⌘⇧↵)">
            <Send size={14} />
          </button>
        )}
        <button className={`icon ${showLinks ? "on" : ""}`} onClick={() => setShowLinks(!showLinks)} title="Sessions panel">
          <PanelRight size={14} />
        </button>
        <button
          className="primary"
          onClick={(e) => askClaude(mode === "preview" ? 0 : cursorLine(), e.altKey)}
          title="Whole note for a request, otherwise the section at the cursor (⌘↵)"
        >
          <Sparkles size={14} /> Ask Claude
        </button>
      </div>
      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          <AlertCircle size={14} /> {error}
        </div>
      )}
      <div className={`note-body mode-${mode}`}>
        <div className="split" ref={splitRef}>
        {mode !== "preview" && (
          <div className="editor-wrap" style={mode === "split" ? { flex: `0 0 ${split.size / 10}%` } : undefined}>
            <CodeMirror
              ref={ref}
              value={text}
              height="100%"
              className="editor"
              theme={editorTheme}
              basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
              extensions={[markdown(), editorHighlight, EditorView.lineWrapping]}
              onUpdate={(u) => u.selectionSet && setHasSelection(!u.state.selection.main.empty)}
              onChange={(v) => {
                setText(v);
                setDirty(true);
              }}
              onKeyDown={(e) => {
                const mod = e.metaKey || e.ctrlKey;
                if (mod && e.key === "s") {
                  e.preventDefault();
                  save();
                } else if (mod && e.shiftKey && e.key === "Enter") {
                  e.preventDefault();
                  sendEditorSelection();
                } else if (mod && e.key === "Enter") {
                  e.preventDefault();
                  askClaude(cursorLine(), e.altKey);
                }
              }}
            />
          </div>
        )}
        {mode === "split" && (
          <Resizer axis="x" sign={1} pane={split} scale={() => (splitRef.current?.clientWidth ?? 1000) / 1000} />
        )}
        {mode !== "edit" && (
          <div className="preview-wrap" ref={previewRef}>
            <SelectionPopover container={previewRef}
              onSend={(text) => onSendExcerpt({ text, source: rel, lines: previewLines() })}
              onAsk={(text) => {
                const l = previewLines();
                setAsk({ line: l?.[0] ?? 0, options: false, excerpt: l ? { text, from: l[0], to: l[1] } : undefined });
              }} />
            <Preview
              vault={vault}
              path={path}
              text={text}
              sessions={sessions}
              onRunAt={askClaude}
              onEditAt={(line) => setPendingJump(line)}
              onOpenSession={onOpenSession}
              onPinned={(t) => {
                setText(t);
                setDirty(false);
              }}
            />
          </div>
        )}
        </div>
        {showLinks && <Resizer axis="x" sign={-1} pane={linksWidth} />}
        {showLinks && (
          <aside className="links" style={{ width: linksWidth.size }}>
            <h4>Sessions</h4>
            {sessions.length === 0 && (
              <p className="muted small">Hover a heading in the preview and choose Ask Claude to start one.</p>
            )}
            {sessions.map((s) => (
              <a key={s.id} className="session-card" onClick={() => onOpenSession(s.id, s.title)}>
                <div className="session-card-title"><span className={`dot ${s.status}`} /> {s.title}</div>
                <div className="muted small">{s.started.slice(0, 16).replace("T", " ")} · {s.status}</div>
              </a>
            ))}
          </aside>
        )}
      </div>
      {ask && text !== null && (
        <AskDialog vault={vault} note={text} excerpt={ask.excerpt} showOptions={ask.options}
          onClose={() => setAsk(null)} onRun={(o) => runClaude(ask.line, o)} />
      )}
    </div>
  );
}
