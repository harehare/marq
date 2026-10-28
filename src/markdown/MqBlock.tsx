import { useEffect, useState } from "react";
import { Play, RotateCw, FileText, AlertTriangle, Loader2, Pin } from "lucide-react";
import { api, FileResult } from "../api";
import { Md } from "./Md";

type Props = {
  vault: string;
  notePath: string;
  noteText: string;
  query: string;
  meta: Record<string, string>;
  /** 0-based line of the opening fence, for pinning. */
  line: number;
  onPinned?: (text: string) => void;
};

/** An mq code block in the preview: shows the query and evaluates it right below. */
export function MqBlock({ vault, notePath, noteText, query, meta, line, onPinned }: Props) {
  const [state, setState] = useState<{ results?: FileResult[]; error?: string; ms?: number; loading?: boolean }>({});
  const [runs, setRuns] = useState(0);
  const [raw, setRaw] = useState(false);

  // Evaluation is sandboxed to vault reads, so blocks run automatically when the note changes.
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true }));
      const started = performance.now();
      try {
        const results = await api.mqEval(vault, query, {
          content: meta.input ? undefined : noteText,
          glob: meta.input,
          base: notePath.slice(0, notePath.lastIndexOf("/")),
          aggregate: meta.aggregate !== "false",
        });
        if (alive) setState({ results, ms: performance.now() - started });
      } catch (e) {
        if (alive) setState({ error: String(e) });
      }
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [vault, notePath, query, meta.input, meta.aggregate, meta.input ? "" : noteText, runs]);

  const count = state.results?.reduce((n, r) => n + r.items.length, 0) ?? 0;

  // Pinned output is plain Markdown in the file, so it also shows up outside marq.
  const pin = async () => {
    if (!state.results) return;
    const output = state.results
      .map((r) => (r.file ? `<!-- ${r.file.replace(vault + "/", "")} -->\n` : "") + r.items.join("\n\n"))
      .join("\n\n");
    try {
      onPinned?.(await api.pinMqOutput(vault, notePath, line, output));
    } catch (e) {
      setState((s) => ({ ...s, error: String(e) }));
    }
  };

  return (
    <div className="mq-block">
      <div className="mq-block-head">
        <span className="badge">mq</span>
        {meta.input && <span className="mq-input"><FileText size={12} /> {meta.input}</span>}
        <span className="spacer" />
        {state.loading ? (
          <Loader2 size={13} className="spin" />
        ) : state.error ? (
          <span className="mq-stat err"><AlertTriangle size={12} /> error</span>
        ) : (
          <span className="mq-stat">{count} results · {state.ms?.toFixed(0)}ms</span>
        )}
        <button className={`icon ${raw ? "on" : ""}`} title="Show raw output" onClick={() => setRaw(!raw)}>raw</button>
        {onPinned && (
          <button className="icon" title="Pin output into the note" onClick={pin} disabled={!state.results}>
            <Pin size={13} />
          </button>
        )}
        <button className="icon" title="Run again" onClick={() => setRuns((n) => n + 1)}>
          {runs ? <RotateCw size={13} /> : <Play size={13} />}
        </button>
      </div>
      <pre className="mq-query">{query}</pre>
      <div className="mq-output">
        {state.error && <pre className="err">{state.error}</pre>}
        {state.results?.length === 0 && <div className="muted">No results</div>}
        {state.results?.map((r, i) => (
          <div key={i} className="mq-file">
            {r.file && <div className="mq-file-name">{r.file.replace(vault + "/", "")}</div>}
            {raw ? <pre className="mq-item">{r.items.join("\n")}</pre> : <Md>{r.items.join("\n\n")}</Md>}
          </div>
        ))}
      </div>
    </div>
  );
}
