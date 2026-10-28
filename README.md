# Marq

<img src="assets/logo.svg" width="96" alt="">

Marq is a desktop app for a Markdown knowledge base: run Claude from part of a note, link each run to its session, and query notes with [mq](https://github.com/harehare/mq). See [SPEC.md](SPEC.md).

## Requirements

- Rust (stable), Node.js and pnpm
- The `claude` CLI, logged in. Sessions run through the Claude Agent SDK in a Node sidecar (`sidecar/`), using your own `claude` and its login

## Develop

```sh
pnpm install        # also installs sidecar/ dependencies
pnpm tauri dev
pnpm check         # type checks, clippy and Rust tests
```

## Usage

1. Open a folder as the vault. Any folder of Markdown files works.
1. **New task** (⌘N) starts Claude on a repository. Leave the title empty and Claude names the task. The task is saved as a request note, and a git repo gets its own worktree and branch, so several tasks can run at once. Tick **Include my uncommitted changes** to start from your working tree instead of HEAD. The session's **Changes** panel shows the diff, and lets you commit, create a PR, or open the worktree in Finder, Terminal or VS Code.
2. Notes open in **Preview**. Switch to **Edit** or **Split** from the toolbar, or double-click a block in the preview to edit that line.
3. Hover a heading in the preview and choose **Ask Claude**, or press ⌘↵ in the editor. marq adds an anchor under the heading, starts a session, and opens it in a tab. When it finishes, the result shows up as a card under the section.
4. For a request (**Request** in the sidebar), the whole note is the prompt. Set `project:` to the repository Claude should work in, and optionally `permission_mode: acceptEdits`. Open requests are listed in the sidebar **Inbox**.
5. Anchors in the preview show their sessions. The note's right panel lists them too, and **Origin note** in a session jumps back.
6. ```` ```mq ```` blocks run automatically in the preview, and the output appears right below the block. Add `input=./daily/*.md` to the fence to run the query over other files, or `aggregate=false` to turn off `-A`.
7. **Query** in the sidebar opens a query tab with presets (inbox, learnings, Bash commands).
8. With the **Ask** or **Accept edits** permission modes, tool calls that need permission show an approval card in the session (Allow, Always allow, Deny with a note). Sessions waiting on you are listed under **Needs you**.
9. You can send follow-ups while Claude is working; they run after the current turn. **Stop** interrupts the turn.
10. **Summarize** writes Summary and Learnings into the session note from a fork of the conversation. Claude can also add learnings itself through the marq MCP tools, and look up your notes with `search_notes`, `query_notes` and `read_note`.
11. **Pin** on an mq block saves its output into the note. Local images in notes are shown in the preview.
12. The sidebar **Inbox** lists requests that have not been started. Right-click a request to mark it done, drop it, or move it back to todo.
13. A session that stopped part-way (interrupted or error) shows a **Resume** button, also in the sidebar's right-click menu. It continues the conversation, or starts it again from the first prompt if Claude never started.
14. Type `/` at the start of a line in the session composer or the New task prompt to complete skills and slash commands (↑↓, Enter or Tab, Esc). The list comes from Claude Code for the session's directory, or the task's project.
15. Select text in a note or a session and choose **Send to session** (⌘⇧↵ in the editor) to hand it to another session with an instruction, or to start a new task with it. Claude can also coordinate with other sessions through `list_sessions`, `read_session` and `send_to_session` (each send is approved by you).
16. Create folders from the Notes header or a folder's right-click menu. The Notes header also expands or collapses every folder, and ⌥-click on a folder opens or closes it with all its subfolders. Folders stay as you left them across launches. Rename or move notes and folders from their menu, or drag them onto a folder; relative links between notes are updated. You can also ask Claude to organize your notes: it can list, create folders and move notes (moves and deletions ask for your approval).
17. **Crews** run several sessions on one project as a team. Choose **Team** in New task, or let a session suggest it for a large task (you approve it), or use **+** next to Crews in the sidebar. A lead forms the team (e.g. impl, reviewer, tester; you approve each member), discusses the plan with everyone and records decisions in the crew note, then splits the work into a shared task list (`crews/<name>/tasks.md`) that members take tasks from and update as they work in parallel. Designs and reports they write are saved in the crew's folder and linked from the crew note. The crew tab shows the whole conversation, each member's status, and any member's session beside it. Messages wait until the recipient finishes its turn, and after `max_hops` member-to-member messages the crew pauses for you to let the next one through.
