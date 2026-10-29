import { FileResult } from "./api";

/** What an agent gets from mq results: all of it, or one block per file. */
export type QueryContext = {
  /** How many results, in how many files. */
  items: number;
  files: number;
  /** One entry per file in `each`, for the file name shown next to a session started from it. */
  names: string[];
  all: string;
  each: string[];
  /** From a saved query: the prompt to start with, and one session per file. */
  prompt?: string;
  perFile?: boolean;
};

/** A frontmatter value `save_query` wrote as a JSON string. */
export function fmValue(text: string, key: string): string | undefined {
  const raw = text.match(/^---\n([\s\S]*?)\n---/)?.[1]?.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"))?.[1]?.trim();
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw);
    return typeof v === "string" ? v : raw;
  } catch {
    return raw.replace(/^["']|["']$/g, "");
  }
}

// A session prompt, not a transcript: long results are cut so one query cannot fill the context.
const MAX_CHARS = 40_000;

const cut = (text: string) => (text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n\n… (cut, ask for the rest by reading the file)" : text);

/** Turns mq output into prompt text, with the query and files so the agent can look further. */
export function queryContext(
  vault: string, query: string, glob: string | undefined, results: FileResult[], agent?: { prompt?: string; perFile?: boolean },
): QueryContext {
  const head = `The results of this mq query${glob ? ` over ${glob}` : ""} (vault: ${vault}):\n\n\`\`\`mq\n${query}\n\`\`\``;
  const section = (r: FileResult) => {
    const file = r.file ? r.file.replace(vault + "/", "") : "this note";
    return `### ${file}\n\n${r.items.join("\n\n")}`;
  };
  return {
    items: results.reduce((n, r) => n + r.items.length, 0),
    files: results.length,
    names: results.map((r) => (r.file ? r.file.replace(vault + "/", "") : "this note")),
    all: cut(`${head}\n\n${results.map(section).join("\n\n")}`),
    each: results.map((r) => cut(`${head}\n\n${section(r)}`)),
    ...agent,
  };
}

/** The event the Run agent buttons send and App turns into the New task dialog. */
export const RUN_AGENT_EVENT = "marq:run-agent";

export function runAgent(ctx: QueryContext) {
  window.dispatchEvent(new CustomEvent(RUN_AGENT_EVENT, { detail: ctx }));
}
