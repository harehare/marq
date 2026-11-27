// Local models served by Ollama. The Claude backend runs them through Claude Code (`ollama:<name>` models).

/** Ollama's URL from OLLAMA_HOST, as the ollama CLI reads it. */
export function ollamaUrl() {
  const h = process.env.OLLAMA_HOST?.trim() || "127.0.0.1:11434";
  const url = /^https?:\/\//.test(h) ? h : `http://${h}`;
  return url.replace("0.0.0.0", "127.0.0.1").replace(/\/$/, "");
}

/** Pulled models as `ollama:<name>`. */
export async function ollamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
    const body = (await res.json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((m) => `ollama:${m.name}`);
  } catch (e) {
    throw new Error(`Ollama is not reachable at ${ollamaUrl()}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** One reply from a pulled model without going through an agent, for short jobs such as a title. `model` is a bare name (no `ollama:`); the first pulled one when missing. */
export async function ollamaGenerate(prompt: string, model?: string | null): Promise<string> {
  const name = model || (await ollamaModels())[0]?.slice("ollama:".length);
  if (!name) throw new Error("Ollama has no model pulled");
  const res = await fetch(`${ollamaUrl()}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `think: false` keeps reasoning models from spending the short answer on thinking.
    body: JSON.stringify({ model: name, prompt, stream: false, think: false, options: { temperature: 0.2, num_predict: 80 } }),
    signal: AbortSignal.timeout(55_000),
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
  return (((await res.json()) as { response?: string }).response ?? "").trim();
}
