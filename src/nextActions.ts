/** A suggested next step an agent offers at the end of a turn, shown as a button. */
export type NextAction = { label: string; prompt: string; reason?: string };

// A ```next block, or one still being written (no closing fence yet).
const BLOCK = /(?:^|\n)```next[^\S\n]*\n([\s\S]*?)(?:\n```[^\S\n]*(?=\n|$)|$)/g;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Takes the `next` block out of a message; `actions` is empty when it is missing or not valid JSON. */
export function splitNext(text: string): { text: string; actions: NextAction[] } {
  let actions: NextAction[] = [];
  const rest = text.replace(BLOCK, (_, body: string) => {
    try {
      const list = JSON.parse(body.trim());
      if (Array.isArray(list)) {
        actions = list
          .map((x) => ({ label: str(x?.label, 60), prompt: str(x?.prompt, 1000), reason: str(x?.reason, 160) || undefined }))
          .filter((a) => a.label && a.prompt)
          .slice(0, 3);
      }
    } catch {}
    return "";
  });
  return { text: rest.trimEnd(), actions };
}
