import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** Editor colors come from the app's CSS tokens, so light and dark follow the system theme. */
export const editorTheme = EditorView.theme({
  "&": { backgroundColor: "var(--bg)", color: "var(--fg)", fontSize: "var(--editor-font-size, 14px)", height: "100%" },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "24px 0",
    caretColor: "var(--accent)",
    lineHeight: "1.7",
  },
  ".cm-line": { padding: "0 32px" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection) !important",
  },
  ".cm-gutters": { display: "none" },
  ".cm-scroller": { overflow: "auto" },
});

export const editorHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.heading1, fontWeight: "700", fontSize: "1.35em", color: "var(--fg-strong)" },
    { tag: t.heading2, fontWeight: "700", fontSize: "1.2em", color: "var(--fg-strong)" },
    { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "700", color: "var(--fg-strong)" },
    { tag: t.strong, fontWeight: "700" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: [t.link, t.url], color: "var(--accent)" },
    { tag: [t.monospace, t.processingInstruction], color: "var(--code)" },
    { tag: [t.meta, t.comment], color: "var(--muted)" },
    { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
    { tag: t.list, color: "var(--accent)" },
    // Code: mq and the other languages in code files and fenced blocks.
    { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--accent)", fontWeight: "600" },
    { tag: [t.string, t.special(t.string), t.regexp], color: "var(--ok)" },
    { tag: [t.number, t.bool, t.atom, t.null], color: "var(--info)" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--info)" },
    { tag: [t.tagName, t.typeName, t.className], color: "var(--run)" },
    { tag: [t.propertyName, t.attributeName], color: "var(--run)" },
    { tag: t.special(t.variableName), color: "var(--err)" },
    { tag: [t.operator, t.punctuation], color: "var(--muted)" },
  ]),
);
