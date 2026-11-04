import { forwardRef, KeyboardEvent, TextareaHTMLAttributes, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, SlashCommand } from "./api";
import { composing } from "./keys";
import type { Pastes } from "./pastes";

// Lists per directory, shared by every input, so a command list is fetched once.
const cache = new Map<string, Promise<SlashCommand[]>>();

function load(vault: string, cwd: string | undefined, sessionId: string | undefined): Promise<SlashCommand[]> {
  const key = `${sessionId ?? ""}|${cwd ?? vault}`;
  let p = cache.get(key);
  if (!p) {
    p = api.listCommands(vault, { cwd, sessionId }).catch((e) => {
      cache.delete(key);
      throw e;
    });
    cache.set(key, p);
  }
  return p;
}

/** The `/word` being typed at the start of a line, ending at the cursor. */
function slashToken(text: string, cursor: number) {
  const m = text.slice(0, cursor).match(/(^|\n)\/([\w:.-]*)$/);
  return m ? { query: m[2].toLowerCase(), start: cursor - m[2].length - 1 } : null;
}

function rank(cmds: SlashCommand[], q: string) {
  const score = (c: SlashCommand) => {
    const names = [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
    if (names.some((n) => n.startsWith(q))) return 0;
    if (names.some((n) => n.includes(q))) return 1;
    if (c.description.toLowerCase().includes(q)) return 2;
    return 3;
  };
  return cmds
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s < 3)
    // Skills and custom commands before Claude Code's built-ins.
    .sort((a, b) => a.s - b.s || Number(!!a.c.builtin) - Number(!!b.c.builtin) || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c)
    .slice(0, 50);
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> & {
  value: string;
  onChange: (value: string) => void;
  vault: string;
  /** Directory whose skills and commands are offered. Defaults to the session's, then the vault. */
  cwd?: string;
  sessionId?: string;
  /** Where the list opens relative to the field. */
  placement?: "above" | "below";
  /** When given, long pastes show as a placeholder; expand them with `pastes.expand` before sending. */
  pastes?: Pastes;
};

/** A textarea that completes `/` commands and skills from Claude Code. */
export const SlashTextarea = forwardRef<HTMLTextAreaElement, Props>(function SlashTextarea(
  { value, onChange, vault, cwd, sessionId, placement = "above", pastes, onKeyDown, onPaste, ...rest },
  outer,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(outer, () => ref.current!);
  const [token, setToken] = useState<{ query: string; start: number } | null>(null);
  const [cmds, setCmds] = useState<SlashCommand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token || cmds) return;
    load(vault, cwd, sessionId).then(setCmds, (e) => setError(String(e)));
  }, [token, cmds, vault, cwd, sessionId]);

  // Another directory or session has different skills.
  useEffect(() => {
    setCmds(null);
    setError(null);
  }, [cwd, sessionId]);

  const matches = token && cmds ? rank(cmds, token.query) : [];
  const open = !!token && (matches.length > 0 || !cmds || !!error);

  useEffect(() => setIndex(0), [token?.query]);
  useEffect(() => {
    listRef.current?.querySelector(".slash-item.on")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const update = (text: string, cursor: number) => setToken(slashToken(text, cursor));

  const insert = (c: SlashCommand) => {
    if (!token) return;
    const el = ref.current!;
    const end = el.selectionStart;
    const next = `${value.slice(0, token.start)}/${c.name} ${value.slice(end)}`;
    onChange(next);
    setToken(null);
    const pos = token.start + c.name.length + 2;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Keys during IME composition (choosing or confirming Japanese input) belong to the IME.
    if (composing(e)) return;
    if (open && matches.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setIndex((i) => (i + d + matches.length) % matches.length);
        return;
      }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault();
        insert(matches[index]);
        return;
      }
    }
    if (open && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setToken(null);
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <div className="slash-wrap">
      <textarea
        {...rest}
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          update(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={keyDown}
        onPaste={(e) => {
          onPaste?.(e);
          if (e.defaultPrevented || !pastes) return;
          const label = pastes.collapse(e.clipboardData.getData("text/plain"));
          if (!label) return;
          e.preventDefault();
          const el = e.currentTarget;
          const start = el.selectionStart;
          const next = `${value.slice(0, start)}${label}${value.slice(el.selectionEnd)}`;
          onChange(next);
          setToken(null);
          const pos = start + label.length;
          requestAnimationFrame(() => el.setSelectionRange(pos, pos));
        }}
        onClick={(e) => update(value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setToken(null), 120)}
      />
      {open && (
        <div ref={listRef} className={`slash-list ${placement}`} role="listbox">
          {error && <div className="slash-empty err">{error}</div>}
          {!cmds && !error && <div className="slash-empty"><Loader2 size={13} className="spin" /> Loading skills and commands…</div>}
          {matches.map((c, i) => (
            <button
              key={`${c.name}-${i}`}
              className={`slash-item ${i === index ? "on" : ""}`}
              role="option"
              aria-selected={i === index}
              onMouseDown={(e) => {
                e.preventDefault();
                insert(c);
              }}
              onMouseEnter={() => setIndex(i)}
            >
              <span className="slash-name">/{c.name}</span>
              {c.argumentHint && <span className="slash-hint">{c.argumentHint}</span>}
              {!c.builtin && <span className="slash-badge">custom</span>}
              <span className="slash-desc">{c.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
