import { createContext, createElement, memo, ReactNode, useContext } from "react";
import ReactMarkdown, { Components, defaultUrlTransform } from "react-markdown";
import { convertFileSrc } from "@tauri-apps/api/core";
import remarkGfm from "remark-gfm";
import { Sparkles, Pencil, Anchor as AnchorIcon, Bot, Check, MessageSquarePlus, MessageSquareText, X } from "lucide-react";
import { SessionInfo } from "../api";
import { MqBlock } from "./MqBlock";
import { resolveLink } from "../links";
import { api } from "../api";
import { remarkWikilinks, resolveWiki, useVaultFiles, WIKI_SCHEME } from "../wikilinks";
import { parseFrontmatter, segments, fenceMeta } from "./segments";

type Props = {
  vault: string;
  path: string;
  text: string;
  sessions: SessionInfo[];
  /** `withOptions`: ⌥-click, to pick project, worktree and model first. */
  onRunAt: (line: number, withOptions?: boolean) => void;
  onEditAt: (line: number) => void;
  /** Add a comment under the block at this line. */
  onCommentAt?: (line: number) => void;
  /** Ask the agent to act on the comment at this line. */
  onRunComment?: (line: number) => void;
  onDeleteComment?: (line: number) => void;
  onOpenSession: (id: string, title: string) => void;
  /** Opens a note or board a relative `.md` link points to. */
  onOpenFile?: (path: string) => void;
  /** Called with the new note text after an mq output is pinned. */
  onPinned?: (text: string) => void;
};

const urlTransform = (url: string) => (url.startsWith("marq-anchor:") || url.startsWith("marq-comment:") || url.startsWith(WIKI_SCHEME) ? url : defaultUrlTransform(url));

