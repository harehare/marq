import { useSyncExternalStore } from "react";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { FileEntry } from "./api";

/**
 * `[[Target]]`, `[[Target|label]]` and `[[Target#Heading]]` links between notes. A target names a
 * note by its vault-relative path, file name, title or alias, without `.md` and ignoring case; the
 * same rules as links.rs, which finds backlinks.
 */

// The vault's files, for resolving links where the file list is not passed down (the preview, the editor).
let files: FileEntry[] = [];
const listeners = new Set<() => void>();

export function setVaultFiles(f: FileEntry[]) {
  files = f;
  listeners.forEach((l) => l());
}

export function useVaultFiles() {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => files);
}

const stem = (rel: string) => rel.split("/").pop()!.replace(/\.md$/, "");

export function resolveWiki(all: FileEntry[], target: string): FileEntry | undefined {
  const t = target.trim().replace(/\.md$/, "").toLowerCase();
  if (!t) return undefined;
  return all.find((f) => f.rel.replace(/\.md$/, "").toLowerCase() === t)
    ?? all.find((f) => stem(f.rel).toLowerCase() === t)
    ?? all.find((f) => f.title?.toLowerCase() === t)
    ?? all.find((f) => f.aliases?.some((a) => a.toLowerCase() === t));
}

const WIKI = /\[\[([^[\]|#]+)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g;

/** `marq-wiki:` links the preview renders as links to notes. */
export const WIKI_SCHEME = "marq-wiki:";

/** remark plugin: `[[...]]` in text becomes a link to `marq-wiki:<target>`, shown as its label. */
export function remarkWikilinks() {
  const walk = (node: any) => {
    if (!node.children || node.type === "link" || node.type === "inlineCode" || node.type === "code") return;
    const out: any[] = [];
    for (const child of node.children) {
      if (child.type !== "text" || !child.value.includes("[[")) {
        walk(child);
        out.push(child);
        continue;
      }
      let last = 0;
      for (const m of child.value.matchAll(WIKI)) {
        if (m.index! > last) out.push({ type: "text", value: child.value.slice(last, m.index) });
        const target = m[1].trim();
        out.push({
          type: "link",
          url: WIKI_SCHEME + encodeURIComponent(target),
          children: [{ type: "text", value: (m[3] ?? `${target}${m[2] ?? ""}`).trim() }],
        });
        last = m.index! + m[0].length;
      }
      if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
    }
    node.children = out;
  };
  return (tree: any) => walk(tree);
}

/** Completes `[[` in the editor with notes: their titles, file names and aliases. */
export function wikiCompletion(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/\[\[[^[\]|#\n]*$/);
  if (!m) return null;
  const options = files
    .filter((f) => !f.rel.startsWith("sessions/"))
    .flatMap((f) => {
      const name = f.title ?? stem(f.rel);
      const close = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === "]]" ? "" : "]]";
      return [name, ...(f.aliases ?? [])].map((label, i) => ({
        label,
        detail: i === 0 ? f.rel : `alias of ${name}`,
        apply: label + close,
        boost: i === 0 ? 1 : 0,
      }));
    });
  return { from: m.from + 2, options, validFor: /^[^[\]|#\n]*$/ };
}
