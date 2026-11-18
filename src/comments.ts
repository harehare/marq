// Comments in a note: one `<!-- comment: text -->` line under the text they are about.
// Once sent to an agent the line reads `<!-- comment (sent): text -->`. Writing "@marq" in a comment asks the agent at once.

const COMMENT = /^<!-- comment( \(sent\))?: (.*) -->$/;
const MENTION = /(^|\s)@marq\b/i;

export type NoteComment = {
  /** 0-based line of the comment. */
  line: number;
  text: string;
  sent: boolean;
  /** The comment mentions @marq. */
  mention: boolean;
};

export const hasMention = (text: string) => MENTION.test(text);

/** The comment as the agent should read it, without the mention. */
export const withoutMention = (text: string) => text.replace(/(^|\s)@marq\b[:,、]?\s*/gi, "$1").trim();

export const formatComment = (text: string, sent = false) =>
  `<!-- comment${sent ? " (sent)" : ""}: ${text.replace(/\s*\n\s*/g, " ").replace(/-->/g, "->").trim()} -->`;

export function parseComment(line: string): { text: string; sent: boolean } | null {
  const m = line.trim().match(COMMENT);
  return m ? { text: m[2], sent: !!m[1] } : null;
}

/** Every comment line outside fenced code and the frontmatter. */
export function findComments(text: string): NoteComment[] {
  const out: NoteComment[] = [];
  const lines = text.split("\n");
  let fence: string | null = null;
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) i = end + 1;
  }
  for (; i < lines.length; i++) {
    const f = lines[i].match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (f) {
      if (!fence) fence = f;
      else if (f[0] === fence[0] && f.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const c = parseComment(lines[i]);
    if (c) out.push({ line: i, ...c, mention: hasMention(c.text) });
  }
  return out;
}

/** First and last line (0-based) of the block of text the line belongs to: up to the blank lines around it. */
export function blockAround(lines: string[], line: number): [number, number] {
  let from = Math.min(line, lines.length - 1);
  let to = from;
  const blank = (n: number) => lines[n].trim() === "";
  while (from > 0 && !blank(from - 1) && !parseComment(lines[from - 1])) from--;
  while (to < lines.length - 1 && !blank(to + 1) && !parseComment(lines[to + 1])) to++;
  return [from, to];
}

/** What a comment is about: the block just above it, or the one below when it opens the note. */
export function subjectOf(lines: string[], commentLine: number): [number, number] {
  let at = commentLine - 1;
  while (at >= 0 && (lines[at].trim() === "" || parseComment(lines[at]))) at--;
  if (at < 0) {
    at = commentLine + 1;
    while (at < lines.length && (lines[at].trim() === "" || parseComment(lines[at]))) at++;
    if (at >= lines.length) return [commentLine, commentLine];
  }
  return blockAround(lines, at);
}

/** The note with a comment added after the block that contains `line`. Returns the new text and the comment's line. */
export function addComment(text: string, line: number, comment: string, sent = false): { text: string; line: number } {
  const lines = text.split("\n");
  const [, end] = blockAround(lines, line);
  // Below any comments already under the block, so they stay in the order they were written.
  let at = end;
  for (let j = end + 1; j < lines.length; j++) {
    if (lines[j].trim() === "") continue;
    if (!parseComment(lines[j])) break;
    at = j;
  }
  const add = ["", formatComment(comment, sent)];
  lines.splice(at + 1, 0, ...add);
  return { text: lines.join("\n"), line: at + add.length };
}

/** Marks the comments at these lines as sent. */
export function markSent(text: string, lines: number[]): string {
  const all = text.split("\n");
  for (const n of lines) {
    const c = parseComment(all[n] ?? "");
    if (c) all[n] = formatComment(c.text, true);
  }
  return all.join("\n");
}

/** The note without the comment at `line`, and the blank line it leaves behind. */
export function removeComment(text: string, line: number): string {
  const all = text.split("\n");
  if (!parseComment(all[line] ?? "")) return text;
  all.splice(line, 1);
  if ((all[line - 1] ?? "x").trim() === "" && (all[line] ?? "").trim() === "") all.splice(line, 1);
  return all.join("\n");
}

/** The prompt part for one comment: what it is about and what it says. */
export function commentRequest(text: string) {
  return `I left this comment in my note, under the text above: ${withoutMention(text)}\n\nDo what it asks. Leave the comment line itself as it is.`;
}

export const ALL_COMMENTS_REQUEST =
  "My note has comments, written as `<!-- comment: ... -->` lines under the text they are about. " +
  "Do what each one asks, skipping any marked `(sent)`: they were handled before. " +
  "Leave the comment lines themselves as they are.";
