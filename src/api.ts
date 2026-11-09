import { invoke } from "@tauri-apps/api/core";

export type SearchHit = { path: string; rel: string; title: string | null; lines: [number, string][]; more: number };
export type Card = { id: string; title: string; done: boolean; owner: string | null; labels: string[]; notes: string[] };
export type Board = { lists: { name: string; cards: Card[] }[]; queue: Queue | null };
/** A list marq works through: each card put there starts a session (see automation.rs). */
export type Queue = {
  list: string; doing: string; review: string; max: number; project: string;
  model: string | null; permission_mode: string | null; worktree: boolean;
  /** A command that checks each card's work after its turn. */
  verify?: string | null;
  /** A workspace note whose directories each card's session gets. */
  workspace?: string | null;
  /** `on` or `strict`: Bash runs in Claude Code's sandbox. */
  sandbox?: string | null;
};
/** How a request's work is checked and run; see docs/workflows.md. */
export type TaskChecks = {
  verify?: string; verifyRetry?: "fresh"; verifyRetries?: number; sandbox?: string; phases?: string[]; acceptance?: string;
  /** A workspace note, for its directories (and project when none is given). */
  workspace?: string;
  /** Directories beyond the project, when not from a workspace. */
  directories?: DirSpec[];
};
/** A directory beyond the project; `worktree` gives a git repository its own worktree on the session's branch. */
export type DirSpec = { path: string; worktree: boolean };
/** A saved set of directories: `workspaces/<name>.md`. */
export type Workspace = { path: string; rel: string; title: string; project: string | null; directories: DirSpec[]; notes: string };
/** A directory a session got beyond its own: `path` is where the agent works (its worktree, if it has one). */
export type ExtraDir = { path: string; source: string; worktree?: Worktree | null };
export type NoteRef = { path: string; rel: string; title: string | null; line: number; text: string };
/** Links into a note, mentions of it that are not links, what it links to, and its `[[links]]` to no note. */
export type NoteLinks = { linked: NoteRef[]; mentions: NoteRef[]; outgoing: string[]; missing: string[] };
export type Schedule = {
  path: string; rel: string; title: string | null; every: string | null; at: string | null; enabled: boolean;
  last_run: string | null; next_run: string | null; running: boolean;
};
export type FileEntry = {
  path: string; id: string | null; rel: string; title: string | null; kind: string | null; status: string | null;
  /** From the frontmatter `tags:` and `aliases:`. */
  tags: string[]; aliases: string[];
};
export type Anchor = { id: string; line: number };
export type FileResult = { file: string | null; items: string[] };
export type SessionInfo = {
  id: string;
  title: string;
  origin: string;
  origin_path: string;
  cwd: string;
  started: string;
  status: string;
  path: string;
  worktree: Worktree | null;
  /** Directories beyond `cwd`, from a workspace or the request. */
  dirs?: ExtraDir[];
  additions: number | null;
  deletions: number | null;
  /** `done` or `pr` once reviewed. */
  review: string | null;
  pr_url: string | null;
  /** A Claude alias or `ollama:<name>`; empty for the default. */
  model?: string | null;
  /** Set for crew members. */
  crew?: { id: string; role: string };
};
export type Worktree = { repo: string; path: string; branch: string; base: string; base_branch: string };
export type FileChange = { path: string; status: string; additions: number; deletions: number };
export type Changes = { files: FileChange[]; additions: number; deletions: number; commits: string[]; dirty: boolean; upstream: string | null; ahead: number; branch: string | null };
export type SlashCommand = { name: string; description: string; argumentHint: string; aliases?: string[]; builtin?: boolean };
export type Approval = {
  request_id: string;
  session_id: string;
  tool_name: string;
  input: any;
  title: string | null;
  reason: string | null;
};
export type CrewMember = { role: string; permission_mode: string | null; worktree: boolean; model: string | null; instructions: string };
export type CrewMemberState = {
  role: string;
  session_id: string | null;
  /** idle (no session yet), running, waiting, done, error or interrupted. */
  status: string;
  /** Messages waiting for the member's next turn. */
  pending: number;
  cwd: string | null;
  branch: string | null;
  /** What it runs on from its next turn: its own model, else the crew's; null for Claude Code's default. */
  model: string | null;
};
export type CrewMessage = {
  /** `crew_event` lines (e.g. a member was added) carry only `text` and `at`. */
  type: "crew_msg" | "crew_event";
  id: string;
  from: string;
  /** One recipient, or several for a broadcast or a discussion. */
  to: string | string[];
  kind: "tell" | "ask" | "reply" | "decision";
  text: string;
  reply_to?: string;
  hop: number;
  at: string;
  /** Held at the hop limit until the user releases it. */
  held?: boolean;
  released: boolean;
  delivered: boolean;
};
export type CrewTask = { id: string; title: string; status: string; owner: string | null; labels: string[]; notes: string[] };
export type CrewDoc = { path: string; rel: string; title: string | null; updated?: string };
export type CrewState = {
  id: string;
  title: string;
  path: string;
  rel: string;
  project: string | null;
  max_hops: number;
  /** The members' model unless they set their own. */
  model: string | null;
  members: CrewMember[];
  goal: string;
  members_state: CrewMemberState[];
  messages: CrewMessage[];
  tasks: CrewTask[];
  /** The task list's absolute path. */
  tasks_path: string;
  docs: CrewDoc[];
};
// Agent SDK messages plus marq_meta / marq_user / marq_approval / marq_exit.
export type SessionEvent = { type: string; [k: string]: any };

