import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getSettings } from "./settings";

let granted: boolean | null = null;

/** Shows a system notification, asking for permission the first time. Never throws. */
export async function notify(title: string, body: string) {
  if (getSettings().notifications?.enabled === false) return;
  try {
    if (granted === null) granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {}
}
