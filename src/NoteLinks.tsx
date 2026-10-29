import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowUpRight, CornerDownLeft, FilePlus2, Link2 } from "lucide-react";
import { api, NoteLinks, NoteRef } from "./api";
import { useVaultFiles } from "./wikilinks";

/** Makes the first mention of the note on a line a `[[link]]`, keeping the words as written. */
async function linkMention(vault: string, ref: NoteRef, title: string, names: string[]) {
  const text = await api.readNote(vault, ref.path);
  const lines = text.split("\n");
  const line = lines[ref.line - 1] ?? "";
  const lower = line.toLowerCase();
  const hit = names
    .map((n) => ({ n, at: lower.indexOf(n.toLowerCase()) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at || b.n.length - a.n.length)[0];
  if (!hit) return;
  const written = line.slice(hit.at, hit.at + hit.n.length);
  const link = written === title ? `[[${title}]]` : `[[${title}|${written}]]`;
  lines[ref.line - 1] = line.slice(0, hit.at) + link + line.slice(hit.at + hit.n.length);
  await api.writeNote(vault, ref.path, lines.join("\n"));
}

/** The note's backlinks, unlinked mentions, outgoing links and [[links]] to notes not written yet. */
export function NoteLinksPanel({ vault, path, onOpenFile }: { vault: string; path: string; onOpenFile: (path: string) => void }) {
  const [links, setLinks] = useState<NoteLinks | null>(null);
  const files = useVaultFiles();
  const me = files.find((f) => f.path === path);
  const title = me?.title ?? path.split("/").pop()!.replace(/\.md$/, "");

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => api.noteLinks(vault, path).then(setLinks, () => setLinks(null));
    load();
    const un = listen("vault://changed", () => {
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    });
    return () => {
      clearTimeout(timer);
      un.then((f) => f());
    };
  }, [vault, path]);

  if (!links) return null;
  const row = (r: NoteRef, action?: React.ReactNode) => (
    <div key={`${r.path}:${r.line}`} className="link-ref">
      <a onClick={() => onOpenFile(r.path)} title={`${r.rel}:${r.line}`}>
        <span className="link-ref-title">{r.title ?? r.rel.split("/").pop()!.replace(/\.md$/, "")}</span>
        <span className="muted small link-ref-text">{r.text}</span>
      </a>
      {action}
    </div>
  );
  return (
    <>
      <h4><CornerDownLeft size={11} /> Linked from <span className="count">{links.linked.length}</span></h4>
      {links.linked.length === 0 && <p className="muted small">No note links here yet. Link with [[{title}]].</p>}
      {links.linked.map((r) => row(r))}
      {links.mentions.length > 0 && <>
        <h4>Mentioned in <span className="count">{links.mentions.length}</span></h4>
        {links.mentions.map((r) => row(r, (
          <button className="icon" title={`Make it a link: [[${title}]]`}
            onClick={() => linkMention(vault, r, title, [title, ...(me?.aliases ?? []), path.split("/").pop()!.replace(/\.md$/, "")])}>
            <Link2 size={12} />
          </button>
        )))}
      </>}
      {links.outgoing.length > 0 && <>
        <h4><ArrowUpRight size={11} /> Links to <span className="count">{links.outgoing.length}</span></h4>
        {links.outgoing.map((rel) => {
          const f = files.find((x) => x.rel === rel);
          return (
            <div key={rel} className="link-ref">
              <a onClick={() => onOpenFile(f?.path ?? `${vault}/${rel}`)} title={rel}><span className="link-ref-title">{f?.title ?? rel.replace(/\.md$/, "")}</span></a>
            </div>
          );
        })}
      </>}
      {links.missing.length > 0 && <>
        <h4>Not written yet <span className="count">{links.missing.length}</span></h4>
        {links.missing.map((t) => (
          <div key={t} className="link-ref">
            <span className="wikilink missing">{t}</span>
            <button className="icon" title={`Create notes/${t}.md`}
              onClick={() => api.wikilinkOpen(vault, t, true).then((p) => p && onOpenFile(p))}><FilePlus2 size={12} /></button>
          </div>
        ))}
      </>}
    </>
  );
}