/** A standing session with a role, defined by a note under `helpers/`. */
export type Helper = {
  path: string;
  name: string;
  summary: string;
  model: string | null;
  agent: string | null;
  session: string | null;
};

export type AgentInfo = { id: string; label: string; command: string; args: string[]; installed: boolean };

export const api = {
  listFiles: (vault: string) => invoke<FileEntry[]>("list_files", { vault }),
  readNote: (vault: string, path: string) => invoke<string>("read_note", { vault, path }),
  writeNote: (vault: string, path: string, content: string) => invoke<void>("write_note", { vault, path, content }),
  createNote: (vault: string, rel: string, kind: string) => invoke<string>("create_note", { vault, rel, kind }),
  /** A new untitled note in notes/, or a scratch memo in scratch/; returns its path. */
  createUntitled: (vault: string, scratch: boolean) => invoke<string>("create_untitled", { vault, scratch }),
  /** Deletes an untitled note or scratch memo with nothing in it. */
  discardUntitled: (vault: string, path: string) => invoke<boolean>("discard_untitled", { vault, path }),
  sweepScratch: (vault: string) => invoke<{ removed: string[]; trashed: string[] }>("sweep_scratch", { vault }),
  /** Keeps a scratch memo as a note at `to` (relative to the vault). */
  keepScratch: (vault: string, from: string, to: string) =>
    invoke<{ to: string; moved: { from: string; to: string }[]; relinked: string[] }>("keep_scratch", { vault, from, to }),
  pinMqOutput: (vault: string, path: string, line: number, output: string) =>
    invoke<string>("pin_mq_output", { vault, path, line, output }),
  noteAnchors: (content: string) => invoke<Anchor[]>("note_anchors", { content }),
  mqEval: (vault: string, query: string, opts: { content?: string; glob?: string; base?: string; aggregate: boolean }) =>
    invoke<FileResult[]>("mq_eval", { vault, query, ...opts }),
  runFromNote: (vault: string, path: string, line: number, options?: {
    intent?: string; instruction?: string; project?: string; worktree?: boolean; model?: string;
    excerpt?: { text: string; from: number; to: number };
  }) =>
    invoke<{ session_id: string; content: string }>("run_from_note", { vault, path, line, options }),
  renameSession: (vault: string, sessionId: string, title: string) => invoke<void>("rename_session", { vault, sessionId, title }),
  /** Sends text from session `from` to `to` for the user; with `reply`, the answer comes back to `from`. */
  forwardMessage: (vault: string, from: string, to: string, text: string, reply: boolean) =>
    invoke<void>("forward_message", { vault, from, to, text, reply }),
  sendMessage: (vault: string, sessionId: string, text: string) =>
    invoke<void>("send_message", { vault, sessionId, text }),
  stopSession: (sessionId: string) => invoke<boolean>("stop_session", { sessionId }),
  resumeSession: (vault: string, sessionId: string) => invoke<void>("resume_session", { vault, sessionId }),
  sessionEvents: (vault: string, sessionId: string) => invoke<SessionEvent[]>("session_events", { vault, sessionId }),
  listSessions: (vault: string, origin?: string) => invoke<SessionInfo[]>("list_sessions", { vault, origin }),
  /** With `autoTitle`, a small model names the task and `title` is the fallback. */
  newTask: (vault: string, task: {
    title: string; prompt: string; project: string; permissionMode?: string; model?: string; agent?: string; carryChanges: boolean; worktree: boolean; autoTitle: boolean;
  } & TaskChecks) =>
    invoke<{ session_id: string; title: string; content: string }>("new_task", { vault, task }),
  /** Agents a task can run on: Claude, and others that speak ACP. */
  listAgents: () => invoke<AgentInfo[]>("list_agents"),
  listHelpers: (vault: string) => invoke<Helper[]>("list_helpers", { vault }),
  createHelper: (vault: string, name: string) => invoke<string>("create_helper", { vault, name }),
  /** Returns the helper's session id. `from` gets the answer back when `reply`. */
  sendToHelper: (vault: string, path: string, text: string, from: string | null, reply: boolean, fresh: boolean) =>
    invoke<string>("send_to_helper", { vault, path, text, from, reply, fresh }),
  /** Saves the task as a request note in the Inbox without running it; returns its path in the vault. */
  saveTask: (vault: string, task: {
    title: string; prompt: string; project: string; permissionMode?: string; model?: string; agent?: string; carryChanges: boolean; worktree: boolean; autoTitle: boolean;
  } & TaskChecks) => invoke<string>("save_task", { vault, task }),
  /** One request on 2 to 4 models, each in its own worktree. */
  newTaskCompare: (vault: string, task: {
    title: string; prompt: string; project: string; permissionMode?: string; carryChanges: boolean; worktree: boolean; autoTitle: boolean;
  } & TaskChecks, models: string[]) =>
    invoke<{ request: string; sessions: { session_id: string; title: string }[] }>("new_task_compare", { vault, task, models }),
  /** `answers`: for AskUserQuestion, question text -> chosen label(s), comma-separated. */
  answerApproval: (requestId: string, allow: boolean, always: boolean, message?: string, answers?: Record<string, string>) =>
    invoke<void>("answer_approval", { requestId, allow, always, message, answers }),
  listApprovals: (sessionId?: string) => invoke<Approval[]>("list_approvals", { sessionId }),
  listCommands: (vault: string, opts: { cwd?: string; sessionId?: string }) =>
    invoke<SlashCommand[]>("list_commands", { vault, ...opts }),
  summarizeSession: (vault: string, sessionId: string) => invoke<string>("summarize_session", { vault, sessionId }),
  sessionCheckout: (vault: string, sessionId: string) => invoke<Worktree | null>("session_checkout", { vault, sessionId }),
  sessionChanges: (vault: string, sessionId: string, repo?: string) => invoke<Changes>("session_changes", { vault, sessionId, repo }),
  sessionFileDiff: (vault: string, sessionId: string, file: string, repo?: string) =>
    invoke<string>("session_file_diff", { vault, sessionId, file, repo }),
  sessionCommit: (vault: string, sessionId: string, message: string, repo?: string) =>
    invoke<string>("session_commit", { vault, sessionId, message, repo }),
  setSessionReview: (vault: string, sessionId: string, state: "done" | "open") =>
    invoke<void>("set_session_review", { vault, sessionId, state }),
  sessionPush: (vault: string, sessionId: string, repo?: string) => invoke<string>("session_push", { vault, sessionId, repo }),
  /** For a session without a worktree: pushes its project's current branch. */
  sessionPushCwd: (vault: string, sessionId: string) => invoke<string>("session_push_cwd", { vault, sessionId }),
  /** The first line of `message` is the PR title, the rest its body. */
  sessionCreatePr: (vault: string, sessionId: string, message: string, repo?: string) =>
    invoke<string>("session_create_pr", { vault, sessionId, message, repo }),
  sessionRenameBranch: (vault: string, sessionId: string, branch: string, repo?: string) =>
    invoke<Worktree>("session_rename_branch", { vault, sessionId, branch, repo }),
  sessionRemoveWorktree: (vault: string, sessionId: string, repo?: string) => invoke<void>("session_remove_worktree", { vault, sessionId, repo }),
  listWorkspaces: (vault: string) => invoke<Workspace[]>("list_workspaces", { vault }),
  /** Saves the directories as `workspaces/<title>.md`; returns its path. */
  createWorkspace: (vault: string, title: string, project: string, directories: DirSpec[]) =>
    invoke<string>("create_workspace", { vault, title, project, directories }),
  openIn: (path: string, app: "finder" | "vscode" | "reveal") => invoke<void>("open_in", { path, app }),
  deleteSession: (vault: string, sessionId: string, removeWorktree: boolean, deleteBranch: boolean) =>
    invoke<void>("delete_session", { vault, sessionId, removeWorktree, deleteBranch }),
  deleteNote: (vault: string, path: string) => invoke<void>("delete_note", { vault, path }),
  listDirs: (vault: string) => invoke<string[]>("list_dirs", { vault }),
  createFolder: (vault: string, path: string) => invoke<string>("create_folder", { vault, path }),
  /** Moves or renames a note or folder (relative paths) and rewrites relative links. */
  movePath: (vault: string, from: string, to: string) =>
    invoke<{ to: string; moved: { from: string; to: string }[]; relinked: string[] }>("move_path", { vault, from, to }),
  setNoteStatus: (vault: string, path: string, status: string) => invoke<void>("set_note_status", { vault, path, status }),
  recentProjects: (vault: string) => invoke<string[]>("recent_projects", { vault }),
  /** `crewId` is the crew note's id or vault-relative path. */
  crewState: (vault: string, crewId: string) => invoke<CrewState>("crew_state", { vault, crewId }),
  /** Documents a session's task produced (`write_doc`), newest first. */
  sessionDocs: (vault: string, sessionId: string) => invoke<CrewDoc[]>("session_docs", { vault, sessionId }),
  crewSend: (vault: string, crewId: string, to: string, text: string) =>
    invoke<{ id: string; held: boolean }>("crew_send", { vault, crewId, to, text }),
  crewKickOff: (vault: string, crewId: string) => invoke<void>("crew_kick_off", { vault, crewId }),
  /** Empty goes back to the crew's model. */
  crewSetModel: (vault: string, crewId: string, role: string, model: string) =>
    invoke<string | null>("crew_set_model", { vault, crewId, role, model }),
  /** Starts a task as a crew: a crew note with the prompt as its Goal, sent to its lead. */
  terminalOpen: (id: string, cwd: string, cols: number, rows: number, command?: string) =>
    invoke<void>("terminal_open", { id, cwd, cols, rows, command }),
  /** `expanded`: each word the glossary or aliases widened, with what it also matched (the word first). */
  searchText: (vault: string, query: string, includeSessions: boolean) =>
    invoke<{ hits: SearchHit[]; expanded: string[][] }>("search_text", { vault, query, includeSessions }),
  /** glossary.md, created with an example entry when missing. */
  glossaryPath: (vault: string) => invoke<string>("glossary_path", { vault }),
  /** Marks a knowledge note as checked by the user. */
  knowledgeReview: (vault: string, path: string) => invoke<void>("knowledge_review", { vault, path }),
  /** The daily schedule that merges learnings into knowledge notes; created the first time. */
  knowledgeGardening: (vault: string) => invoke<string>("knowledge_gardening", { vault }),
  /** The weekly schedule that writes reviewed knowledge into a project's CLAUDE.md and skills; off until its project is set. */
  knowledgePromotion: (vault: string) => invoke<string>("knowledge_promotion", { vault }),
  newSpec: (vault: string, title: string) => invoke<string>("new_spec", { vault, title }),
  /** Puts a spec's open tasks on its board; returns the board's path and how many cards were added. */
  specToBoard: (vault: string, path: string) => invoke<{ board: string; added: number }>("spec_to_board", { vault, path }),
  noteLinks: (vault: string, path: string) => invoke<NoteLinks>("note_links", { vault, path }),
  /** The note a `[[target]]` names; with `create`, a new note under notes/ when there is none. */
  wikilinkOpen: (vault: string, target: string, create: boolean) => invoke<string | null>("wikilink_open", { vault, target, create }),
  /** Saves (overwrites) `queries/<name>.md`. */
  /** `agent`: the prompt an agent started from the results begins with; `agentEach`: one session per file. */
  saveQuery: (vault: string, name: string, query: string, glob: string, aggregate: boolean, agent?: string, agentEach?: boolean) =>
    invoke<string>("save_query", { vault, name, query, glob, aggregate, agent, agentEach }),
  boardCreate: (vault: string, name: string) => invoke<string>("board_create", { vault, name }),
  boardRead: (vault: string, path: string) => invoke<Board>("board_read", { vault, path }),
  boardAdd: (vault: string, path: string, title: string, list?: string) => invoke<Card>("board_add", { vault, path, title, list }),
  boardUpdate: (vault: string, path: string, id: string,
    change: { list?: string; index?: number; owner?: string; title?: string; done?: boolean; labels?: string[]; note?: string; remove_note?: number }) =>
    invoke<Card>("board_update", { vault, path, id, change }),
  boardRemove: (vault: string, path: string, id: string) => invoke<void>("board_remove", { vault, path, id }),
  /** `op`: add, rename (to `to`), left, right, move (to index `to`) or remove. */
  boardList: (vault: string, path: string, op: string, name: string, to?: string) =>
    invoke<void>("board_list", { vault, path, op, name, to }),
  boardSetQueue: (vault: string, path: string, queue: Queue | null) => invoke<void>("board_set_queue", { vault, path, queue }),
  /** Tells the backend which vault's queues and schedules to run. */
  automationWatch: (vault: string) => invoke<void>("automation_watch", { vault }),
  schedulesList: (vault: string) => invoke<Schedule[]>("schedules_list", { vault }),
  /** `when`: an interval (30m, 2h, 1d) or a daily time (09:00). */
  scheduleCreate: (vault: string, title: string, when: string, prompt: string, project: string, query?: string) =>
    invoke<string>("schedule_create", { vault, title, when, prompt, project, query }),
  /** The session id, or null when the schedule's query found nothing. */
  scheduleRun: (vault: string, path: string) => invoke<string | null>("schedule_run", { vault, path }),
  scheduleSetEnabled: (vault: string, path: string, enabled: boolean) => invoke<void>("schedule_set_enabled", { vault, path, enabled }),
  readConfig: () => invoke<Record<string, unknown>>("read_config"),
  /** Creates ~/.marq/config.toml from a template if missing. */
  configPath: () => invoke<string>("config_path"),
  /** Sets `section.key` values in config.toml, keeping its comments; null removes a key. */
  writeConfig: (changes: Record<string, unknown>) => invoke<void>("write_config", { changes }),
  shells: () => invoke<string[]>("shells"),
  terminalWrite: (id: string, data: string) => invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: string, cols: number, rows: number) => invoke<void>("terminal_resize", { id, cols, rows }),
  terminalClose: (id: string) => invoke<void>("terminal_close", { id }),
  /** `ollama:<name>` for each model the local Ollama has; rejects when Ollama is not running. */
  ollamaModels: () => invoke<string[]>("ollama_models"),
  newCrew: (vault: string, task: { title: string; prompt: string; project: string; autoTitle: boolean; workspace?: string; directories?: DirSpec[] }) =>
    invoke<{ rel: string; title: string }>("new_crew", { vault, ...task }),
  /** An empty owner unassigns the task. */
  crewTaskUpdate: (vault: string, crewId: string, id: string, change: { status?: string; owner?: string }) =>
    invoke<CrewTask>("crew_task_update", { vault, crewId, id, ...change }),
  crewRelease: (vault: string, crewId: string, msgId: string) => invoke<void>("crew_release", { vault, crewId, msgId }),
  sessionOrigin: (vault: string, sessionId: string) =>
    invoke<{ path: string; line: number } | null>("session_origin", { vault, sessionId }),
};

export const INBOX_QUERY = `import "yaml"
| let fm = yaml::yaml_parse(to_text(first(.)))
| if (fm["status"] == "todo"): s"\${fm["title"]}"`;
