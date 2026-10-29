// Splits a note into renderable segments while keeping original line numbers (0-based),
// so preview actions (ask from a heading, jump to edit) map back to the source.

export type Segment =
  | { kind: "md"; text: string; line: number }
  | { kind: "result"; session: string; text: string; line: number };

export type Frontmatter = { fields: [string, string][]; lines: number };

export function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith("---\n")) return { fields: [], lines: 0 };
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  if (end < 0) return { fields: [], lines: 0 };
  const fields: [string, string][] = [];
  for (const l of lines.slice(1, end)) {
    const m = l.match(/^([\w-]+):\s*(.*)$/);
    // `  - item` under an empty key is a YAML block list; it is shown like `[a, b]`.
    const item = l.match(/^\s+-\s+(.*)$/);
    if (m) fields.push([m[1], m[2].replace(/^["']|["']$/g, "")]);
    else if (item && fields.length) {
      const last = fields[fields.length - 1];
      const v = item[1].replace(/^["']|["']$/g, "");
      last[1] = last[1] ? `${last[1].replace(/\]$/, "")}, ${v}]` : `[${v}]`;
    }
  }
  return { fields, lines: end + 1 };
}

// `claude:` markers are from notes written before they were renamed to `marq:`.
const RESULT_OPEN = /^<!-- (?:marq|claude):result session="([^"]+)" -->$/;
const RESULT_CLOSE = /^<!-- \/(?:marq|claude):result -->$/;
const ANCHOR = /^<!-- (?:marq|claude):anchor id="([^"]+)" -->$/;
const PIN_OPEN = "<!-- mq:output -->";
const PIN_CLOSE = "<!-- /mq:output -->";

/**
 * Anchor markers become `[](marq-anchor:<id>)` links on the same line, and pinned mq output becomes
 * blank lines (the mq block shows live output instead), so the line count never changes.
 */
export function segments(text: string): Segment[] {
  const fm = parseFrontmatter(text);
  const lines = text.split("\n");
  const out: Segment[] = [];
  let buf: string[] = [];
  let bufStart = fm.lines;
  let result: { session: string; start: number; lines: string[] } | null = null;
  let fence = false;
  let pinned = false;

  const flush = (next: number) => {
    if (buf.length) out.push({ kind: "md", text: buf.join("\n"), line: bufStart });
    buf = [];
    bufStart = next;
  };

  for (let i = fm.lines; i < lines.length; i++) {
    const l = lines[i];
    if (!fence && !result && (pinned || l.trim() === PIN_OPEN)) {
      pinned = l.trim() !== PIN_CLOSE;
      buf.push("");
      continue;
    }
    if (l.trimStart().startsWith("```")) fence = !fence;
    if (!fence && !result) {
      const open = l.trim().match(RESULT_OPEN);
      if (open) {
        flush(i);
        result = { session: open[1], start: i + 1, lines: [] };
        continue;
      }
    }
    if (result) {
      if (!fence && RESULT_CLOSE.test(l.trim())) {
        out.push({ kind: "result", session: result.session, text: result.lines.join("\n"), line: result.start });
        result = null;
        bufStart = i + 1;
      } else {
        result.lines.push(l);
      }
      continue;
    }
    const anchor = !fence && l.trim().match(ANCHOR);
    buf.push(anchor ? `[](marq-anchor:${anchor[1]})` : l);
  }
  if (result) buf.push(...result.lines);
  flush(lines.length);
  return out;
}

/** Parses an info string like `mq input=./daily/*.md aggregate=false`. */
export function fenceMeta(meta: string | null | undefined): Record<string, string> {
  return Object.fromEntries(
    (meta ?? "")
      .split(/\s+/)
      .filter((kv) => kv.includes("="))
      .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
  );
}
