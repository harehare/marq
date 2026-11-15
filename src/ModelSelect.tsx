import { useEffect, useState } from "react";
import { Brain, Cpu } from "lucide-react";
import { api, type ModelOption } from "./api";

const listed = new Map<string, Promise<ModelOption[]>>();

/** The models an agent lists, fetched once per agent; null while loading and when it cannot list them. */
export function useAgentModels(agent: string): ModelOption[] | null {
  const [models, setModels] = useState<ModelOption[] | null>(null);
  useEffect(() => {
    if (agent !== "claude" && agent !== "codex") return setModels(null);
    let p = listed.get(agent);
    if (!p) {
      p = api.agentModels(agent === "claude" ? undefined : agent);
      listed.set(agent, p);
      p.catch(() => listed.delete(agent));
    }
    let live = true;
    p.then((m) => live && setModels(m.length ? m : null), () => live && setModels(null));
    return () => { live = false; };
  }, [agent]);
  return models;
}

/** The efforts the chosen model supports, when the agent said; `value` empty is the agent's default model. */
export function effortsOf(models: ModelOption[] | null, value: string): string[] | undefined {
  const m = models?.find((x) => x.value === value) ?? (value ? undefined : models?.find((x) => x.default));
  return m?.efforts?.length ? m.efforts : undefined;
}

/** Empty is Claude Code's default. */
const CLAUDE_MODELS = [
  { value: "", label: "Claude (default)" },
  { value: "fable", label: "Claude Fable" },
  { value: "opus", label: "Claude Opus" },
  { value: "sonnet", label: "Claude Sonnet" },
  { value: "haiku", label: "Claude Haiku" },
];

/** Claude's models (as Claude Code lists them, the aliases until it has) plus the models the local Ollama has pulled. */
export function ModelSelect({ value, onChange, models }: { value: string; onChange: (v: string) => void; models?: ModelOption[] | null }) {
  // Claude Code's own "default" row is the empty value here.
  const claude = models?.length
    ? models.map((m) => ({ value: m.value === "default" ? "" : m.value, label: m.label, title: m.description }))
    : CLAUDE_MODELS.map((m) => ({ ...m, title: undefined as string | undefined }));
  const known = claude.some((m) => m.value === value) || value.startsWith("ollama:");
  // null: loading; string: error.
  const [ollama, setOllama] = useState<string[] | string | null>(null);
  useEffect(() => {
    api.ollamaModels().then(setOllama, (e) => setOllama(String(e)));
  }, []);
  return (
    <>
      <div className="project-row">
        <Cpu size={14} className="muted" />
        <select className="model-select" value={value} onChange={(e) => onChange(e.target.value)}>
          <optgroup label="Claude">
            {claude.map((m) => <option key={m.value} value={m.value} title={m.title}>{m.label}</option>)}
            {/* A model from the note that the list does not have. */}
            {!known && <option value={value}>{value}</option>}
          </optgroup>
          <optgroup label="Ollama">
            {Array.isArray(ollama) && ollama.map((m) => <option key={m} value={m}>{m.slice("ollama:".length)}</option>)}
            {/* The remembered model, while the list is unavailable. */}
            {value.startsWith("ollama:") && !(Array.isArray(ollama) && ollama.includes(value)) && (
              <option value={value}>{value.slice("ollama:".length)}</option>
            )}
            {ollama === null && <option disabled>Loading…</option>}
            {Array.isArray(ollama) && ollama.length === 0 && <option disabled>No models pulled</option>}
            {typeof ollama === "string" && <option disabled>Not running</option>}
          </optgroup>
        </select>
      </div>
      {value.startsWith("ollama:") && (
        <p className="muted small">
          {typeof ollama === "string"
            ? "Ollama is not running. Start it (ollama serve) before starting the task."
            : "Runs on Ollama through its Anthropic-compatible API. Pick a model with tool calling and a context window of 64k or more."}
        </p>
      )}
    </>
  );
}

/** Used until Codex has listed its models. */
const CODEX_MODELS = ["gpt-5-codex", "gpt-5", "gpt-5-mini"];

/** A text field with Codex's models as suggestions, so a name the list lacks can still be typed. Empty is Codex's default. */
export function CodexModelInput({ value, onChange, models }: { value: string; onChange: (v: string) => void; models?: ModelOption[] | null }) {
  const options = models?.length ? models : CODEX_MODELS.map((m) => ({ value: m, label: m }));
  return (
    <div className="project-row">
      <Cpu size={14} className="muted" />
      <input className="model-select" list="codex-models" value={value} onChange={(e) => onChange(e.target.value.trim())}
        placeholder="Codex model (empty: Codex's default)" title="Passed to Codex as its model. Empty uses ~/.codex/config.toml." />
      <datalist id="codex-models">
        {options.map((m) => <option key={m.value} value={m.value} label={m.label !== m.value ? m.label : undefined} />)}
      </datalist>
    </div>
  );
}

const EFFORTS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

/** How much the agent reasons. Only Claude and Codex take it; `levels` are the ones the chosen model supports, if known. */
export function EffortSelect({ agent, value, onChange, levels }: { agent: string; value: string; onChange: (v: string) => void; levels?: string[] }) {
  const all = levels ?? EFFORTS[agent];
  if (!all) return null;
  return (
    <div className="project-row">
      <Brain size={14} className="muted" />
      <select className="model-select" value={value} onChange={(e) => onChange(e.target.value)} title="Reasoning effort">
        <option value="">Effort (default)</option>
        {all.map((l) => <option key={l} value={l}>{l}</option>)}
        {value && !all.includes(value) && <option value={value}>{value}</option>}
      </select>
    </div>
  );
}
