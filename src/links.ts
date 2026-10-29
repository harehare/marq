/** Links between notes and boards: plain relative Markdown links, so other editors follow them too. */

/** A card's nested item that is only a link to a note: `[Title](../notes/x.md)`. */
export function noteLink(item: string): { title: string; href: string } | null {
  const m = item.match(/^\[([^\]]*)\]\(([^)\s]+\.md(?:#[^)\s]*)?)\)$/);
  return m ? { title: m[1], href: m[2] } : null;
}

/** The file a relative `.md` link in the file at `from` points to; null for URLs and other files. */
export function resolveLink(from: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return null;
  let target: string;
  try {
    target = decodeURI(href.split("#")[0]);
  } catch {
    return null;
  }
  if (!target.endsWith(".md")) return null;
  const path = target.startsWith("/") ? target : `${from.slice(0, from.lastIndexOf("/"))}/${target}`;
  const parts: string[] = [];
  for (const p of path.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return parts.join("/");
}

/** A link from the file at `from` to the file at `to`, both absolute. */
export function linkTo(from: string, title: string, to: string): string {
  const a = from.split("/").slice(0, -1);
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const rel = [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/").replace(/ /g, "%20");
  return `[${title.replace(/[[\]]/g, "")}](${rel})`;
}
