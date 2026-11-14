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

**Save for later** in the New task dialog saves the task as a request note without running it. You can also write a request by hand: set `project:` to the repository, and optionally `permission_mode: acceptEdits`. Requests that have not been started show a dot in the Notes tree and in the Query tab's Inbox preset. Right-click one to mark it done, drop it, or move it back to todo.

## Workspaces

A task can span several directories, such as an app and its docs site, or a service and a library it uses. List them in the request:

```yaml
project: ~/dev/git/mq                # where the session runs
directories:
  - path: ~/dev/git/mq-docs
    worktree: true                   # a git repository gets its own worktree on the task's branch
  - ~/dev/git/mq-lib                 # used as it is
```

The agent can read and edit every directory listed (Claude Code's additional directories), and is told where each one is. A directory with `worktree: true` that is a git repository gets a worktree on the same branch as the task's, when the task works in a worktree. It shows as a tab in the **Changes** panel, where you can review, commit, push and open a pull request for it on its own. Deleting the session can remove those worktrees too. Directories without a worktree are used as they are, so tasks running at the same time can change them at the same time.

To pick a set again, save it as a **workspace**: **Save as workspace** in the New task dialog, or **New workspace** in the command palette. Either one writes `workspaces/<name>.md`:

```markdown
---
type: workspace
title: "mq + docs"
project: ~/dev/git/mq
directories:
  - path: ~/dev/git/mq-docs
    worktree: true
---
# mq + docs

mq-docs is the documentation site; update it when a feature changes.
```

Choose it under **Workspace** in the New task dialog. A request that uses a workspace unchanged records `workspace: workspaces/mq-docs.md`, so later edits to the workspace apply to it. If you change the directories in the dialog, the request lists them itself instead. The workspace's body goes to the agent as context. A request's own `project:` and `directories:` take precedence over the workspace's.

Board queues (**Workspace** in the Queue dialog, `queue_workspace`), schedules (`workspace:` or `directories:`) and [crews](crews-and-boards.md#workspaces) take a workspace too.

## Worktrees and review

When the project is inside a git repository, each session gets its own worktree at `~/.marq/worktrees/<repo>/<short id>` on a new branch `marq/<short id>`. Where it starts is up to `base:` in the note, set by **Start from…** in New task: `head` (the project's current checkout; the default for notes without `base:`), `latest` (the tip of the default branch, taken from `origin/HEAD`, else `main` or `master`, after a `git fetch origin`) or a branch name. Your own checkout is never switched or pulled, and a pull request goes to the branch the work started from. If the fetch fails (offline, no access) the local branch is used. New task remembers the last choice and starts on `latest`. Set `worktree: false` in the note to work in the project directory, or `branch:` to name the branch.

- Tick **Include my uncommitted changes** (`carry_changes: true`) to copy your uncommitted diff and untracked files into the new worktree. This only works when starting from `head`, since the changes are a diff against it.
- The **Changes** panel diffs against the base commit, so it covers commits made in the worktree, uncommitted edits and untracked files.
- From the panel you can commit everything, push (`git push -u origin <branch>`), push and create a pull request with `gh` (the message's first line is the title, the rest the body), rename the branch, open a terminal tab in the worktree, open it in Finder or VS Code, and remove the worktree. Removing keeps the branch.
- **Review comments**: click + on a diff line (shift-click for a range) to comment. **Send review** sends all comments to the session as one message; **Edit first** puts it in the message box instead. A file's diff, or the whole diff, can also be put into the message box (cut at 600 lines per file).
- **Mark as done** moves a session out of **Needs review**. A created PR shows a badge in the sidebar.

## Compare agents and models

In **New task**, choose **Compare with another agent or model** under Run to add up to three more runs. Each run is a Claude model, or another agent such as Codex or Gemini CLI, which runs on its own model. Marq saves one request note and starts one session per run, each in its own worktree, so the runs cannot overwrite each other. This needs a git repository and **Work in a new worktree**. The sandbox is Claude only, so it is left off when a comparison includes another agent.

A **Compare** tab opens with one column per run: the model or agent, status, branch and changed files. Open a file to see its diff. When every run has finished, **Keep this one** removes the worktrees of the other runs (their branches and session logs are kept) and opens the one you kept, where you commit and create a PR as usual. For runs you started earlier, right-click one of them in the sidebar and choose **Compare runs**.

## Checks, phases and the sandbox

A request can check its own work after each turn (`verify:` and `## Acceptance`), run in phases (`phases: [research, plan, implement]`), and run in Claude Code's sandbox (`sandbox:`). See [Workflows](workflows.md).

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

Each run saves a request note and starts a session from it, like **New task**. The request takes `verify`, `verify_retry`, `verify_retries`, `verify_timeout`, `verify_model`, `phases`, `phase_gate` and `sandbox` from the schedule; see [Workflows](workflows.md). An interval counts from the last run; a run is skipped while the previous one is still in its turn; runs missed while Marq was closed are made up once when it opens. The sidebar shows when each schedule runs next, with **Run now** and **Pause** on hover.

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
- The side panel's **Docs** tab lists every document the task saved with `write_doc`, newest first, like a crew's Docs view: those from every run of the same request (other models, earlier sessions) and any the session revised. Click one to open it in a tab.
- A document opened in a tab has a **Session** button that goes back to the session that wrote it (the latest one, if several revised it). The side panel lists them all under **Written by**. Select text in the document's preview and choose **Ask its session** to send it to that session with a question; with the screen split, the conversation shows next to the document.

## Slash commands and skills

Type `/` at the start of a line in the session composer or the New task prompt to complete skills and slash commands (↑↓, Enter or Tab, Esc). The list comes from Claude Code for the session's directory, with your skills, commands and plugins before the built-ins.

## Referring to notes

Type `[[` in the message box of a session or the New task dialog to pick a note by title, file name, alias or path. When you send, Marq attaches each note you named after your message, so the agent reads exactly that:

- `[[Note]]` attaches the whole note, without its frontmatter.
- `[[Note#Heading]]` attaches only that section (the heading and everything under it, down to the next heading of the same level).
- A note over 20,000 characters is named instead, for the agent to read with `read_note`. A name that matches no note is reported to the agent as missing.

The conversation shows your message as you typed it, with each `[[...]]` as a link that opens the note. Links in a request note's body are attached the same way when its session starts.

## Sending text between notes and sessions

Select text in a note or a session and choose **Send to session** (⌘⇧↵ in the editor). Pick a session, add an optional instruction, and Marq sends the instruction followed by the excerpt with its source and line numbers. A stopped session is resumed. **New task with this** opens the New task dialog with the same text.

The ↪ button next to Send in a session's message box sends what you typed, with that session's latest answer, to another session. When the text comes from a session (this button or a selection in it), **Send its answer back** returns the other session's answer to the first one when it finishes that turn, so two sessions can work on something together. Both sessions show where a message came from and went; click it to open the other session.

Agents can also coordinate with each other through `list_sessions`, `read_session` and `send_to_session`; every send needs your approval. A message sent with `send_to_session` gets its answer back the same way unless the agent passes `reply: false`. See [Vault tools for agents](tools.md).

## Learnings

Agents can add learnings to the session note themselves with `append_learning`.