function textOf(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

function Properties({ text }: { text: string }) {
  const { vault, path } = useContext(PreviewCtx);
  const { fields } = parseFrontmatter(text);
  const get = (k: string) => fields.find(([key]) => key === k)?.[1];
  const shown = fields.filter(([k]) => !["id", "title", "type", "status", "tags", "aliases", "sessions"].includes(k) && k);
  const list = (k: string) =>
    get(k)?.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim().replace(/^["'#]+|["']$/g, "")).filter(Boolean) ?? [];
  const tags = list("tags");
  const aliases = list("aliases");
  if (!fields.length) return null;
  return (
    <div className="props">
      <div className="props-row">
        {get("type") && <span className={`pill type-${get("type")}`}>{get("type")}</span>}
        {get("status") && <span className={`pill status-${get("status")}`}>{get("status")}</span>}
        {tags.map((t) => (
          <a key={t} className="tag" title={`Notes tagged ${t}`}
            onClick={() => window.dispatchEvent(new CustomEvent("marq:search", { detail: `tag:${t}` }))}>#{t}</a>
        ))}
        {aliases.length > 0 && <span className="muted small">also: {aliases.join(", ")}</span>}
        {get("type") === "knowledge" && get("status") === "draft" && (
          <button className="small-btn" title="An agent wrote or changed this; mark it as checked so agents trust it"
            onClick={() => void api.knowledgeReview(vault, path)}><Check size={11} /> Mark reviewed</button>
        )}
      </div>
      {shown.length > 0 && (
        <dl className="props-grid">
          {shown.map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{v || <span className="muted">—</span>}</dd></div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** Local image paths are resolved against the note and loaded through Tauri's asset protocol. */
function imageSrc(src: string | undefined, notePath: string): string | undefined {
  if (!src || /^(https?|data|blob):/.test(src)) return src;
  const path = src.startsWith("/") ? src : `${notePath.slice(0, notePath.lastIndexOf("/"))}/${decodeURI(src)}`;
  const parts: string[] = [];
  for (const p of path.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return convertFileSrc(parts.join("/"));
}

// What the renderers need, passed by context. The renderers themselves are created once below:
// building them during render gives React new component types each time, which remounts every
// block, so each mq block was evaluated again whenever the preview re-rendered.
const PreviewCtx = createContext<Props>(null!);
/** First source line (0-based) of the segment being rendered. */
const OffsetCtx = createContext(0);

function useLine(node: any) {
  const offset = useContext(OffsetCtx);
  return offset + (node?.position?.start?.line ?? 1) - 1;
}

const withLine = (tag: string) =>
  function WithLine({ node, children, ...rest }: any) {
    return createElement(tag, { ...rest, "data-line": useLine(node) }, children);
  };

const heading = (tag: string) =>
  function Heading({ node, children }: any) {
    const { onRunAt, onEditAt, onCommentAt } = useContext(PreviewCtx);
    const line = useLine(node);
    return (
      <div className="heading" data-line={line}>
        {createElement(tag, {}, children)}
        <span className="heading-actions">
          <button className="icon accent" title="Ask about this section (⌥-click for options)" onClick={(e) => onRunAt(line, e.altKey)}>
            <Sparkles size={14} /> Ask
          </button>
          {onCommentAt && (
            <button className="icon" title="Comment on this section" onClick={() => onCommentAt(line)}>
              <MessageSquarePlus size={13} />
            </button>
          )}
          <button className="icon" title="Edit here" onClick={() => onEditAt(line)}>
            <Pencil size={13} />
          </button>
        </span>
      </div>
    );
  };

function Pre({ node, children }: any) {
  const { vault, path, text, onPinned } = useContext(PreviewCtx);
  const line = useLine(node);
  const code = node?.children?.[0];
  const cls: string[] = code?.properties?.className ?? [];
  const lang = cls.find((c) => c.startsWith("language-"))?.slice(9);
  if (lang === "mq") {
    return (
      <div data-line={line}>
        <MqBlock vault={vault} notePath={path} noteText={text} line={line} onPinned={onPinned}
          query={textOf(code).replace(/\n$/, "")} meta={fenceMeta(code?.data?.meta)} />
      </div>
    );
  }
  return (
    <div className="codeblock" data-line={line}>
      {lang && <span className="codeblock-lang">{lang}</span>}
      <pre>{children}</pre>
    </div>
  );
}

function Img({ src, alt }: any) {
  const { path } = useContext(PreviewCtx);
  return <img src={imageSrc(src, path)} alt={alt ?? ""} loading="lazy" />;
}

/** `[[Target]]`: a link to the note it names, or a dashed one that creates the note on click. */
function WikiLink({ target, children }: { target: string; children: ReactNode }) {
  const { vault, onOpenFile } = useContext(PreviewCtx);
  const file = resolveWiki(useVaultFiles(), target);
  if (file) {
    return <a className="note-link wikilink" title={file.rel} onClick={() => onOpenFile?.(file.path)}>{children}</a>;
  }
  return (
    <a className="wikilink missing" title={`No note "${target}" yet: click to create notes/${target}.md`}
      onClick={() => api.wikilinkOpen(vault, target, true).then((p) => p && onOpenFile?.(p))}>{children}</a>
  );
}

/** A comment left in the note, with its @marq mention marked and a button to ask the agent. */
function CommentCard({ line, sent, text }: { line: number; sent: boolean; text: string }) {
  const { onRunComment, onDeleteComment } = useContext(PreviewCtx);
  const parts = text.split(/((?:^|\s)@marq\b)/i);
  return (
    <span className={`comment-card ${sent ? "sent" : ""}`} data-line={line}>
      <MessageSquareText size={13} className="comment-icon" />
      <span className="comment-text">
        {parts.map((p, i) => (i % 2 ? <mark key={i} className="mention">{p}</mark> : p))}
      </span>
      {onRunComment && (
        <button className="small-btn" title={sent ? "Sent to an agent already; ask again" : "Ask an agent to do what this comment says"}
          onClick={() => onRunComment(line)}>
          {sent ? <Check size={11} /> : <Sparkles size={11} />} {sent ? "Sent" : "Ask marq"}
        </button>
      )}
      {onDeleteComment && (
        <button className="icon" title="Delete the comment" onClick={() => onDeleteComment(line)}><X size={12} /></button>
      )}
    </span>
  );
}

function Link({ href, children }: any) {
  const { path, sessions, onOpenSession, onOpenFile } = useContext(PreviewCtx);
  if (href?.startsWith(WIKI_SCHEME)) return <WikiLink target={decodeURIComponent(href.slice(WIKI_SCHEME.length))}>{children}</WikiLink>;
  if (href?.startsWith("marq-comment:")) {
    const [line, state, ...rest] = href.slice("marq-comment:".length).split(":");
    return <CommentCard line={Number(line)} sent={state === "sent"} text={decodeURIComponent(rest.join(":"))} />;
  }
  if (href?.startsWith("marq-anchor:")) {
    const id = href.slice("marq-anchor:".length);
    const linked = sessions.filter((s) => s.origin === id);
    return (
      <span className="anchor-chip">
        <AnchorIcon size={11} />
        {linked.length === 0 && <span className="muted">no sessions</span>}
        {linked.map((s) => (
          <a key={s.id} onClick={() => onOpenSession(s.id, s.title)}>
            <span className={`dot ${s.status}`} /> {s.started.slice(5, 16).replace("T", " ")}
          </a>
        ))}
      </span>
    );
  }
  const file = onOpenFile && href ? resolveLink(path, href) : null;
  if (file) {
    return <a href={href} className="note-link" onClick={(e) => { e.preventDefault(); onOpenFile!(file); }}>{children as ReactNode}</a>;
  }
  // Web links open in the default browser (see main.tsx).
  return <a href={href} rel="noreferrer" title={href}>{children as ReactNode}</a>;
}

const COMPONENTS: Components = {
  h1: heading("h1"), h2: heading("h2"), h3: heading("h3"),
  h4: heading("h4"), h5: heading("h5"), h6: heading("h6"),
  p: withLine("p"), li: withLine("li"), blockquote: withLine("blockquote"), table: withLine("table"),
  pre: Pre,
  img: Img,
  a: Link,
};

const PLUGINS = [remarkGfm, remarkWikilinks];

// Parsing is the expensive part, so a segment whose text did not change is not parsed again.
const Segment = memo(function Segment({ text, line }: { text: string; line: number }) {
  return (
    <OffsetCtx.Provider value={line}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </OffsetCtx.Provider>
  );
});

/**
 * Renders again only when its props change, so pass callbacks that keep their identity: the app re-renders
 * on every session event, and parsing a long note each time made everything slow.
 */
export const Preview = memo(function Preview(props: Props) {
  const { text, sessions, onEditAt, onOpenSession } = props;
  const segs = segments(text);

  return (
    <PreviewCtx.Provider value={props}>
      <article
        className="preview"
        // ⌘-click edits there; a plain double-click selects a word as usual.
        onClick={(e) => {
          if (!e.metaKey || (e.target as HTMLElement).closest("a, button, input, summary")) return;
          const el = (e.target as HTMLElement).closest("[data-line]");
          if (el) onEditAt(Number(el.getAttribute("data-line")));
        }}
      >
        <Properties text={text} />
        {segs.map((s, i) =>
          s.kind === "md" ? (
            <Segment key={i} text={s.text} line={s.line} />
          ) : (
            <div key={i} className="result-card">
              <div className="result-head">
                <Bot size={13} /> Result
                <span className="spacer" />
                <a onClick={() => onOpenSession(s.session, sessions.find((x) => x.id === s.session)?.title ?? "session")}>
                  Open session →
                </a>
              </div>
              <div className="result-body"><Segment text={s.text} line={s.line} /></div>
            </div>
          ),
        )}
      </article>
    </PreviewCtx.Provider>
  );
});
