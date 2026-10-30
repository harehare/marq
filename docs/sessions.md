# Sessions

A session is one agent conversation. It is linked to the note, heading or request it started from, and its log is saved as Markdown (see [Vault and file formats](vault.md)). You can run several at once.

## Ask

Hover a heading in the preview and choose **Ask**, press ⌘↵ in the editor, or select text in the preview. The Ask dialog takes:

- An intent: **Do it**, **Review**, **Plan** (plan mode) or **Explain**. The last three make no file changes.
- An optional instruction, added to the prompt.

A selection is sent instead of the whole section, with its line numbers; the anchor goes on the selection's section. Otherwise the prompt is the section text wrapped in `<note path="...">`. Hold ⌥ to open the dialog with project, worktree and model, which override the note's frontmatter for that run only.

Anchors in the preview show their sessions, and the note's right panel lists them too. **Origin note** in a session jumps back.

A session from Ask starts with the section's heading as its title and is renamed from its prompt by a small model while it runs. Rename any session by double-clicking its title or its tab, or from the sidebar's right-click menu.

## Tasks and requests

**New task** (⌘N) starts an agent on a repository.

- Leave the title empty and a small model names the task from its prompt, in the prompt's language. If that takes over 15 seconds, the first line of the prompt is the title.
- The task is saved as a request note in `requests/` first, so every task stays in the vault.
- Choose **Team** to run it as a [crew](crews-and-boards.md) from the start.

**Save for later** in the New task dialog saves the task as a request note without running it. You can also write a request by hand: set `project:` to the repository, and optionally `permission_mode: acceptEdits`. Requests that have not been started are listed in **Inbox**. Right-click one to mark it done, drop it, or move it back to todo.

## Worktrees and review

When the project is inside a git repository, each session gets its own worktree at `~/.marq/worktrees/<repo>/<short id>` on a new branch `marq/<short id>`, created from HEAD. Set `worktree: false` in the note to work in the project directory, or `branch:` to name the branch.

