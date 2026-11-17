/** Prompts of tasks started or saved from New task, newest last, to pick from again. */
const KEY = "marq.taskHistory";
const MAX = 50;

export function loadTaskHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function saveTaskPrompt(prompt: string) {
  const text = prompt.trim();
  if (!text) return;
  try {
    localStorage.setItem(KEY, JSON.stringify([...loadTaskHistory().filter((t) => t !== text), text].slice(-MAX)));
  } catch {
    // The list is a convenience; without storage there is just none.
  }
}
