import { memo, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { remarkWikilinks, resolveWiki, useVaultFiles, WIKI_SCHEME } from "../wikilinks";

/** Copies `text` and marks `el` as copied for a moment. */
function copyFrom(el: HTMLElement, text: string) {
  navigator.clipboard.writeText(text).then(() => {
    el.classList.add("copied");
    setTimeout(() => el.classList.remove("copied"), 1000);
  }, () => {});
}

/** Inline code (a branch, a path, a command) copies itself when clicked, unless text was being selected. */
const InlineCode: Components["code"] = ({ node: _node, ...props }) => (
  <code {...props} onClick={(e) => {
    const el = e.currentTarget;
    if (el.parentElement?.tagName === "PRE" || !window.getSelection()?.isCollapsed) return;
    copyFrom(el, el.textContent ?? "");
  }} />
);

/** A code block with a copy button in its corner. */
const CodeBlock: Components["pre"] = ({ node: _node, children, ...props }) => (
  <div className="md-pre">
    <pre {...props}>{children}</pre>
    <button className="icon md-copy" title="Copy" onClick={(e) => {
      const pre = e.currentTarget.previousElementSibling as HTMLElement | null;
      if (pre) copyFrom(e.currentTarget, pre.textContent?.replace(/\n$/, "") ?? "");
    }}><Copy size={12} /><Check size={12} /></button>
  </div>
);

// The URL as a tooltip, so where a link goes shows before clicking. Web links open in the browser (see main.tsx).
const COMPONENTS: Components = {
  a: ({ href, children }) => <a href={href} title={href} rel="noreferrer">{children}</a>,
  code: InlineCode,
  pre: CodeBlock,
};

const urlTransform = (url: string) => (url.startsWith(WIKI_SCHEME) ? url : defaultUrlTransform(url));

/** `[[Note]]` in a message: opens the note it names, or shows dashed when there is none. */
function WikiLink({ target, children, onOpenNote }: { target: string; children: React.ReactNode; onOpenNote: (path: string) => void }) {
  const file = resolveWiki(useVaultFiles(), target);
  if (!file) return <span className="wikilink missing" title={`No note "${target}"`}>{children}</span>;
  return <a className="note-link wikilink" title={file.rel} onClick={() => onOpenNote(file.path)}>{children}</a>;
}

/** Plain Markdown rendering for mq output and chat messages. With `onOpenNote`, `[[Note]]` links open notes. */
export const Md = memo(function Md({ children, onOpenNote }: { children: string; onOpenNote?: (path: string) => void }) {
  const components = useMemo<Components>(() => (onOpenNote
    ? {
        ...COMPONENTS,
        a: ({ href, children: c }) => href?.startsWith(WIKI_SCHEME)
          ? <WikiLink target={decodeURIComponent(href.slice(WIKI_SCHEME.length))} onOpenNote={onOpenNote}>{c}</WikiLink>
          : <a href={href} title={href} rel="noreferrer">{c}</a>,
      }
    : COMPONENTS), [onOpenNote]);
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={onOpenNote ? [remarkGfm, remarkWikilinks] : [remarkGfm]} components={components}
        urlTransform={urlTransform}>{children}</ReactMarkdown>
    </div>
  );
});
