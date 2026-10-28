import { createContext, createElement, ReactNode, useContext } from "react";
import ReactMarkdown, { Components, defaultUrlTransform } from "react-markdown";
import { convertFileSrc } from "@tauri-apps/api/core";
import remarkGfm from "remark-gfm";
import { Sparkles, Pencil, Anchor as AnchorIcon, Bot } from "lucide-react";
import { SessionInfo } from "../api";
import { MqBlock } from "./MqBlock";
import { parseFrontmatter, segments, fenceMeta } from "./segments";

type Props = {
  vault: string;
  path: string;
  text: string;
  sessions: SessionInfo[];
  /** `withOptions`: ⌥-click, to pick project, worktree and model first. */
  onRunAt: (line: number, withOptions?: boolean) => void;
  onEditAt: (line: number) => void;
  onOpenSession: (id: string, title: string) => void;
  /** Called with the new note text after an mq output is pinned. */
  onPinned?: (text: string) => void;
};

const urlTransform = (url: string) => (url.startsWith("marq-anchor:") ? url : defaultUrlTransform(url));

function textOf(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

function Properties({ text }: { text: string }) {
  const { fields } = parseFrontmatter(text);
  const get = (k: string) => fields.find(([key]) => key === k)?.[1];
  const shown = fields.filter(([k]) => !["id", "title", "type", "status", "tags", "sessions"].includes(k) && k);
  const tags = get("tags")?.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean) ?? [];
  if (!fields.length) return null;
  return (
    <div className="props">
      <div className="props-row">
        {get("type") && <span className={`pill type-${get("type")}`}>{get("type")}</span>}
        {get("status") && <span className={`pill status-${get("status")}`}>{get("status")}</span>}
        {tags.map((t) => <span key={t} className="tag">#{t}</span>)}
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
    const { onRunAt, onEditAt } = useContext(PreviewCtx);
    const line = useLine(node);
    return (
      <div className="heading" data-line={line}>
        {createElement(tag, {}, children)}
        <span className="heading-actions">
          <button className="icon accent" title="Ask Claude about this section (⌥-click for options)" onClick={(e) => onRunAt(line, e.altKey)}>
            <Sparkles size={14} /> Ask Claude
          </button>
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

function Link({ href, children }: any) {
  const { sessions, onOpenSession } = useContext(PreviewCtx);
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
  return <a href={href} target="_blank" rel="noreferrer">{children as ReactNode}</a>;
}

const COMPONENTS: Components = {
  h1: heading("h1"), h2: heading("h2"), h3: heading("h3"),
  h4: heading("h4"), h5: heading("h5"), h6: heading("h6"),
  p: withLine("p"), li: withLine("li"), blockquote: withLine("blockquote"), table: withLine("table"),
  pre: Pre,
  img: Img,
  a: Link,
};

const PLUGINS = [remarkGfm];

function Segment({ text, line }: { text: string; line: number }) {
  return (
    <OffsetCtx.Provider value={line}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </OffsetCtx.Provider>
  );
}

export function Preview(props: Props) {
  const { text, sessions, onEditAt, onOpenSession } = props;
  const segs = segments(text);

  return (
    <PreviewCtx.Provider value={props}>
      <article
        className="preview"
        onDoubleClick={(e) => {
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
                <Bot size={14} /> Claude result
                <span className="spacer" />
                <a onClick={() => onOpenSession(s.session, sessions.find((x) => x.id === s.session)?.title ?? "session")}>
                  Open session →
                </a>
              </div>
              <Segment text={s.text} line={s.line} />
            </div>
          ),
        )}
      </article>
    </PreviewCtx.Provider>
  );
}
