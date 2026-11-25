// marq's MCP tools: the vault, boards and sessions. The tools call back into the app, which owns the vault.
// Built with the Agent SDK's in-process MCP server; mcp-http.ts serves the same server over HTTP to agents in other processes.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { rpc } from "./protocol.ts";

const text = (t: unknown) => ({ content: [{ type: "text" as const, text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });

/** Kanban boards in the vault. `board` is a name, title or path; empty for the only board. */
function boardTools(sessionId: string) {
  const board = z.string().optional().describe("Board name, title or path; omit when there is only one");
  const cardFilter = {
    labels: z.array(z.string()).optional().describe("Cards that have all of these labels (case-insensitive, # optional)"),
    owner: z.string().optional().describe("Cards owned by this person (@ optional)"),
    done: z.boolean().optional().describe("true: only done cards; false: only open ones"),
  };
  return [
    tool("list_boards", "List the user's kanban boards (task management) with their lists and card counts.",
      {}, async () => text(await rpc("list_boards", { session: sessionId }))),
    tool("read_board",
      "Read a kanban board: its lists in order, each with cards (id, title, done, owner, labels, notes). " +
        "Pass `labels`, `owner` or `done` to keep only the matching cards (all lists are still shown).",
      { board, ...cardFilter }, async (a) => text(await rpc("read_board", { ...a, session: sessionId }))),
    tool("search_cards",
      "Find cards across all kanban boards by label (tag), owner or done. Every given filter must match; " +
        "each hit has its board and list. With no filter it returns every card.",
      cardFilter, async (a) => text(await rpc("search_cards", { ...a, session: sessionId }))),
    tool("board_add_card", "Add a card (task) to a board, in `list` (default: the first list). #words at the end of the title become labels.",
      { board, title: z.string(), list: z.string().optional(), owner: z.string().optional(), note: z.string().optional() },
      async (a) => text(await rpc("board_add_card", { ...a, session: sessionId }))),
    tool("board_update_card",
      "Update a card: move it to another `list` (e.g. Doing, Done), set owner, title, done or labels (replaces them; without #), or append a note.",
      { board, id: z.string(), list: z.string().optional(), owner: z.string().optional(), title: z.string().optional(),
        done: z.boolean().optional(), labels: z.array(z.string()).optional(), note: z.string().optional() },
      async (a) => text(await rpc("board_update_card", { ...a, session: sessionId }))),
    tool("create_board",
      "Create a kanban board as boards/<name>.md. `lists` are its columns in order (default: Todo, Doing, Done). " +
        "Check list_boards first so you do not make a second board for the same thing.",
      { name: z.string().describe("File name under boards/, e.g. \"release-1.2\"; it is also the title"),
        lists: z.array(z.string()).optional() },
      async (a) => text(await rpc("create_board", { ...a, session: sessionId }))),
    tool("write_spec",
      "Save a spec in the vault (specs/): what to build, before anyone builds it. content is Markdown without frontmatter, with the " +
        "sections ## Requirements (testable statements), ## Design, ## Tasks (a checklist, one item per piece of work one session can do) " +
        "and ## Acceptance (how to tell it is done; the agents doing the tasks are not shown it, a separate session checks their work). " +
        "verify is a shell command that checks each task's work, e.g. \"pnpm test\". To revise a spec, pass its path.",
      { title: z.string(), content: z.string(), path: z.string().optional(), verify: z.string().optional() },
      async (a) => text(await rpc("write_spec", { ...a, session: sessionId }))),
    tool("spec_to_board",
      "Put a spec's open ## Tasks on its board as cards linked to the spec (a new board the first time). Cards already there are skipped. " +
        "A board queue then runs each card with the spec as context and its verify command and acceptance check.",
      { spec: z.string().describe("The spec: path, id or title") },
      async (a) => text(await rpc("spec_to_board", { ...a, session: sessionId }))),
    tool("board_add_list", "Add a list (column) to the end of a board.",
      { board, name: z.string() }, async (a) => text(await rpc("board_add_list", { ...a, session: sessionId }))),
  ];
}

export function vaultServer(sessionId: string) {
  return createSdkMcpServer({
    name: "marq",
    version: "0.1.0",
    tools: [
      ...boardTools(sessionId),
      tool("search_notes", "Search the user's notes (Markdown knowledge base) by text. Words also match their synonyms and narrower terms from the vault's glossary and notes' aliases; tag:<name> (or #name) keeps notes with that tag; type:<request|doc|note|session|…>, status:<todo|review|done|…>, project:<part of its path>, workspace:<name> and since:/before:<YYYY-MM-DD or 7d> narrow by frontmatter, and work without any words to list notes. Returns matching paths and lines.",
        { text: z.string() }, async (a) => text(await rpc("search_notes", { ...a, session: sessionId }))),
      tool("query_notes", "Run an mq query (jq-like language for Markdown) over notes matching a glob relative to the vault, e.g. glob 'sessions/*.md' and query 'section::find(\"Learnings\") | section::body()'. aggregate defaults to true (mq -A).",
        { query: z.string(), glob: z.string(), aggregate: z.boolean().optional() }, async (a) => text(await rpc("query_notes", { ...a, session: sessionId }))),
      tool("read_note", "Read a note by its id (frontmatter id), vault-relative path, or what a [[wikilink]] names (title, file name or alias).",
        { note: z.string() }, async (a) => text(await rpc("read_note", { ...a, session: sessionId }))),
      tool("list_learnings", "Learnings recorded in sessions that no knowledge note has taken in yet, newest first, with each session's id, title, note path and project. project narrows it to sessions that worked on that directory; all includes the ones already merged.",
        { project: z.string().optional(), all: z.boolean().optional() }, async (a) => text(await rpc("list_learnings", { ...a, session: sessionId }))),
      tool("write_knowledge", "Create or replace the knowledge note for a topic (knowledge/<topic>.md): the whole note as Markdown without frontmatter. sources: the session ids it draws on (added to the note's earlier ones, and no longer offered by list_learnings). The note is listed as a draft until the user reviews it. project: the directory it applies to, or leave it out for the whole vault.",
        { topic: z.string(), content: z.string(), sources: z.array(z.string()), tags: z.array(z.string()).optional(), project: z.string().optional() },
        async (a) => text(await rpc("write_knowledge", { ...a, session: sessionId }))),
      tool("list_comments", "Comments the user left in their notes, written as <!-- comment: ... --> under the text they are about. Each has path, line, text, sent (an agent was already asked), mention (it mentions @marq) and about (the text it is under). status: open (not sent yet, the default), sent or all. mention: only comments that mention @marq. note limits it to one note (as for read_note). To act on one, read the note, do what it says, and leave the comment line as it is.",
        { note: z.string().optional(), status: z.enum(["open", "sent", "all"]).optional(), mention: z.boolean().optional() },
        async (a) => text(await rpc("list_comments", { ...a, session: sessionId }))),
      tool("note_links", "What links to a note (links_here), where it is mentioned without a link (mentions), what it links to, and the [[links]] in it that name no note yet. note is as for read_note.",
        { note: z.string() }, async (a) => text(await rpc("note_links", { ...a, session: sessionId }))),
      tool("write_doc",
        "Save a document for the user (report, plan, design, investigation, summary, how-to, meeting notes) in their vault. " +
          "Use this instead of writing such documents into the working directory. content is Markdown without frontmatter. " +
          "folder defaults to 'docs'. To revise a document saved earlier, pass its path; only documents written this way can be updated. " +
          "tags: a few topic tags, using the glossary's terms where it has them.",
        { title: z.string(), content: z.string(), folder: z.string().optional(), path: z.string().optional(), tags: z.array(z.string()).optional() },
        async (a) => text(await rpc("write_doc", { ...a, session: sessionId }))),
      tool("set_progress",
        "Save short progress notes for this session, replacing the earlier ones: what is done, what is left, where you stopped and what to do next. " +
          "They are given back to you at the start of every later run of this session, even after the conversation is compacted. " +
          "Keep only what you could not look up again (decisions, ids, partial results), not copies of files or notes. Empty text clears them.",
        { text: z.string() }, async (a) => text(await rpc("set_progress", { ...a, session: sessionId }))),
      tool("set_followup",
        "Ask to be resumed later in this session, e.g. to check a CI run or see whether someone replied. after is how long to wait: 5m, 2h, 1d or 1w (at least five minutes). " +
          "note is what you will be told when it fires, so write what to check and what to do next. It fires once, and only when you are idle. Then end your turn instead of waiting.",
        { after: z.string(), note: z.string() }, async (a) => text(await rpc("set_followup", { ...a, session: sessionId }))),
      tool("list_followups", "The follow-ups this session has waiting, soonest first, with their ids.",
        {}, async () => text(await rpc("list_followups", { session: sessionId }))),
      tool("cancel_followup", "Cancel a follow-up of this session that has not fired yet.",
        { id: z.string() }, async (a) => text(await rpc("cancel_followup", { ...a, session: sessionId }))),
      tool("append_learning", "Record a reusable learning (a gotcha, decision or fact worth remembering) in this session's notes.",
        { text: z.string() }, async (a) => text(await rpc("append_learning", { ...a, session: sessionId }))),
      tool("list_notes", "List folders and notes in the user's vault (path, title, type, status). folder narrows it to one folder.",
        { folder: z.string().optional() }, async (a) => text(await rpc("list_notes", { ...a, session: sessionId }))),
      tool("create_folder", "Create a folder in the vault (parents too). path is relative to the vault.",
        { path: z.string() }, async (a) => text(await rpc("create_folder", { ...a, session: sessionId }))),
      tool("move_note",
        "Move or rename a note or folder in the vault. to may be a folder to move into (or end with /). " +
          "Relative links in and to moved notes are rewritten. Existing files are never overwritten. The user approves moves.",
        { from: z.string(), to: z.string() }, async (a) => text(await rpc("move_note", { ...a, session: sessionId }))),
      tool("trash_note", "Move a note or folder in the vault to the Trash. The user approves each one.",
        { path: z.string() }, async (a) => text(await rpc("trash_note", { ...a, session: sessionId }))),
      tool("list_sessions", "List the user's other sessions in Marq (id, title, status, working directory), most recent first.",
        {}, async () => text(await rpc("list_sessions", { session: sessionId }))),
      tool("search_sessions", "Search past sessions by text (words also match their glossary synonyms): sessions whose log mentions every word, best matches first, each with its note path and best lines. project narrows it to a directory or repository (part of its path), since to sessions started on or after a YYYY-MM-DD date. status:, project:, workspace:, since: and before: can also be written in text, with or without words. Read a hit with read_note on its note path.",
        { text: z.string(), project: z.string().optional(), since: z.string().optional(), limit: z.number().optional() },
        async (a) => text(await rpc("search_sessions", { ...a, session: sessionId }))),
      tool("read_session", "Read another session's latest result and status, to coordinate with it or reuse its findings.",
        { session_id: z.string() }, async (a) => text(await rpc("read_session", { ...a, session: sessionId }))),
      tool("send_to_session",
        "Send a message to another session, e.g. to ask it a question, hand over findings or ask it to do part of the work. " +
          "It runs after that session's current turn, and resumes it if it has stopped. With reply (default true), its " +
          "answer comes back to you as a new message when it finishes that turn; do not wait or poll for it. The user approves each send.",
        { session_id: z.string(), text: z.string(), reply: z.boolean().optional() },
        async (a) => text(await rpc("send_to_session", { ...a, session: sessionId }))),
    ],
  });
}

// Pre-approved: they only read the vault and sessions, or write Marq's own files in the vault.
// send_to_session is left out so each send goes through the approval card.
// move_note and trash_note change the user's notes, so they ask too.
export const VAULT_TOOLS = ["search_notes", "query_notes", "read_note", "list_comments", "note_links", "list_learnings", "write_knowledge", "write_doc", "append_learning", "set_progress", "set_followup", "list_followups", "cancel_followup", "list_sessions", "search_sessions", "read_session",
  "list_notes", "create_folder",
  "list_boards", "read_board", "search_cards", "board_add_card", "board_update_card", "board_add_list", "create_board", "write_spec", "spec_to_board"]
  .map((t) => `mcp__marq__${t}`);
