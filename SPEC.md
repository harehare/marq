# Marq SPEC

Marq is a desktop app for personal knowledge built around Markdown notes. It lets you run Claude from any part of a note, links each run to its session, and lets you query notes with [mq](https://github.com/harehare/mq).

- The Markdown files in the vault are the source of truth. SQLite is only an index and can be rebuilt from the files.
- Session logs are written to Markdown as well, so they become part of the knowledge base.
- mq is embedded as a library (`mq-lang`) for filtering and for evaluating mq code blocks.

## 1. Vault layout

```
<vault>/
├─ daily/YYYY-MM-DD.md
├─ notes/**.md
├─ requests/YYYY-MM-DD-<slug>.md
├─ sessions/YYYY-MM-DD-<short-id>.md     # derived from .raw, regenerable
├─ sessions/.raw/<id>.jsonl              # claude stream-json log (source of truth)
├─ queries/*.mq                          # saved mq queries
└─ .marq/index.db                        # SQLite index (gitignored)
```

Only `sessions/.raw/` and `.marq/` belong to the app. Everything else can be freely edited or moved by the user or other editors.

## 2. IDs

- Every ID is a UUID v7, so IDs sort by time.
- A session ID is passed to `claude --session-id <uuid>`, so the marq session ID and the Claude session ID are the same value.
- Links between files use IDs, not paths, so renames do not break them.

## 3. Frontmatter

### Common

```yaml
---
id: 0192f0c4-...            # required
type: note                  # note | daily | request | session
title: ...                  # optional, defaults to first heading or filename
created: 2026-10-27T10:12:00+09:00
updated: 2026-10-27T11:40:00+09:00
tags: [mq, lsp]
---
```

Files without frontmatter are treated as `type: note`. The app assigns an `id` the first time it links something to the file.

### type: request

```yaml
status: todo                # todo | running | review | done | dropped
project: ~/dev/git/mq       # cwd for claude
sessions: [0192f0c5-...]    # all runs, including retries
context:                    # attached to the prompt at run time
  - note: 0192e...          # whole note by id
  - query: 'import "section" | nodes | section::find("Design") | section::body()'
    from: notes/design.md   # mq query applied to a file (with -A semantics)
```

Status transitions:

```
todo ──run──▶ running ──exit 0──▶ review ──user──▶ done
                 │
                 └──error/interrupt──▶ todo (session keeps status error|interrupted)
any ──user──▶ dropped
```

## 4. Markers in the body

Markers are HTML comments, so they render as nothing in other Markdown viewers. mq sees them as `.html` nodes.

### Anchor (run Claude from part of a note)

```markdown
### ここの設計どうするか
<!-- claude:anchor id="0192f0c6-..." -->
```

- An anchor is placed directly after the heading or list item it belongs to.
- The anchor's scope is the section it belongs to, which is the heading before it up to the next heading at the same or higher level.
- An anchor's linked sessions are found through each session's `origin`, not stored on the marker. Re-running never rewrites the marker.

### Result block (written back by the app)

```markdown
<!-- claude:result session="0192f0c5-..." -->
...summary...
<!-- /claude:result -->
```

- The app only rewrites text between these two markers. Text outside them is never touched.
- A request has a result block under `## Result`. An anchor's result block goes right after the anchor's section body.

## 5. Session file

`sessions/.raw/<id>.jsonl` is the raw `claude -p --output-format stream-json --verbose` output, one JSON object per line. The Markdown file is rendered from it and can be regenerated at any time.

```markdown
---
id: 0192f0c5-...
type: session
title: mq LSP hover に型表示
origin: 0192f0c4-...         # request id or anchor id
origin_path: requests/2026-10-27-hover.md   # hint only, id is authoritative
cwd: ~/dev/git/mq
model: claude-opus-5-5
status: done                  # running | done | error | interrupted
started: 2026-10-27T10:15:00+09:00
ended: 2026-10-27T10:42:00+09:00
cost_usd: 0.84
files_changed: [crates/mq-lsp/src/hover.rs]
---
## Summary

## Learnings
- ...

## Transcript

### 👤 User
...

### 🤖 Claude
...

```tool:Read
crates/mq-lsp/src/hover.rs
```

<details><summary>result</summary>

...

</details>
```

Rules:
- `## Summary` and `## Learnings` are filled in by a final summarizing turn when the session ends. They can be edited by hand and are kept when the Transcript is regenerated.
- Each tool use is a fenced code block with info string `tool:<ToolName>`. Its body is the main argument (path, command, pattern). Tool results longer than 20 lines go inside `<details>`.
- Thinking blocks are not rendered.

## 6. mq code blocks

````markdown
```mq input=./daily/*.md
import "section" | nodes | section::find("Done") | section::body()
```
````

- With aggregate (`-A`, the default) the query runs on `nodes | <query>`; a query that already starts with `nodes` (after any `import "…" |`) is not wrapped again. The `section` module needs `import "section"`.
- The code block's `meta` holds space-separated `key=value` pairs.
  - `input`: glob relative to the note. When omitted, the input is the note itself.
  - `aggregate`: `true` by default (same as `mq -A`), because most queries need the whole document.
- **Pin** writes the current output after the block between `<!-- mq:output -->` and `<!-- /mq:output -->`, replacing an earlier pin. The preview hides the pinned copy and shows live output. Pinned output is a cache of results, not content, so every mq evaluation (blocks, the query view, `query_notes`, `context:`) leaves it out of its input.
- In the preview, blocks are evaluated automatically (debounced 300ms) when the note changes, and results are shown under the block as rendered Markdown, with a raw toggle. They are not saved by default. Running "pin output" writes them to the file as
  `<!-- mq:output -->` ... `<!-- /mq:output -->` right after the block.
- Evaluation is sandboxed: file reads are allowed only inside the vault, and network, write, run, and env access are denied.

## 7. Built-in queries (verified against mq 0.9.3)

The inbox. It lists requests whose status is todo.

```sh
mq -A 'import "yaml"
  | let fm = yaml::yaml_parse(to_text(first(.)))
  | if (fm["status"] == "todo"): s"${fm["title"]}\t${__FILE__}"' requests/*.md
```

Learnings across sessions:

```sh
mq -A 'section::find("Learnings") | section::body()' sessions/*.md
```

Commands Claude ran:

```sh
mq 'select(.code.lang == "tool:Bash") | .code.value' sessions/*.md
```

Anchors in a note. The node position gives the jump target.

```sh
mq 'select(.html) | to_text() | capture("claude:anchor id=\"(?<id>[^\"]+)\"")' note.md
```

Notes on mq behavior:
- `yaml::yaml_parse(node)` on a `.yaml` node returns an array, because the `---` delimiters make it multi-document. Use `to_text()` first to get a dict.
- `select(...)` without `-A` yields `None` for non-matching nodes instead of dropping them. Inside the app, queries run on the node array and drop `None`.
- Nodes carry `position` (line/column), which the editor uses to jump to a result's source.

## 8. Claude runner

Sessions run with the Claude Agent SDK in a Node sidecar (`sidecar/main.ts`). One sidecar process serves every session and talks to the app with JSON lines over stdio.

- `query()` gets an input queue as its prompt, so a session's process stays alive between turns. Follow-ups sent during a turn are queued, and Stop interrupts the current turn (`q.interrupt()`). An idle process is closed after 10 minutes and resumed on the next message.
- marq's session id is the Claude session id: the first turn passes `sessionId`, later processes pass `resume`.
- `pathToClaudeCodeExecutable` is the user's own `claude` (resolved through the login shell), so the session uses their Claude Code login and settings. `settingSources` is user, project and local.
- The permission mode comes from the note's `permission_mode` (`auto` when empty). Anything that would prompt goes to `canUseTool`, which shows an approval card in the session (§13).
- The model comes from the note's `model`: empty for Claude Code's default, a Claude alias or name (`opus`, `sonnet`, `haiku`), or `ollama:<name>` for a model served by Ollama. An Ollama session runs Claude Code against Ollama's Anthropic-compatible API (`ANTHROPIC_BASE_URL` from `OLLAMA_HOST`, default `127.0.0.1:11434`), with every model alias and subagents mapped to that model. The model is stored in `marq_meta` and used again on resume and summary. The new-task dialog lists the models Ollama has pulled (`/api/tags`). Crews always use Claude.
- Each SDK message is appended to `.raw/<id>.jsonl` and emitted as `claude://event`. At each `result`, the session Markdown is re-rendered and the result is written back to the origin note. A request moves to `review`.
- marq adds its own lines to the raw log: `marq_meta` (first line), `marq_user` (each prompt), `marq_approval` (each answer) and `marq_exit` (process end). A turn is running from a `marq_user` until the next `result`.
- **Ask Claude** (a heading's button, ⌘↵ in the editor, or a selection in the preview) opens the Ask dialog: an intent — Do it, Review, Plan (plan mode) or Explain, the last three without file changes — and an optional instruction, added to the prompt; ↵ starts. A selection is sent instead of the whole section, with its line numbers, and the anchor goes on its section. ⌥ opens the dialog with project, worktree and model, which override the note's frontmatter for that run only.
- The prompt is the request body up to `## Result` plus its `context:` entries as `<context source="...">` blocks, or for an anchor the section text wrapped in `<note path="...">`.
- **Summarize** forks the conversation (`forkSession`, no tools, one turn) and writes `## Summary` and `## Learnings` into the session file. The session itself is not changed.

## 9. MCP server

marq exposes the vault to Claude as an MCP server.

| tool | description |
|---|---|
| `search_notes(text)` | full-text search over the index |
| `query_notes(query, glob)` | run mq over vault files (read only) |
| `read_note(id)` | read a note by id |
| `write_doc(title, content, folder?, path?)` | save a document for the user in the vault (§14) |
| `append_learning(text)` | append to the current session's `## Learnings` |
| `list_notes(folder?)` | folders and notes with title, type and status |
| `create_folder(path)` | create a folder (§20) |
| `move_note(from, to)` | move or rename a note or folder, rewriting links (needs approval, §20) |
| `trash_note(path)` | move a note or folder to the Trash (needs approval) |
| `list_sessions()` | other sessions: id, title, status, working directory, branch |
| `read_session(session_id)` | another session's status, first prompt and latest result |
| `send_to_session(session_id, text)` | send a message to another session (needs approval, §18) |
| `crew_members()` | crew members only: the roster with status and directories (§21) |
| `crew_send(to?, text, kind?, reply_to?)` | crew members only: message members by role, all, or the user (§21) |
| `crew_decide(decision)` | crew members only: record a decision in the crew note (§21) |
| `crew_add_member(role, instructions, …)` | crew members only: add a member (needs approval, §21) |
| `start_crew(title, goal)` | outside crews: hand a large task to a new crew (needs approval, §21) |
| `task_list()`, `task_add(…)`, `task_update(…)` | crew members only: the shared task list (§21) |

The tools are an in-process SDK MCP server in the sidecar that calls back into the app, and they are pre-approved. `search_notes` is a line search over the vault; there is no index yet.

## 10. SQLite index

```sql
documents(id TEXT PRIMARY KEY, path TEXT, type TEXT, title TEXT, status TEXT, updated TEXT)
anchors(id TEXT PRIMARY KEY, document_id TEXT, line INTEGER)
sessions(id TEXT PRIMARY KEY, origin TEXT, status TEXT, started TEXT, ended TEXT, cost_usd REAL)
documents_fts(path, title, body)            -- FTS5
ui_state(key TEXT PRIMARY KEY, value TEXT)  -- tabs and layout
```

The index is rebuilt by scanning the vault at startup and is kept up to date by the file watcher. Not implemented yet: the MVP scans files directly.

## 12. Worktrees and review

- When a note's `project` is inside a git repository, each session gets a worktree at `~/.marq/worktrees/<repo>/<short id>` on a new branch `marq/<short id>`, created from the repo's HEAD. The session's cwd is the worktree. `worktree: false` in the note turns this off.
- The branch is `marq/<short id>`, or `branch:` from the note when set (checked with `git check-ref-format`). `-2`, `-3`… keep it unique.
- The branch can be renamed later from the Changes panel (`git branch -m`). The new name is written back into `marq_meta`. Commits and anything already pushed under the old name stay as they are.
- Claude or the user may rename or switch the branch with git. Every git action reads the branch checked out in the worktree (detached HEAD is an error), and a change is recorded as a `marq_worktree` line; the latest one overrides `marq_meta`. The log is only ever appended to.
- The worktree (repo, path, branch, base commit, base branch) is stored in `marq_meta`, and `branch:` is shown in the session file.
- Changes are diffed against the base commit, so they include commits made in the worktree, uncommitted edits and untracked files.
- `carry_changes: true` in the note (or the New task option) copies the repo's uncommitted diff and untracked files into the new worktree.
- Review actions: commit everything; push the branch (`git push -u origin <branch>`), with the number of unpushed commits shown; push and `gh pr create` against the base branch (the message's first line is the PR title and the rest its body, followed by a "Created from Marq session" line), open the worktree in Finder, Terminal or VS Code, and remove the worktree. Removing keeps the branch.
- Review comments: + on a diff line (shift-click to extend to a range) adds a comment, kept per session until sent. **Send review** sends all of them to the session as one message (file, lines, the diff lines and the comment); **Edit first** puts that message in the message box instead. A file's diff, or the whole diff, can be put into the message box too (cut at 600 lines per file).
- The New task dialog saves the task as a request note in `requests/` first, then runs it, so every task stays in the vault.
- When the title is left empty, a small model (`haiku`, one turn, no tools, not saved as a session) names the task from its prompt, in the prompt's language. If that fails or takes over 15 seconds, the first line of the prompt is the title. This applies to Team tasks too.

## 13. Approvals

- `canUseTool` sends each request to the app, which shows a card in the session with the tool, its input, and Allow, Always allow and Deny. Deny can carry a note that Claude receives as the reason.
- Always allow covers that tool name for the rest of the process.
- A session waiting for an answer shows as `waiting` and is listed under **Needs you** in the sidebar.
- Stopping a session, or the sidecar exiting, denies its pending requests.

## 17. Shell environment

Apps started from Finder get a minimal PATH. The PATH of an interactive login shell (`$SHELL -ilc`) is read once and used to find `git`, `gh`, `node` and `claude`, and is passed to the sidecar, so Claude's Bash tool sees the same commands as a terminal.

## 19. Review state

- **Needs review** lists sessions that are not running, have changes against their base, and have no review state.
- **Mark as done** (sidebar menu or session header) records `marq_review` with state `done` and moves a `running` or `review` request to `done`. **Reopen** records `open` and moves a `done` request back to `review`.
- A successful **Create PR** records state `pr` with the PR URL; the sidebar shows a PR badge and the menu can open the PR.

## 20. Folders and moving notes

- The sidebar shows every folder, including empty ones. Folders can be created from the Notes header or a folder's menu; notes and folders can be renamed or moved from their menu or by dragging them onto a folder (or the empty area below the tree for the top level).
- Moving never overwrites, never leaves the vault, and refuses `sessions/` and dot folders, which Marq manages.
- Marq's own links use ids and survive moves. Relative Markdown links (`[x](../a.md)`, `[x](<a b.md>)`, with `#part`) in moved notes and in notes pointing at them are rewritten. Open tabs follow moved notes.
- Claude can organize the vault with `list_notes` and `create_folder` (pre-approved), `move_note` (needs approval; Always allow covers the rest of a session) and `trash_note` (needs approval).

## 15. Inbox and resuming

- The Inbox lists only requests with `status: todo`. A started request is followed through its sessions, and its status can be set from the right-click menu.
- Session logs from before the renames use `kura_*` or `comb_*` line types; they are read as `marq_*`.
- A session that is `interrupted` or `error` can be resumed. If Claude started its conversation (the log has `system/init` or an assistant message), the conversation is resumed with a note that the run was interrupted. Otherwise it starts again with the first prompt and the same id.

## 16. Slash commands and skills

- Typing `/` at the start of a line in the composer or the New task prompt completes skills and slash commands.
- The list is the SDK's `supportedCommands()`: from the running session's query when there is one, otherwise from a query opened only to initialize in that directory (no prompt, no model call) and closed. The app caches it per directory.
- Custom entries (skills, user and project commands, plugins) are listed before Claude Code's built-ins. The chosen command is sent as text, and Claude Code expands it.

## 18. Sending text between notes and sessions

- Selecting text in the preview or in a session's messages shows **Send to session**. In the editor, the toolbar button or ⌘⇧↵ sends the selection.
- The dialog lists sessions (waiting and running first), takes an optional instruction, and sends `instruction` followed by `<excerpt source="<note path or session title>" lines="a-b">…</excerpt>`. A stopped session is resumed. **New task with this** opens the New task dialog with the same text.
- Sessions can work together through the vault MCP server: `list_sessions` and `read_session` (pre-approved) and `send_to_session`, which always asks for approval because it makes another session do work. Sent messages start with "Message from another Marq session".

## 21. Crews

A crew is several sessions working on one project together. Each member has a role, and members message each other by role, like actors with mailboxes. The crew opens in one tab that shows the message timeline, the members, and any member's session beside them.

### Crew note

A crew is a note with `type: crew` in `crews/`. There are three ways to start one:

- **New task** with **Team**: the prompt becomes the Goal, the project is the task's, and the crew is kicked off at once.
- From a session: an ordinary session has the `start_crew(title, goal)` tool, and the system prompt suggests it for large tasks that need several kinds of work in parallel. It needs approval. The crew works on the session's repository (not its worktree), the session shows a card for it (`marq_crew` line), and the crew tab opens.
- **New crew** in the sidebar writes the template for the user to fill in, then **Kick off**.

A new crew has only a `lead`. Its instructions tell it to design the team first (`crew_add_member`), hold a kickoff discussion with everyone, record the plan (`crew_decide`) and then run the work. Listing more members in the note skips the first step.

```yaml
---
id: 0192f0c7-...
type: crew
title: mq LSP 改善
project: ~/dev/git/mq       # where members work
max_hops: 20                # see Hops below
members:
  - role: lead
    worktree: false         # work in the project directory, not an own worktree
  - role: impl
    permission_mode: acceptEdits
  - role: reviewer
    worktree: false
---
# mq LSP 改善

## Goal

...

## Roles

### lead
...
### impl
...
```

- `members` lists roles in order. The first one is the one **Kick off** sends the Goal to. `user` and `all` are reserved.
- `### <role>` under `## Roles` is that member's instructions. They go into the member's system prompt with the Goal and the roster.
- A member with `worktree` true (the default) gets its own worktree on `marq/<role>-<short id>` when the project is a git repository (§12). Members read the other members' directories (`additionalDirectories`).
- The note is read when a message is sent or a member starts, so edits apply from then on.

### Members and mail

- A member is an ordinary session (`marq_meta` has `crew: {id, role}`, `origin` is the crew id). It is created when the first message reaches its role, and is listed and reviewed like any session. Its results are not written back into the crew note.
- Members get these vault tools:

| tool | approval | |
|---|---|---|
| `crew_members()` | no | roles, status, unread mail, directory and branch |
| `crew_send(to?, text, kind?, reply_to?)` | no | `to` is a role, `user`, `all` (every other member) or roles separated by commas. `kind` is `tell`, `ask` or `reply`; `reply_to` is the id of the message being answered |
| `crew_decide(decision)` | no | appends `- <date> (<role>): <decision>` to `## Decisions` in the crew note and sends it to all with kind `decision` |
| `crew_add_member(role, instructions, worktree?, permission_mode?)` | yes | adds an entry to `members:` and a `### <role>` section under `## Roles` |
| `task_list()` | no | the shared task list |
| `task_add(title, owner?, note?)` | no | adds a task (`T<n>`); the owner is told |
| `task_update(id, status?, owner?, note?)` | no | changes status, owner or adds a note; the new owner is told |

- **Discussions.** A message to several members starts a thread. A reply with `reply_to` and no `to` goes to everyone in the thread: the senders and recipients up its reply chain. Members are told to speak once per round and only with something new, and whoever started it (usually the lead) closes it with `crew_decide`. Decisions are part of the crew note, so later sessions and the user can read them.
- Messages go to `sessions/.crews/<crew id>.jsonl`, not straight into the session. A message is delivered only between turns: if the member is in a turn, it waits, and when the turn ends everything waiting arrives as one turn of `<crew-message id from kind reply_to>` blocks. A member never waits for an answer inside a turn; replies come as new messages.
- The user writes to a member from the crew view's composer. Members write to the user with `to: "user"`; those messages are shown in the timeline.

### Tasks and documents

- The crew's folder is `crews/<name>/`, next to `crews/<name>.md`. It holds the task list and the members' documents.
- The task list is `crews/<name>/tasks.md` (`type: crew-tasks`, `crew: <crew id>`, so it is found again after a move). Each status is a section, and each task a checklist item; notes are nested items:

  ```markdown
  ## Doing

  - [ ] **T1** Show types on hover — @impl
    - impl: branch marq/impl-1a2b3c
  ```

  Sections are Todo, Doing, Review, Blocked and Done, in that order. Moving an item to another section by hand changes its status. Each change reads the file, applies one edit and writes the whole list back, one change at a time across the crew.
- Members take a task by setting it to `doing`, which makes them its owner. If another member is already doing it, that fails, so members working in parallel never pick the same task. Assigning a task to someone else sends them a message. Status and owner changes appear in the timeline.
- `write_doc` from a member saves to the crew's folder unless it names another, with `origin: <crew id>`. A new document is linked from `## Documents` in the crew note (relative link) and noted in the timeline.

Log lines:

| line | meaning |
|---|---|
| `crew_msg {id, from, to, kind, text, reply_to?, hop, held?, at}` | a message |
| `crew_member {role, session, at}` | a role got a session; the latest one wins |
| `crew_deliver {to, session, msgs, hop, at}` | messages handed to a session as one turn |
| `crew_release {msg, at}` | the user let a held message through |
| `crew_event {text, at}` | something else for the timeline, e.g. a member was added |

`to` in `crew_msg` is a string for one recipient and a list for several; `crew_deliver` is per recipient.

### Hops

Every message from the user has hop 0. A message a member sends has the hop of the last batch it received plus one. A message to a member with a hop over `max_hops` (default 20) is **held**: it is logged but not delivered, and the timeline shows it with **Let it through**. Releasing it delivers it with hop 0. This keeps members from messaging each other forever without the user.

### Crew view

- Left: members with status, unread mail and branch. Click one to show its session on the right (the full session view, with approvals); double-click to open it in its own tab.
- Center: the timeline of every message, colored by sender, with `ask`/`reply` badges, the message being replied to, `queued` until delivered, and held messages. The composer sends to the chosen member.
- Header: project, **Kick off** (before the first message) and **Edit crew note**. A banner names members waiting for an approval.
- The composer can send to one member or to all.
- In the sidebar, crew members are listed only under their crew in **Crews** (expand a crew to see them; its dot shows the most urgent member), not under Running or Recent. A member waiting for an approval is also listed under **Needs you**.
- **Tasks** shows the task list by status; the user can add tasks and change status or owner. **Docs** lists the crew's documents (`type: doc` with `origin` set to the crew).

Not yet: a budget limit, routing rules (e.g. every impl result goes to reviewer), restarting failed members, and rendering the timeline as Markdown.

## 14. Documents from Claude

Documents Claude writes for the user are collected in the vault, not left in the working directory or worktree.

- The system prompt tells Claude to save reports, plans, designs, investigations, summaries, how-tos and meeting notes with `write_doc`, and to put documents in the repository only when asked or when they are part of the code.
- A new document goes to `docs/<date>-<slug>.md` (or the given `folder`) with `type: doc`, `sessions: [<session id>]` and `origin: <request or anchor id>`.
- Passing `path` revises a document. Only `type: doc` notes can be revised this way, so hand-written notes are never overwritten. Each revising session is added to `sessions`.
- Each save is logged as a `marq_doc` line. The session view shows it as a card that opens the document, and the session file links it and lists it in `docs:`.

## 11. Milestones

1. Open a vault, file tree, Markdown editor, tabs
2. Run claude from a request or anchor, saving `.raw` JSONL and the session Markdown
3. Two-way jumps between anchors and sessions, plus result write-back
4. mq inbox, query view, and mq code block evaluation
5. Parallel sessions in git worktrees with a review panel (done)
6. Agent SDK sidecar with approvals (§13) and vault tools (§9) (done)
7. SQLite full-text index, bundling the sidecar for release builds

## 22. Settings and keys

- Settings live in `~/.marq/config.toml`, created from a template by **Settings** (⌘,), which opens it in `$EDITOR` in a terminal tab. Keys reload when the window regains focus; `[ollama] url` (sets `OLLAMA_HOST` for the sidecar) after a restart.
- `[appearance]` sets fonts and sizes (and the theme until one is picked in the 🎨 menu), `[editor] default_mode` how notes open (preview unless set; new notes open in edit), `[terminal]` the shell, its args, font size and cursor.
- A session without a worktree that is marked done offers **Push**: `git push -u origin <branch>` for the branch checked out in its project.
- Keys follow zellij: **normal** mode has direct shortcuts; **Tab** (⌃T) and **Pane** (⌃P) modes take single keys until Esc/↵; **Lock** (⌃G) passes every key to the focused view. A status bar shows the mode and its keys. Bound keys are taken before the editor and terminal see them.
- `[keys]` binds normal-mode commands, `[keys.tab]`, `[keys.pane]` and `[keys.locked]` the modes: `"command.id" = "Cmd+Shift+T"` or a list; `""` unbinds. ⌘K lists every command with its keys.
- With the tree focused (⇧⌘E, or ⌃P then H): J/K move, L/↵ open, H closes a folder or goes to its parent, Esc returns to the content.
- Terminal tabs take their title from the shell until renamed (⇧⌘R, ⌃T then R, or double-click).

## 23. Boards

- A board is a Markdown note, `boards/<name>.md` with `type: board`. Each `## ` heading is a list, each checklist item a card (`- [ ] **T1** Title — @owner`, notes as nested items). New boards start with Todo, Doing and Done.
- Editing the Markdown is editing the board: moving an item under another heading moves the card; items written without `**T<n>**` get an id on the next save. Moving a card into a list named Done checks it.
- The board tab shows the lists as columns (Board) or stacked (List). Cards are dragged between and within lists; lists can be added, renamed, moved and removed when empty. A card can start a session whose prompt names the card. Clicking a board in the tree or the Boards section opens the board; **Markdown** opens the note.
- Sessions read and change boards through pre-approved tools: `list_boards`, `read_board`, `board_add_card`, `board_update_card` (move, owner, title, done, note) and `board_add_list`. A board is named by its name, title or path, or left out when there is only one.

## 24. Finding notes

- **⌘P** opens a note, board or crew by fuzzy title or path; with an empty query it lists recently opened ones first. ⇧↵ searches the text instead. The sidebar's Search button opens it too.
- **⇧⌘F** opens the Search tab: lines that contain every word (case-insensitive), grouped by note, searched as you type. `sessions/` is left out unless asked for. A result opens the note at that line. `search_notes` for Claude uses the same search.

## 25. Browser tabs

- A browser tab (⇧⌘B) shows a page in an iframe: an address bar (a URL, `localhost:5173`, or a file path, shown through the asset protocol), back and forward over the pages opened in the tab, reload, phone width (390px) and open in the default browser. Public sites that refuse framing (`X-Frame-Options`, CSP `frame-ancestors`, checked by the sidecar) get a link to open them outside instead of a blank frame.
- Sessions call `open_preview(url, title?)` (pre-approved) to show the user a dev server or an HTML file they wrote. Each session has one preview tab, reloaded on every call.
