# Vault tools for agents

Marq exposes the vault to agents as an MCP server. The tools run in the sidecar and call back into the app. Tools marked "needs approval" show an approval card in the session; the rest are pre-approved.

## Notes

| Tool | Approval | Description |
| --- | --- | --- |
| `search_notes(text)` | no | Full-text line search over the vault (the same search as ⇧⌘F) |
| `query_notes(query, glob)` | no | Run mq over vault files, read only |
| `read_note(id)` | no | Read a note by id |
| `list_notes(folder?)` | no | Folders and notes with title, type and status |
| `write_doc(title, content, folder?, path?)` | no | Save a document for you in the vault (`docs/` by default); `path` revises an earlier `type: doc` note |
| `append_learning(text)` | no | Append to the current session's `## Learnings` |
| `create_folder(path)` | no | Create a folder |
| `move_note(from, to)` | yes | Move or rename a note or folder, rewriting relative links |
| `trash_note(path)` | yes | Move a note or folder to the Trash |

Moving never overwrites, never leaves the vault, and refuses `sessions/` and dot folders. **Always allow** on an approval covers the rest of the session.

## Sessions

| Tool | Approval | Description |
| --- | --- | --- |
| `list_sessions()` | no | Other sessions: id, title, status, working directory, branch |
| `search_sessions(text, project?, since?, limit?)` | no | Past sessions whose note mentions every word (glossary synonyms too, anywhere in the note), best matches first, each with its note path and three best lines. `project` is part of a directory or repository path, `since` a `YYYY-MM-DD` date. Read a hit with `read_note` |
| `read_session(session_id)` | no | Another session's status, first prompt and latest result |
| `send_to_session(session_id, text, reply?)` | yes | Send a message to another session. Messages start with "Message from another Marq session". With `reply` (default true), the answer to it comes back as a new message when that session finishes the turn |

## Follow-ups and progress

| Tool | Approval | Description |
| --- | --- | --- |
| `set_followup(after, note)` | no | Resume this session later: `after` is `5m`, `2h`, `1d` or `1w` (at least five minutes), `note` is what to check and do. Fires once, when the session is idle; five waiting at most |
| `list_followups()` | no | This session's waiting follow-ups, soonest first, with ids |
| `cancel_followup(id)` | no | Cancel a follow-up that has not fired |
| `set_progress(text)` | no | Save progress notes for this session, replacing the earlier ones; given back at every later run. Empty text clears them |

See [Inbox and follow-ups](inbox.md).

## Boards

| Tool | Approval | Description |
| --- | --- | --- |
| `list_boards()` | no | Boards in the vault |
| `read_board(board?)` | no | A board's lists and cards |
| `board_add_card(…)` | no | Add a card to a list |
| `board_update_card(…)` | no | Move a card, change its owner or title, check it, or add a note |
| `board_add_list(…)` | no | Add a list |
| `write_spec(title, content, path?, verify?)` | no | Save a spec in `specs/`, or revise one; see [Workflows](workflows.md#specs) |
| `spec_to_board(spec)` | no | Put a spec's open tasks on its board as cards linked to the spec |

A board is named by its name, title or path, or left out when there is only one.

## Crews

| Tool | Approval | Who | Description |
| --- | --- | --- | --- |
| `start_crew(title, goal)` | yes | outside crews | Hand a large task to a new crew |
| `crew_members()` | no | members | The roster with status, unread mail, directory and branch |
| `crew_send(to?, text, kind?, reply_to?)` | no | members | Message members by role, `all`, or `user`. `kind` is `tell`, `ask` or `reply` |
| `crew_decide(decision)` | no | members | Record a decision in the crew note and tell everyone |
| `crew_add_member(role, instructions, …)` | yes | members | Add a member, with its worktree, permission mode and model |
| `crew_set_model(role?, model)` | no | members | Switch a member (by default the caller) to another model from its next turn |
| `task_list()` | no | members | The shared task list |
| `task_add(title, owner?, note?)` | no | members | Add a task; the owner is told |
| `task_update(id, status?, owner?, note?)` | no | members | Change status or owner, or add a note |

See [Crews and boards](crews-and-boards.md) for how these fit together.
