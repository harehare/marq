import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { api } from "./api";

/** Empty is Claude Code's default. */
const CLAUDE_MODELS = [
  { value: "", label: "Claude (default)" },
  { value: "opus", label: "Claude Opus" },
  { value: "sonnet", label: "Claude Sonnet" },
  { value: "haiku", label: "Claude Haiku" },
];

/** Claude aliases plus the models the local Ollama has pulled. */
export function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
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
            {CLAUDE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
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
