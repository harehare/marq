import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getSettings } from "./settings";

let granted: boolean | null = null;

/** Markdown as one plain line, cut to fit a notification. */
export function summary(text: string, max = 180) {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#+|[-*+]|\d+\.|>)\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** Notifications within this many ms of the last one are sent together. */
const WINDOW_MS = 5000;
const MAX_LINES = 4;

type Item = { title: string; body: string };
let queue: Item[] = [];
let window_: ReturnType<typeof setTimeout> | undefined;

/** What one notification says for the items held back: the item itself, or a list. */
export function combine(items: Item[]): Item {
  // The same message twice (a session asking again) counts once.
  const seen = new Set<string>();
  const uniq = items.filter((i) => {
    const k = `${i.title}\n${i.body}`;
    return !seen.has(k) && !!seen.add(k);
  });
  if (uniq.length === 1) return uniq[0];
  const lines = uniq.slice(0, MAX_LINES).map((i) => `${i.title}: ${i.body.split("\n")[0]}`);
  if (uniq.length > MAX_LINES) lines.push(`and ${uniq.length - MAX_LINES} more`);
  return { title: `Marq · ${uniq.length} updates`, body: lines.join("\n") };
}

async function send({ title, body }: Item) {
  try {
    if (granted === null) granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {}
}

/** When a window ends, what came in during it goes out as one, and a new window starts so a long burst stays one at a time. */
function endWindow() {
  window_ = undefined;
  if (!queue.length) return;
  const items = queue;
  queue = [];
  void send(combine(items));
  window_ = setTimeout(endWindow, WINDOW_MS);
}

/**
 * Shows a system notification, asking for permission the first time. Never throws. The first one
 * goes out at once; ones that follow within a few seconds are held and sent as a single summary,
 * so a schedule that starts several sessions does not bury the screen.
 */
export async function notify(title: string, body: string) {
  if (getSettings().notifications?.enabled === false) return;
  if (window_ !== undefined) {
    queue.push({ title, body });
    return;
  }
  window_ = setTimeout(endWindow, WINDOW_MS);
  await send({ title, body });
}
