import { FileEntry, SessionInfo } from "./api";

/**
 * How the sidebar's Recent list is divided: `none`, `date`, `project`, `workspace`, or `field:<key>`
 * for what sessions are filed under (their request's `tags` and the user's own keys).
 */
export type RecentGroup = string;

/** The choices, with one for each of the user's own keys. */
export function recentGroups(keys: string[]): { value: RecentGroup; label: string }[] {
  return [
    { value: "none", label: "No groups" },
    { value: "date", label: "Group by date" },
    { value: "project", label: "Group by project" },
    { value: "workspace", label: "Group by workspace" },
    { value: "field:tags", label: "Group by tag" },
    ...keys.map((k) => ({ value: `field:${k}`, label: `Group by ${k}` })),
  ];
}

/** The folder a session worked on: its repository's, else its directory's. */
export const projectName = (s: SessionInfo) => (s.worktree?.repo ?? s.cwd).split("/").filter(Boolean).pop() ?? "~";

/** A workspace note's title by its vault-relative path. */
function workspaceTitles(files: FileEntry[]) {
  return new Map(files.filter((f) => f.kind === "workspace").map((f) => [f.rel, f.title ?? f.rel.split("/").pop()!.replace(/\.md$/, "")]));
}

const workspaceName = (s: SessionInfo, titles: Map<string, string>) => (s.workspace ? titles.get(s.workspace) ?? s.workspace : "");

/** Sessions with every word of `q` in their title, project, branch, workspace, status, origin or what they are filed under, ignoring case. */
export function filterSessions(sessions: SessionInfo[], q: string, files: FileEntry[]) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return sessions;
  const titles = workspaceTitles(files);
  return sessions.filter((s) => {
    const text = [s.title, s.worktree?.repo ?? s.cwd, s.worktree?.branch, workspaceName(s, titles), s.status, s.origin_path, s.started.slice(0, 10), ...Object.values(s.fields ?? {}).flat()]
      .filter(Boolean).join("\n").toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Today, Yesterday, the last 7 and 30 days, then the month. */
function dateLabel(iso: string, now: Date) {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "Unknown";
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(t)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Last 7 days";
  if (days < 30) return "Last 30 days";
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * `sessions` (newest first) under a label each. Groups come in the order of their newest session,
 * with the sessions that have no workspace (or no value for the key) last. A session with several
 * values for a key is under each. `none` is one group without a label.
 */
export function groupRecent(sessions: SessionInfo[], by: RecentGroup, files: FileEntry[], now = new Date()) {
  if (by === "none") return [{ label: "", items: sessions }];
  const titles = workspaceTitles(files);
  const key = by.startsWith("field:") ? by.slice(6) : "";
  const NONE = key === "tags" ? "Untagged" : key ? `No ${key}` : "No workspace";
  const groups = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const labels = by === "date" ? [dateLabel(s.started, now)] : by === "project" ? [projectName(s)]
      : key ? s.fields?.[key] ?? [] : [workspaceName(s, titles)];
    for (const label of labels.filter(Boolean).length ? labels.filter(Boolean) : [NONE]) groups.set(label, [...(groups.get(label) ?? []), s]);
  }
  const out = [...groups.entries()].map(([label, items]) => ({ label, items }));
  return by === "workspace" || key ? [...out.filter((g) => g.label !== NONE), ...out.filter((g) => g.label === NONE)] : out;
}
