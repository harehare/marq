import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { EditorView, ReactCodeMirrorRef, type ViewUpdate } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { listen } from "@tauri-apps/api/event";
import { Eye, Columns2, PenLine, Save, Sparkles, PanelRight, AlertCircle, Send, MoveHorizontal, Copy, Check, Search, ChevronUp, ChevronDown, X, KanbanSquare, MessageSquare } from "lucide-react";
import { parseFrontmatter } from "./markdown/segments";
import { api, SessionInfo } from "./api";
import { Preview } from "./markdown/Preview";
import { editorHighlight, editorTheme } from "./editorTheme";
import { Resizer, usePaneSize } from "./Resizer";
import { CONTENT_WIDTHS, getSettings, setSettings, useSettings } from "./settings";
import { AskDialog, AskOptions } from "./AskDialog";
import { SelectionPopover } from "./SelectionPopover";
import type { Excerpt } from "./SendToSessionDialog";
import { EditorState } from "@codemirror/state";
import { NoteLinksPanel } from "./NoteLinks";
import { wikiCompletion } from "./wikilinks";
import { composing, FIND_EVENT } from "./keys";

// `[[` completes note names, through the autocompletion basicSetup already has.
const wikiCompletions = EditorState.languageData.of(() => [{ autocomplete: wikiCompletion }]);

// Built once: the editor reconfigures itself, parsing the whole note again, whenever these change identity.
const EXTENSIONS = [markdown(), editorHighlight, EditorView.lineWrapping, wikiCompletions];
const BASIC_SETUP = { lineNumbers: false, foldGutter: false, highlightActiveLine: false };

type Mode = "edit" | "split" | "preview";

// Marq's own marker comments (anchors, result blocks, pinned mq output); the text between them stays.
const MARKER = /^<!-- \/?(?:(?:marq|claude):(?:anchor|result)|mq:output)\b[^>]*-->$/;

