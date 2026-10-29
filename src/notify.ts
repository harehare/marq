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

/** Shows a system notification, asking for permission the first time. Never throws. */
export async function notify(title: string, body: string) {
  if (getSettings().notifications?.enabled === false) return;
  try {
    if (granted === null) granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {}
}
