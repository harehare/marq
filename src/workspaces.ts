import { FileEntry, SessionInfo } from "./api";

export const workspaceTitle = (f: FileEntry) => f.title ?? f.rel.split("/").pop()!.replace(/\.md$/, "");

/** Whether a `workspace:` value (a path, an id or a title) names the workspace note `ws`. */
export function namesWorkspace(value: string | null | undefined, ws: FileEntry) {
  const v = value?.trim();
  if (!v) return false;
  return ws.rel.replace(/\.md$/, "").endsWith(v.replace(/\.md$/, "")) || workspaceTitle(ws).toLowerCase() === v.toLowerCase() || ws.id === v;
}

/**
 * What belongs to a workspace: the sessions that ran on it (newest first), the requests that name
 * it, and the documents those sessions and requests produced.
 */
export function workspaceContents(ws: FileEntry, files: FileEntry[], sessions: SessionInfo[]) {
  const mine = sessions.filter((s) => namesWorkspace(s.workspace, ws));
  const requests = files
    .filter((f) => f.path !== ws.path && !f.rel.startsWith("sessions/") && f.kind !== "doc" && namesWorkspace(f.workspace, ws))
    .sort((a, b) => b.modified - a.modified);
  const origins = new Set([...mine.map((s) => s.origin), ...requests.map((f) => f.id)].filter(Boolean));
  const docs = files.filter((f) => f.kind === "doc" && f.origin && origins.has(f.origin)).sort((a, b) => b.modified - a.modified);
  return { sessions: mine, requests, docs };
}
