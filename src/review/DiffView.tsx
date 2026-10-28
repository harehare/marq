import { useState } from "react";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import { composing } from "../keys";

type Line = { kind: "add" | "del" | "ctx" | "hunk"; text: string; old?: number; new?: number };

/** A review comment on lines of a file's diff. `end` is the line key it is shown under. */
export type DiffComment = { id: string; file: string; start: string; end: string; label: string; code: string[]; text: string };

/** Parses a unified diff into display lines with old/new line numbers. File headers are dropped. */
function parse(diff: string): Line[] {
  const out: Line[] = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (hunk) {
      o = Number(hunk[1]);
      n = Number(hunk[2]);
      inHunk = true;
      out.push({ kind: "hunk", text: hunk[3].trim() || raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) out.push({ kind: "add", text: raw.slice(1), new: n++ });
    else if (raw.startsWith("-")) out.push({ kind: "del", text: raw.slice(1), old: o++ });
    else if (raw.startsWith(" ")) out.push({ kind: "ctx", text: raw.slice(1), old: o++, new: n++ });
    else if (raw.startsWith("\\")) continue;
  }
  return out;
}

/** Stable across reloads: new-side number, or old-side for deleted lines. */
const keyOf = (l: Line) => (l.new !== undefined ? `n${l.new}` : `o${l.old}`);
const sign = (l: Line) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ");

/** "L12-14" (new side), or "old L7" for deleted lines only. */
function label(lines: Line[]) {
  const nums = lines.map((l) => l.new).filter((n): n is number => n !== undefined);
  if (nums.length) return nums[0] === nums[nums.length - 1] ? `L${nums[0]}` : `L${nums[0]}-${nums[nums.length - 1]}`;
  const olds = lines.map((l) => l.old!);
  return olds[0] === olds[olds.length - 1] ? `old L${olds[0]}` : `old L${olds[0]}-${olds[olds.length - 1]}`;
}

type Props = {
  file: string;
  diff: string;
  comments?: DiffComment[];
  onComment?: (c: Omit<DiffComment, "id">) => void;
  onRemoveComment?: (id: string) => void;
};

/** A diff; with `onComment`, click + on a line (shift-click to extend) to comment on it. */
export function DiffView({ file, diff, comments = [], onComment, onRemoveComment }: Props) {
  const lines = parse(diff);
  const [draft, setDraft] = useState<{ from: number; to: number; text: string } | null>(null);
  if (!lines.length) return <div className="muted diff-empty">No textual changes (binary or mode change)</div>;

  const pick = (i: number, extend: boolean) =>
    setDraft((d) => (d && extend ? { ...d, from: Math.min(d.from, i), to: Math.max(d.to, i) } : { from: i, to: i, text: d?.text ?? "" }));

  const save = () => {
    if (!draft?.text.trim() || !onComment) return;
    const sel = lines.slice(draft.from, draft.to + 1).filter((l) => l.kind !== "hunk");
    if (!sel.length) return;
    onComment({ file, start: keyOf(sel[0]), end: keyOf(sel[sel.length - 1]), label: label(sel), code: sel.map((l) => sign(l) + l.text), text: draft.text.trim() });
    setDraft(null);
  };

  const keys = new Set(lines.filter((l) => l.kind !== "hunk").map(keyOf));
  const outdated = comments.filter((c) => !keys.has(c.end));
  const bubble = (c: DiffComment) => (
    <div key={c.id} className="diff-comment">
      <span className="diff-comment-where">{c.label}</span>
      <span className="diff-comment-text">{c.text}</span>
      {onRemoveComment && <button className="icon" title="Remove" onClick={() => onRemoveComment(c.id)}><Trash2 size={12} /></button>}
    </div>
  );

  return (
    <div className="diff">
      {lines.map((l, i) => {
        if (l.kind === "hunk") return <div key={i} className="diff-hunk">{l.text}</div>;
        const selected = draft && i >= draft.from && i <= draft.to;
        return (
          <div key={i}>
            <div className={`diff-line ${l.kind} ${selected ? "selected" : ""}`}>
              {onComment && (
                <button className="diff-add" title="Comment (shift-click to extend)" onClick={(e) => pick(i, e.shiftKey)}>
                  <MessageSquarePlus size={11} />
                </button>
              )}
              <span className="ln">{l.old ?? ""}</span>
              <span className="ln">{l.new ?? ""}</span>
              <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
              <span className="code">{l.text}</span>
            </div>
            {comments.filter((c) => c.end === keyOf(l)).map(bubble)}
            {draft && draft.to === i && (
              <div className="diff-draft">
                <textarea autoFocus value={draft.text} placeholder={`Comment on ${label(lines.slice(draft.from, draft.to + 1).filter((x) => x.kind !== "hunk"))}…  ⌘↵ to add`}
                  onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (composing(e)) return;
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
                    if (e.key === "Escape") setDraft(null);
                  }} />
                <div className="row">
                  <span className="muted small">Shift-click + on another line to cover a range.</span>
                  <span className="spacer" />
                  <button onClick={() => setDraft(null)}>Cancel</button>
                  <button className="primary" onClick={save} disabled={!draft.text.trim()}>Add comment</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {outdated.length > 0 && <div className="diff-outdated muted small">Lines changed since commenting:</div>}
      {outdated.map(bubble)}
    </div>
  );
}
