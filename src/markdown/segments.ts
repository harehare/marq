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
const COMMENT = /^<!-- comment( \(sent\))?: (.*) -->$/;
const PIN_OPEN = "<!-- mq:output -->";
const PIN_CLOSE = "<!-- /mq:output -->";

/**
 * Fence state after line `l`. A fence opens with 3+ backticks or tildes and closes only on a line of the
 * same character, at least as long and with nothing after it, so a ```` block can contain ``` lines.
 * The line that closes a fence still counts as inside it (state is returned as null after it).
 */
function nextFence(open: { ch: string; len: number } | null, l: string): { ch: string; len: number } | null {
  if (open) {
    const close = l.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    return close && close[1][0] === open.ch && close[1].length >= open.len ? null : open;
  }
  const start = l.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!start || (start[1][0] === "`" && start[2].includes("`"))) return null;
  return { ch: start[1][0], len: start[1].length };
}

/**
 * Anchor markers become `[](marq-anchor:<id>)` links and comments `[](marq-comment:<line>:<state>:<text>)` links on the same line, and pinned mq output becomes
 * blank lines (the mq block shows live output instead), so the line count never changes.
 */
export function segments(text: string): Segment[] {
  const fm = parseFrontmatter(text);
  const lines = text.split("\n");
  const out: Segment[] = [];
  let buf: string[] = [];
  let bufStart = fm.lines;
  let result: { session: string; start: number; lines: string[] } | null = null;
  let open: { ch: string; len: number } | null = null; // the fenced block we are inside
  let pinned = false;

  const flush = (next: number) => {
    if (buf.length) out.push({ kind: "md", text: buf.join("\n"), line: bufStart });
    buf = [];
    bufStart = next;
  };

  for (let i = fm.lines; i < lines.length; i++) {
    const l = lines[i];
    if (!open && !result && (pinned || l.trim() === PIN_OPEN)) {
      pinned = l.trim() !== PIN_CLOSE;
      buf.push("");
      continue;
    }
    open = nextFence(open, l);
    const fence = open !== null;
    if (!fence && !result) {
      const marker = l.trim().match(RESULT_OPEN);
      if (marker) {
        flush(i);
        result = { session: marker[1], start: i + 1, lines: [] };
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
    const comment = !fence && !anchor && l.trim().match(COMMENT);
    // `(`, `)` and `'` stay out of the link target, which is the comment's text.
    const enc = (t: string) => encodeURIComponent(t).replace(/[()'!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    buf.push(anchor ? `[](marq-anchor:${anchor[1]})` : comment ? `[](marq-comment:${i}:${comment[1] ? "sent" : "open"}:${enc(comment[2])})` : l);
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