/** The note as Markdown to paste elsewhere: no frontmatter and no marker comments. */
function forCopy(text: string) {
  const body = text.startsWith("---\n") && text.indexOf("\n---", 3) > 0 ? text.slice(text.indexOf("\n---", 3) + 4) : text;
  return body.split("\n").filter((l) => !MARKER.test(l.trim())).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

type Props = {
  vault: string;
  path: string;
  /** Shown now; a hidden tab checks the disk again when it comes back. */
  active?: boolean;
  jump?: { line: number; nonce: number };
  /** Just created: open in the editor, cursor at the end. */
  fresh?: boolean;
  onOpenSession: (id: string, title: string) => void;
  onOpenFile: (path: string) => void;
  onSendExcerpt: (excerpt: Excerpt) => void;
  /** Breadcrumbs before the file name, for a note shown inside another view; they replace its folders. */
  parents?: { label: string; onClick: () => void }[];
};

/** What the toolbar offers for a spec or a request in phases, from the note's frontmatter. */
function workflowOf(text: string | null) {
  const fm = new Map(parseFrontmatter(text ?? "").fields);
  const phases = (fm.get("phases") ?? "").replace(/^\[|\]$/g, "").split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const set = (fm.get("phase") ?? "").trim().toLowerCase();
  const phase = fm.get("type") === "request" && phases.length ? (phases.includes(set) ? set : phases[0]) : null;
  return { spec: fm.get("type") === "spec", phase, phases };
}

/** `[editor] default_mode`, preview unless set. */
function initialMode(): Mode {
  return getSettings().editor?.default_mode ?? "preview";
}

export function NoteEditor({ vault, path, active = true, jump, fresh, onOpenSession, onOpenFile, onSendExcerpt, parents }: Props) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [text, setText] = useState<string | null>(null);
  // The preview follows the text at a lower priority, so typing in the editor never waits for it.
  const previewText = useDeferredValue(text);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<Mode>(() => {
    const m = initialMode();
    return fresh && m === "preview" ? "edit" : m;
  });
  const [showLinks, setShowLinks] = useState(true);
  const [copied, setCopied] = useState(false);
  // ⌥-click copies the file as it is, frontmatter included.
  const copy = (raw: boolean) => {
    if (text === null) return;
    navigator.clipboard.writeText(raw ? text : forCopy(text)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }, (e) => setError(String(e)));
  };
  /** The note's title (frontmatter `title`, else the file name), to paste elsewhere. */
  const [titleCopied, setTitleCopied] = useState(false);
  const copyTitle = () => {
    const name = path.split("/").pop()?.replace(/\.md$/, "") ?? "";
    const title = (text && new Map(parseFrontmatter(text).fields).get("title")) || name;
    navigator.clipboard.writeText(title).then(() => {
      setTitleCopied(true);
      setTimeout(() => setTitleCopied(false), 1200);
    }, (e) => setError(String(e)));
  };
  const width = useSettings().appearance?.content_width ?? "wide";
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // For a document an agent wrote: the sessions that wrote or revised it, latest first.
  const [writers, setWriters] = useState<SessionInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingJump, setPendingJump] = useState<number | null>(null);
  const ref = useRef<ReactCodeMirrorRef>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  // The editor's share of the split, in thousandths, so it is stored as an integer.
  const split = usePaneSize("noteSplit", 500, 200, 800);
  const linksWidth = usePaneSize("noteLinks", 240, 180, 480);
  const dirtyRef = useRef(false);
  const textRef = useRef<string | null>(null);
  // Kept current for handlers and timers, after each render.
  useLayoutEffect(() => {
    dirtyRef.current = dirty;
    textRef.current = text;
  });
  // The text on disk as of the last load or save, to tell our own writes from others'.
  const saved = useRef<string | null>(null);
  // Changed on disk while there were unsaved edits: autosave stops until a manual save.
  const conflict = useRef(false);
  const [conflicted, setConflicted] = useState(false);

  /** Text that is now on disk. */
  const loaded = useCallback((content: string) => {
    saved.current = content;
    conflict.current = false;
    setConflicted(false);
    setText(content);
    setDirty(false);
  }, []);

  const load = useCallback(async () => loaded(await api.readNote(vault, path)), [vault, path, loaded]);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, [load]);

  /** Picks up a change made on disk, unless there are unsaved edits. */
  const reconcile = useCallback(async () => {
    if (saved.current === null) return;
    const disk = await api.readNote(vault, path).catch(() => null);
    if (disk === null || disk === saved.current) return;
    if (dirtyRef.current) {
      conflict.current = true;
      setConflicted(true);
      setError("This note was changed on disk. Autosave is paused; saving (⌘S) will overwrite it.");
    } else loaded(disk);
  }, [vault, path, loaded, setError]);

  // When marq writes a result back into this note.
  useEffect(() => {
    const un = listen<{ path: string }>("vault://changed", (e) => {
      if (e.payload.path === path) void reconcile();
    });
    return () => {
      un.then((f) => f());
    };
  }, [path, reconcile]);

  // Edits from other apps: checked when the tab is shown or the window comes back, not watched.
  useEffect(() => {
    if (!active) return;
    void reconcile();
    const onFocus = () => void reconcile();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, reconcile]);

  const refreshLinks = useCallback(async (content: string) => {
    const found = await api.noteAnchors(content);
    const all = await api.listSessions(vault);
    const id = content.match(/^id:\s*(\S+)/m)?.[1];
    const origins = new Set([...found.map((a) => a.id), ...(id ? [id] : [])]);
    const next = all.filter((s) => origins.has(s.origin));
    // Unchanged lists keep their identity, so the preview is not rendered again for nothing.
    setSessions((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    const fm = new Map(parseFrontmatter(content).fields);
    const ids = fm.get("type") === "doc" ? (fm.get("sessions") ?? "").replace(/^\[|\]$/g, "").split(",").map((x) => x.trim()).filter(Boolean) : [];
    const by = [...new Set(ids)].reverse().flatMap((sid) => all.filter((x) => x.id === sid));
    setWriters((prev) => (JSON.stringify(prev) === JSON.stringify(by) ? prev : by));
  }, [vault, setSessions, setWriters]);

  // Hidden tabs catch up when they are shown again, rather than on every change.
  useEffect(() => {
    if (active && text !== null && !dirty) refreshLinks(text);
  }, [active, text, dirty, refreshLinks]);

  useEffect(() => {
    if (!active) return;
    const un = listen("session://exit", () => text !== null && refreshLinks(text));
    return () => {
      un.then((f) => f());
    };
  }, [active, text, refreshLinks]);

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

  // Jumps from other tabs (search results, links, session cards). In the preview they scroll it
  // there and mark the spot, so a note opened to be read stays read-only; in the editor they move the cursor.
  useEffect(() => {
    if (!jump || text === null) return;
    if (mode !== "preview") return setPendingJump(jump.line);
    const t = setTimeout(() => {
      const blocks = [...(previewRef.current?.querySelectorAll<HTMLElement>("[data-line]") ?? [])];
      const at = blocks.filter((el) => Number(el.dataset.line) <= jump.line).pop() ?? blocks[0];
      if (!at) return;
      at.scrollIntoView({ block: "center" });
      at.classList.remove("jumped");
      void at.offsetWidth;
      at.classList.add("jumped");
    }, 50);
    return () => clearTimeout(t);
  }, [jump?.nonce, text === null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pendingJump === null || text === null) return;
    if (mode === "preview") setMode("split");
    const t = setTimeout(() => goToLine(pendingJump) && setPendingJump(null), 30);
    return () => clearTimeout(t);
  }, [pendingJump, mode, text === null, goToLine]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    const content = textRef.current;
    if (content === null) return;
    await api.writeNote(vault, path, content);
    saved.current = content;
    conflict.current = false;
    setConflicted(false);
    // Typing during the write leaves the newer text unsaved.
    if (textRef.current === content) setDirty(false);
    setError(null);
  }, [vault, path, setError]);
  const flow = useMemo(() => workflowOf(text), [text]);
  const breakDown = async () => {
    try {
      await save();
      const r = await api.specToBoard(vault, path);
      onOpenFile(r.board);
    } catch (e) {
      setError(String(e));
    }
  };

  // `[editor] autosave`: shortly after typing stops, and when the note closes.
  const autosave = getSettings().editor?.autosave !== false;
  useEffect(() => {
    if (!autosave || !dirty || conflict.current) return;
    const t = setTimeout(() => save().catch((e) => setError(String(e))), 800);
    return () => clearTimeout(t);
  }, [autosave, dirty, text, save]);
  useEffect(() => {
    if (!autosave) return;
    const flush = () => dirtyRef.current && !conflict.current && save().catch((e) => setError(String(e)));
    window.addEventListener("blur", flush);
    return () => window.removeEventListener("blur", flush);
  }, [autosave, save]);
  useEffect(() => () => {
    if (getSettings().editor?.autosave !== false && dirtyRef.current && !conflict.current && textRef.current !== null) {
      api.writeNote(vault, path, textRef.current).catch((e) => console.error(e));
    }
  }, [vault, path]);

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

  // ---- find in the note (⌘F) ----
  // The preview's matches are marked with the CSS Custom Highlight API, so the rendered DOM is left alone.
  // With the editor alone, matches are found in the source and selected there one at a time.
  const [find, setFind] = useState<string | null>(null);
  const [hit, setHit] = useState(0);
  const [found, setFound] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  const offsets = useRef<number[]>([]);
  const q = find?.trim().toLowerCase() ?? "";

  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== `note:${path}`) return;
      // The selected text, when there is some, is what to look for.
      const view = ref.current?.view;
      const sel = mode !== "preview" && view && !view.state.selection.main.empty
        ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
        : window.getSelection()?.toString() ?? "";
      if (sel.trim() && !sel.includes("\n")) {
        setFind(sel);
        setHit(0);
      } else setFind((f) => f ?? "");
      requestAnimationFrame(() => findRef.current?.select());
    };
    window.addEventListener(FIND_EVENT, on);
    return () => window.removeEventListener(FIND_EVENT, on);
  }, [path, mode]);

  // Collect the matches: in the preview's text when it is shown, else in the source.
  useEffect(() => {
    ranges.current = [];
    offsets.current = [];
    if (q && mode !== "edit" && previewRef.current) {
      const walker = document.createTreeWalker(previewRef.current, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent!.toLowerCase();
        for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) {
          const r = new Range();
          r.setStart(n, i);
          r.setEnd(n, i + q.length);
          ranges.current.push(r);
        }
      }
    } else if (q && text !== null) {
      const t = text.toLowerCase();
      for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) offsets.current.push(i);
    }
    setFound(ranges.current.length || offsets.current.length);
  }, [q, text, previewText, mode]);

  const current = found ? ((hit % found) + found) % found : -1;

  // Mark and scroll to the current match.
  useEffect(() => {
    const highlights = (CSS as unknown as { highlights?: Map<string, Highlight> }).highlights;
    if (current < 0) return;
    if (ranges.current.length) {
      highlights?.set("marq-find", new Highlight(...ranges.current));
      highlights?.set("marq-find-current", new Highlight(ranges.current[current]));
      ranges.current[current].startContainer.parentElement?.scrollIntoView({ block: "center" });
    } else {
      const view = ref.current?.view;
      const from = offsets.current[current];
      view?.dispatch({ selection: { anchor: from, head: from + q.length }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
    }
    return () => {
      highlights?.delete("marq-find");
      highlights?.delete("marq-find-current");
    };
  }, [current, found, q, mode]);

  const step = (d: number) => setHit((h) => h + d);
  const closeFind = () => {
    setFind(null);
    if (mode !== "preview") ref.current?.view?.focus();
  };

  /** Lines of a preview selection, from the source lines on the rendered blocks. */
  // ⌘E (note.toggleEdit) on this note's tab: preview → edit at the first line in view, edit or split → preview.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== path) return;
      if (mode !== "preview") return setMode("preview");
      const top = previewRef.current?.getBoundingClientRect().top ?? 0;
      const first = [...(previewRef.current?.querySelectorAll("[data-line]") ?? [])].find((el) => el.getBoundingClientRect().bottom > top);
      setMode("edit");
      if (first) setPendingJump(Number(first.getAttribute("data-line")));
    };
    window.addEventListener("marq:note-toggle", on);
    return () => window.removeEventListener("marq:note-toggle", on);
  }, [path, mode]);

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
  const askAt = (line: number, withOptions = false) => setAsk({ line, options: withOptions });
  const runAsk = async (line: number, options: AskOptions) => {
    if (dirty) await save();
    const started = await api.runFromNote(vault, path, line, options);
    loaded(started.content);
    const first = options.excerpt?.text.trim().split("\n")[0] ?? started.content.split("\n")[line];
    onOpenSession(started.session_id, first?.replace(/^[#\-*\s]+/, "").slice(0, 60) || "session");
  };

  // Handlers that keep their identity, so the memoized preview renders again only when the text or sessions change.
  const onEditorChange = useCallback((v: string) => {
    setText(v);
    setDirty(true);
  }, []);
  const onEditorUpdate = useCallback((u: ViewUpdate) => {
    if (u.selectionSet) setHasSelection(!u.state.selection.main.empty);
  }, []);
  const latest = useRef({ askAt, setPendingJump, onOpenFile, onOpenSession, loaded });
  useLayoutEffect(() => {
    latest.current = { askAt, setPendingJump, onOpenFile, onOpenSession, loaded };
  });
  const previewHandlers = useMemo(() => ({
    onRunAt: (line: number, withOptions?: boolean) => latest.current.askAt(line, withOptions),
    onEditAt: (line: number) => latest.current.setPendingJump(line),
    onOpenFile: (p: string) => latest.current.onOpenFile(p),
    onOpenSession: (id: string, title: string) => latest.current.onOpenSession(id, title),
    onPinned: (t: string) => latest.current.loaded(t),
  }), []);

  if (text === null) return <div className="pane-msg">{error ?? "Loading…"}</div>;
  if (previewText === null) return null;

  /** Normal → wide → full width, saved to config.toml. */
  const nextWidth = () => {
    const i = CONTENT_WIDTHS.findIndex((w) => w.value === width);
    const next = CONTENT_WIDTHS[(i + 1) % CONTENT_WIDTHS.length].value;
    const s = getSettings();
    setSettings({ ...s, appearance: { ...s.appearance, content_width: next } });
    api.writeConfig({ "appearance.content_width": next === "wide" ? null : next }).catch((e) => setError(String(e)));
  };

  const crumbs = parents ? rel.split("/").slice(-1) : rel.split("/");

  return (
    <div className="note">
      <div className="toolbar">
        <span className="crumbs">
          {parents?.map((p, i) => <a key={`p${i}`} className="crumb link" onClick={p.onClick}>{p.label}</a>)}
          {crumbs.map((c, i) => (i === crumbs.length - 1
            ? (
              <span key={i} className="crumb last" title="Click to copy the title"
                // A click copies; a drag still selects, so part of it can be copied too.
                onClick={() => { if (!window.getSelection()?.toString()) copyTitle(); }}>
                {c}{titleCopied && <Check size={12} className="crumb-copied" />}
              </span>
            )
            : <span key={i} className="crumb">{c}</span>))}
          {dirty && <span className="dirty" title={autosave && !conflicted ? "Saving soon" : "Unsaved changes"} />}
        </span>
        <div className="segmented">
          <button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")} title="Edit (⌘E toggles; ⌘-click in the preview edits there)"><PenLine size={14} /></button>
          <button className={mode === "split" ? "on" : ""} onClick={() => setMode("split")} title="Split"><Columns2 size={14} /></button>
          <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")} title="Preview"><Eye size={14} /></button>
        </div>
        <button className="icon" onClick={save} disabled={!dirty} title="Save (⌘S)"><Save size={14} /></button>
        {mode !== "preview" && (
          <button className="icon" onClick={sendEditorSelection} disabled={!hasSelection} title="Send the selection to a session (⌘⇧↵)">
            <Send size={14} />
          </button>
        )}
        <button className="icon" onClick={(e) => copy(e.altKey)}
          title="Copy as Markdown, without the frontmatter (⌥-click: the file as it is)">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button className="icon" onClick={nextWidth}
          title={`Width: ${CONTENT_WIDTHS.find((w) => w.value === width)?.label} (click to change; also in Settings)`}>
          <MoveHorizontal size={14} />
        </button>
        {writers.length > 0 && (
          <button onClick={() => onOpenSession(writers[0].id, writers[0].title)}
            title={`Open the session that wrote this document: ${writers[0].title}${writers.length > 1 ? `\n${writers.length} sessions wrote it; all are in the side panel` : ""}\n⌥-click: open it next to this document`}>
            <MessageSquare size={14} /> Session
          </button>
        )}
        <button className={`icon ${showLinks ? "on" : ""}`} onClick={() => setShowLinks(!showLinks)} title="Sessions and links panel">
          <PanelRight size={14} />
        </button>
        {flow.spec && (
          <button onClick={breakDown} title="Put the open items under ## Tasks on this spec's board, as cards linked to the spec">
            <KanbanSquare size={14} /> Break down
          </button>
        )}
        <button
          className="primary"
          onClick={(e) => askAt(mode === "preview" ? 0 : cursorLine(), e.altKey)}
          title={flow.phase
            ? `Start the ${flow.phase} phase (${flow.phases.indexOf(flow.phase) + 1} of ${flow.phases.length}) in a new session (⌘↵)`
            : "Whole note for a request, otherwise the section at the cursor (⌘↵)"}
        >
          <Sparkles size={14} /> {flow.phase ? `Start ${flow.phase}` : "Ask"}
        </button>
      </div>
      {find !== null && (
        <div className="find-bar">
          <Search size={13} className="muted" />
          <input ref={findRef} autoFocus value={find} placeholder="Find in this note" spellCheck={false}
            onChange={(e) => { setFind(e.target.value); setHit(0); }}
            onKeyDown={(e) => {
              if (composing(e)) return;
              if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") closeFind();
            }} />
          <span className="muted small">{q ? (found ? `${current + 1}/${found}` : "No matches") : ""}</span>
          <button className="icon" onClick={() => step(-1)} disabled={!found} title="Previous (⇧↵)"><ChevronUp size={13} /></button>
          <button className="icon" onClick={() => step(1)} disabled={!found} title="Next (↵)"><ChevronDown size={13} /></button>
          <button className="icon" onClick={closeFind} title="Close (Esc)"><X size={13} /></button>
        </div>
      )}
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
              basicSetup={BASIC_SETUP}
              extensions={EXTENSIONS}
              onUpdate={onEditorUpdate}
              onChange={onEditorChange}
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
                  askAt(cursorLine(), e.altKey);
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
              toSession={writers[0] && { title: writers[0].title, onSend: (text) => onSendExcerpt({ text, source: rel, lines: previewLines(), target: writers[0].id }) }}
              onAsk={(text) => {
                const l = previewLines();
                setAsk({ line: l?.[0] ?? 0, options: false, excerpt: l ? { text, from: l[0], to: l[1] } : undefined });
              }} />
            <Preview vault={vault} path={path} text={previewText} sessions={sessions} {...previewHandlers} />
          </div>
        )}
        </div>
        {showLinks && <Resizer axis="x" sign={-1} pane={linksWidth} />}
        {showLinks && (
          <aside className="links" style={{ width: linksWidth.size }}>
            {writers.length > 0 && <h4>Written by</h4>}
            {writers.map((s) => (
              <a key={s.id} className="session-card" onClick={() => onOpenSession(s.id, s.title)}>
                <div className="session-card-title"><span className={`dot ${s.status}`} /> {s.title}</div>
                <div className="muted small">{s.started.slice(0, 16).replace("T", " ")} · {s.status}</div>
              </a>
            ))}
            <h4>Sessions</h4>
            {sessions.length === 0 && (
              <p className="muted small">Hover a heading in the preview and choose Ask to start one.</p>
            )}
            {sessions.map((s) => (
              <a key={s.id} className="session-card" onClick={() => onOpenSession(s.id, s.title)}>
                <div className="session-card-title"><span className={`dot ${s.status}`} /> {s.title}</div>
                <div className="muted small">{s.started.slice(0, 16).replace("T", " ")} · {s.status}</div>
              </a>
            ))}
            <NoteLinksPanel vault={vault} path={path} onOpenFile={onOpenFile} />
          </aside>
        )}
      </div>
      {ask && text !== null && (
        <AskDialog vault={vault} note={text} excerpt={ask.excerpt} showOptions={ask.options}
          onClose={() => setAsk(null)} onRun={(o) => runAsk(ask.line, o)} />
      )}
    </div>
  );
}
