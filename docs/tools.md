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
| `read_session(session_id)` | no | Another session's status, first prompt and latest result |
| `send_to_session(session_id, text)` | yes | Send a message to another session. Messages start with "Message from another Marq session" |
| `open_preview(url, title?)` | no | Show a dev server or an HTML file in a browser tab; each session has one preview tab, reloaded on every call |

## Boards

| Tool | Approval | Description |
| --- | --- | --- |
| `list_boards()` | no | Boards in the vault |
| `read_board(board?)` | no | A board's lists and cards |
| `board_add_card(…)` | no | Add a card to a list |
| `board_update_card(…)` | no | Move a card, change its owner or title, check it, or add a note |
| `board_add_list(…)` | no | Add a list |

A board is named by its name, title or path, or left out when there is only one.

## Crews

| Tool | Approval | Who | Description |
| --- | --- | --- | --- |
| `start_crew(title, goal)` | yes | outside crews | Hand a large task to a new crew |
| `crew_members()` | no | members | The roster with status, unread mail, directory and branch |
| `crew_send(to?, text, kind?, reply_to?)` | no | members | Message members by role, `all`, or `user`. `kind` is `tell`, `ask` or `reply` |
| `crew_decide(decision)` | no | members | Record a decision in the crew note and tell everyone |
| `crew_add_member(role, instructions, …)` | yes | members | Add a member |
| `task_list()` | no | members | The shared task list |
| `task_add(title, owner?, note?)` | no | members | Add a task; the owner is told |
| `task_update(id, status?, owner?, note?)` | no | members | Change status or owner, or add a note |

See [Crews and boards](crews-and-boards.md) for how these fit together.