- Tick **Include my uncommitted changes** (`carry_changes: true`) to copy your uncommitted diff and untracked files into the new worktree.
- The **Changes** panel diffs against the base commit, so it covers commits made in the worktree, uncommitted edits and untracked files.
- From the panel you can commit everything, push (`git push -u origin <branch>`), push and create a pull request with `gh` (the message's first line is the title, the rest the body), rename the branch, open a terminal tab in the worktree, open it in Finder or VS Code, and remove the worktree. Removing keeps the branch.
- **Review comments**: click + on a diff line (shift-click for a range) to comment. **Send review** sends all comments to the session as one message; **Edit first** puts it in the message box instead. A file's diff, or the whole diff, can also be put into the message box (cut at 600 lines per file).
- **Mark as done** moves a session out of **Needs review**. A created PR shows a badge in the sidebar.

## Compare models

In **New task**, choose **Compare with another model** under Model to add up to three more models. Marq saves one request note and starts one session per model, each in its own worktree, so the runs cannot overwrite each other. This needs a git repository and **Work in a new worktree**.

A **Compare** tab opens with one column per run: the model, status, branch and changed files. Open a file to see its diff. When every run has finished, **Keep this one** removes the worktrees of the other runs (their branches and session logs are kept) and opens the one you kept, where you commit and create a PR as usual. For runs you started earlier, right-click one of them in the sidebar and choose **Compare runs**.

## Schedules

A schedule runs a prompt again and again while Marq is open: **+** on Schedules in the sidebar, or **New schedule…** in the command palette. It is a note in `schedules/` (`type: schedule`) whose body is the prompt:

```markdown
---
type: schedule
title: "Morning triage"
at: "09:00"          # daily at this time; or every: 30m | 2h | 1d | 1w (5m or more)
enabled: true
project: ~/dev/git/marq
worktree: false
model: sonnet        # optional, like permission_mode
last_run: 2026-10-29T09:00:12+09:00
---
Go through the Todo list on boards/sprint.md and move the cards that are ready to Agent.
```

Each run saves a request note and starts a session from it, like **New task**. An interval counts from the last run; a run is skipped while the previous one is still in its turn; runs missed while Marq was closed are made up once when it opens. The sidebar shows when each schedule runs next, with **Run now** and **Pause** on hover.

### Only when a query has results

A schedule can name a saved query (see [mq queries](mq.md#run-agent-on-results)) with `query:`, or pick one in the dialog. The query runs first. With no results nothing starts, and the run counts as done until the next one; otherwise the agent gets the prompt followed by the results:

```markdown
---
type: schedule
title: "Open bugs"
every: 1d
query: queries/open-bugs.md
each: true           # optional: one session per file (up to 10); default from the query's agent_each
---
Pick the ones you can fix and open a pull request for each.   # empty: the query's agent prompt
```

**Run now** on a schedule whose query finds nothing says so instead of starting a session.

Pairing a schedule with a [board queue](crews-and-boards.md#queue) lets one session pick the work and the queue run it.

## Active sessions

**Active** at the top of the sidebar lists every session that is running or waiting for you, crew members included, those waiting first. The status bar shows the same counts; click it to go through them one by one (also **Go to the next running or waiting session** in the command palette).

## Notifications

Marq shows a system notification, and a count on the Dock icon, when a session finishes a turn, stops with an error, or needs an approval. Nothing is shown for a session whose tab is open in the focused window. Sessions with a result you have not looked at are bold with a dot in the sidebar until you open them. Crew members do not notify on every turn (the crew view shows them), but an approval request from one does.

Turn notifications off with `[notifications] enabled = false` in [`config.toml`](settings.md).

## Approvals

With the **Ask** or **Accept edits** permission modes, a tool call that needs permission shows a card in the session with the tool and its input: **Allow**, **Always allow** (that tool for the rest of the process) or **Deny**, which can carry a note that the agent receives as the reason. Sessions waiting on you are listed under **Needs you**. Stopping a session denies its pending requests.

## Follow-ups, stop and resume

- You can send follow-ups while the agent is working; they run after the current turn. **Stop**, or Esc in the message box, interrupts the turn.
- A session that stopped part-way (interrupted or error) shows a **Resume** button, also in the sidebar's right-click menu. It continues the conversation, or starts again from the first prompt if the agent never started.
- An idle session process is closed after 10 minutes and resumed on your next message.
- Markdown files a turn wrote show up as cards when it ends. A file in the vault opens in a tab; one outside it opens in its default app. Documents saved with `write_doc` get a card as soon as they are written.

## Slash commands and skills

Type `/` at the start of a line in the session composer or the New task prompt to complete skills and slash commands (↑↓, Enter or Tab, Esc). The list comes from Claude Code for the session's directory, with your skills, commands and plugins before the built-ins.

## Sending text between notes and sessions

Select text in a note or a session and choose **Send to session** (⌘⇧↵ in the editor). Pick a session, add an optional instruction, and Marq sends the instruction followed by the excerpt with its source and line numbers. A stopped session is resumed. **New task with this** opens the New task dialog with the same text.

The ↪ button next to Send in a session's message box sends what you typed, with that session's latest answer, to another session. When the text comes from a session (this button or a selection in it), **Send its answer back** returns the other session's answer to the first one when it finishes that turn, so two sessions can work on something together. Both sessions show where a message came from and went; click it to open the other session.

### Helpers

A helper is a session with a standing role, such as translating or proofreading, that you send requests to. Add one with **+** on **Helpers** in the sidebar, the **New helper** command, or **+** next to Helpers in the Send to session dialog. Each names a new helper and opens its note, `helpers/<name>.md`: write the role's instructions in the body. The frontmatter can also set `model`, `agent`, `project` (where it runs; the vault by default) and `permission_mode`.

Pick the helper and send as you would to a session. The first request starts its session on the instructions; later ones go to the same conversation, so it keeps your terms and style. Sent from a session with **Send its answer back**, the answer returns there and you stay where you are. **Start over in a new conversation** begins a fresh session; marq keeps the current one in the note's `session:`.

The sidebar's **Helpers** lists them with their session's status. Click one to open its conversation (or its note before the first request) and chat with it directly; the pencil opens its instructions.

Agents can also coordinate with each other through `list_sessions`, `read_session` and `send_to_session`; every send needs your approval. A message sent with `send_to_session` gets its answer back the same way unless the agent passes `reply: false`. See [Vault tools for agents](tools.md).

## Summarize

**Summarize** writes `## Summary` and `## Learnings` into the session note from a fork of the conversation, without changing the session itself. Agents can also add learnings themselves with `append_learning`.
