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

**Save for later** in the New task dialog saves the task as a request note without running it, and **Queue** saves it and puts it in the [Inbox](inbox.md) to start in its turn (one at a time with schedules, by default), so you can line up several tasks. You can also write a request by hand: set `project:` to the repository, and optionally `permission_mode: acceptEdits`. Requests that have not been started show a dot in the Notes tree, and are listed in **Inbox** and in the Query tab's Inbox preset. Right-click one to mark it done, drop it, or move it back to todo.

## Inbox

Requests saved for later are listed in **Inbox** with a ▶ **Queue** button. Schedules, queued requests, board cards and agents' follow-ups wait there for room to run, together with what needs your attention. See [Inbox and follow-ups](inbox.md).

## Workspaces

A task can span several directories, such as an app and its docs site, or a service and a library it uses. List them in the request:

```yaml
project: ~/dev/git/mq                # where the session runs
directories:
  - path: ~/dev/git/mq-docs
    worktree: true                   # a git repository gets its own worktree on the task's branch
  - ~/dev/git/mq-lib                 # used as it is
```

The agent can read and edit every directory listed (Claude Code's additional directories), and is told where each one is. A directory with `worktree: true` that is a git repository gets a worktree on the same branch as the task's, when the task works in a worktree. It shows as a tab in the **Changes** panel, where you can review, commit, push and open a pull request for it on its own. Deleting the session can remove those worktrees too. Directories without a worktree are used as they are, so tasks running at the same time can change them at the same time. Those that are git repositories get a tab too, showing the uncommitted changes of that checkout, whoever made them. Under the tabs is the path of the repository shown: the worktree, or the directory itself.

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

Choose it under **Workspace** in the New task dialog. A request that uses a workspace unchanged records `workspace: workspaces/mq-docs.md`, so later edits to the workspace apply to it. If you change the directories in the dialog, the request lists them itself instead. To keep the change, choose **Update "name"** to overwrite the workspace, or **Save as workspace** with the name of an existing workspace. Overwriting replaces the note's project and directories, and keeps its text. The workspace's body goes to the agent as context. A request's own `project:` and `directories:` take precedence over the workspace's.

Schedules (`workspace:` or `directories:`) and [crews](crews-and-boards.md#workspaces) take a workspace too.

## Worktrees and review

When the project is inside a git repository, each session gets its own worktree at `~/.marq/worktrees/<repo>/<short id>` (change the location under **Settings → Worktrees**, `[worktree] dir`; the same section sets whether New task starts with a worktree, `default`, and where it starts from, `base`) on a new branch `marq/<short id>`. Where it starts is up to `base:` in the note, set by **Start from…** in New task: `head` (the project's current checkout; the default for notes without `base:`), `latest` (the tip of the default branch, taken from `origin/HEAD`, else `main` or `master`, after a `git fetch origin`) or a branch name. Your own checkout is never switched or pulled, and a pull request goes to the branch the work started from. If the fetch fails (offline, no access) the local branch is used. New task remembers the last choice and starts on `latest`. Set `worktree: false` in the note to work in the project directory, or `branch:` to name the branch.

- Tick **Include my uncommitted changes** (`carry_changes: true`) to copy your uncommitted diff and untracked files into the new worktree. This only works when starting from `head`, since the changes are a diff against it.
- The **Changes** panel diffs against the base commit, so it covers commits made in the worktree, uncommitted edits and untracked files.
- From the panel you can commit everything, push (`git push -u origin <branch>`), push and create a pull request with `gh` (the message's first line is the title, the rest the body), rename the branch, open a terminal tab in the worktree, open it in Finder or VS Code, and remove the worktree. Removing keeps the branch.
- **Review comments**: click + on a diff line (shift-click for a range) to comment. **Send review** sends all comments to the session as one message; **Edit first** puts it in the message box instead. A file's diff, or the whole diff, can also be put into the message box (cut at 600 lines per file).
- **Mark as done** moves a session out of **Needs review** and removes its worktrees (the branches stay). A worktree with uncommitted or untracked files is kept, and so are those of a session that is still running. A created PR shows a badge in the sidebar.

## Running side by side

A worktree separates the code, not the machine. Tasks that run at the same time still share ports, databases and anything else outside git. To keep them from colliding, every session's agent gets these environment variables:

- `MARQ_SESSION_ID`: the session's short id, for naming databases, containers and temp directories.
- `MARQ_PORT_1` to `MARQ_PORT_4`: four consecutive ports reserved for the session, taken from 20000–29999.

The values come from the session's id, so a resumed session gets the same ones and finds its own dev server again. The agent is told to use them instead of fixed ports and to check before repeating a command that was cut off before it reported its result (a migration, a deploy). Your project has to read them to benefit: `PORT=${MARQ_PORT_1:-3000}` in a `.env`, `mise.toml` or script is enough.

### Environment notes

To say more about how a project should run, write an environment note. Its text goes into the system prompt of every session on the project, and its frontmatter names ports and sets variables:

```markdown
---
type: environment
ports: [web, api]          # MARQ_PORT_WEB and MARQ_PORT_API (the first two of the four ports)
vars:
  DATABASE_URL: "postgres://localhost/app_{id}"   # {id} is the session's short id
---
## Rules
- Start the dev server on $MARQ_PORT_WEB.
- Never deploy without asking. A migration runs on the shared database: check its state before you repeat one.
```

Create one from the command palette: **New environment note** makes `environments/<project>.md` in the vault, and **Create .marq/environment.md** makes the repository's own file and opens it in VS Code. Both are for the project of your last task and start with the fields commented out. A vault note's folder does not matter; only `type: environment` does.

There are two places for it:

- **`.marq/environment.md` in the repository** is shared with everyone who clones it, and wins when both exist.
- **A note with `type: environment` in the vault**, with `project:` set to the project (or empty for every project).

Up to four names are used. `vars:` from a vault note are set in the agent's environment. A repository's `vars:` are not, and its `resources:` commands are not run, until you trust them: a file you cloned could otherwise set `PATH`, `NODE_OPTIONS` or `ANTHROPIC_BASE_URL` for the agent's process. **New task** lists them when you pick such a project, with **Trust and apply**. Until then the agent only reads them as text and sets them in the commands that need them, under the usual permissions. The choice is kept in `~/.marq/trusted-environments.json` for that project and those exact variables and commands, so changing one asks again; editing the rest of the file does not. Tasks that start without the dialog (schedules, queued work) use what you trusted earlier. Naming ports is always safe, so it works from either place.

### Setting up a new worktree

A new worktree has the code but not what git leaves out: `node_modules`, a `.env` file, a build. Without help, every agent works out the same steps again. List them once and Marq runs them before the agent starts:

```yaml
copy: [.env.local]                      # taken from the project's own checkout, if the worktree lacks it
setup:                                  # run in the worktree, in order, after the resources are made
  - pnpm install --frozen-lockfile
```

- **`copy:`** takes files from the project's checkout into the worktree when they are not there. Paths are relative to the project, and `..` or an absolute path is ignored. A symlink that leads out of the project is skipped. It works from either place without being trusted.
- **`setup:`** is one command or a list. They run in the worktree with the session's `MARQ_*` variables and the shell's `PATH`, one after the other, and stop at the first failure after at most 15 minutes. If one fails the session does not start and shows the output; **Resume** tries again. The agent is told setup ran, so it does not repeat it.
- **Once per worktree.** What ran is kept in `.marq/setup/` in the vault with the commands as they were, so a resumed session, a later phase and the session that checks acceptance do not install again. Changing a command runs them all again.
- **Not in your own checkout.** A session that works directly in the project (`worktree: false`, or a project that is not a git repository) is not set up: Marq does not run commands in your working copy behind your back.
- **Trust**: like `resources:`, `setup:` commands run outside the agent's permissions, so a repository's file is only run after you trust it in **New task**, which lists them; changing one asks again. Until then the agent is told the commands and may run them itself under the usual permissions.

Because the file lives in the repository, a new teammate and every agent start from the same steps, and adding a step helps everyone from then on.

### A check for every request

`verify:` in an environment note is the check that every request on the project runs after each turn, as in [Workflows](workflows.md#checks). It takes the same `verify_retries`, `verify_retry`, `verify_timeout` and `verify_model` as a request. A request's own `verify:` replaces it, and `verify: off` skips the command for that request (its `## Acceptance` still runs). Like `setup:`, a repository's `verify:` only runs once you trust the file.

```yaml
verify: pnpm check
verify_retries: 3
```

### Stopping commands: `ask` and `deny`

A rule in the note's text is only a request. `ask` and `deny` are enforced:

```yaml
ask: ["wrangler deploy", "db:migrate"]     # waits for your approval, even in Auto
deny: ["rm -rf", "docker compose down"]    # refused; the agent is told to ask you to run it
```

- A Bash command that **contains** a string is stopped, so `wrangler deploy` also catches `pnpm exec wrangler deploy --env prod` and a command in the middle of `a && b`. Runs of spaces count as one. `deny` wins over `ask`.
- `ask` shows the usual approval in the session, in every permission mode, including Auto, where a classifier would otherwise decide.
- It is a safety net against slips, not a lock. A command built at run time (in a variable, in `sh -c "…"` or in a script that runs it) is not seen. Use the [sandbox](workflows.md) to cut off what must not be reached.
- The rules are enforced for **Claude** sessions. Other agents only read them as text in their prompt.
- They only restrict, so a repository's `ask` and `deny` apply without being trusted. At most 50 of each are used.

### Resources a worktree cannot isolate

A database, a bucket prefix or a scratch directory is shared by every task, whatever its worktree. List them under `resources:` and Marq makes one for each session and removes it afterwards:

```yaml
resources:
  db:
    create: createdb app_{id}                  # run before the agent starts
    drop: dropdb --if-exists app_{id}          # run when the session is done or deleted
    env:
      DATABASE_URL: postgres://localhost/app_{id}   # set for the agent once it exists
```

- **Create** runs in the session's directory, with `MARQ_SESSION_ID` and the `MARQ_PORT_*` variables, before the agent starts. If it fails (or takes more than two minutes) the session does not start and shows the output; **Resume** tries again. The agent is told these resources exist and not to create or drop them.
- **Drop** runs when you mark the session done or delete it, and for the runs you did not keep in a comparison. If it fails, the error is shown, the resource stays on record, and marking the session done again retries it. Deleting the session still goes ahead; the message gives the command to run by hand.
- **Both commands must contain `{id}`** (the session's short id), so that one session cannot create or drop another's resource, or one that everyone shares. A resource whose commands lack it is left out, and the agent is told so. Write both so that running them twice is harmless: a create that was cut off (the app stopped, the task was cancelled) is run again, and its drop runs even though nobody knows whether it finished.
- **What was made** is kept in `.marq/resources/<session id>.json`, with the drop command as it was when the resource was made, so editing the note later does not change what is dropped. A resource that is `creating` or `failed` there is one whose state is unknown.
- **Trust**: Marq runs these commands itself, outside the agent's permissions. A vault note is yours and is run as it is. A repository's file is only run after you trust it in **New task**, which lists the commands; changing one asks again. Until then nothing is run and the agent only reads about them.

This covers what can be made per session. A database or service that must stay shared (staging, a third-party API) cannot be, so nothing here isolates it; say in the note's rules what the agent must not touch.

Two sessions can occasionally draw the same block, and another program may hold a port; Marq does not check. Nothing is isolated beyond that: a migration or deploy still hits the shared database or target.

## Compare agents and models

In **New task**, choose **Compare with another agent or model** under Run to add up to three more runs. Each run is a Claude model, or another agent such as Codex or Gemini CLI, which runs on its own model. Marq saves one request note and starts one session per run, each in its own worktree, so the runs cannot overwrite each other. This needs a git repository and **Work in a new worktree**. The sandbox is Claude only, so it is left off when a comparison includes another agent.

A **Compare** tab opens with one column per run: the model or agent, status, branch and changed files. Open a file to see its diff. When every run has finished, **Keep this one** removes the worktrees of the other runs and drops the [resources](#resources-a-worktree-cannot-isolate) made for them (their branches and session logs are kept) and opens the one you kept, where you commit and create a PR as usual. For runs you started earlier, right-click one of them in the sidebar and choose **Compare runs**.

## Checks, phases and the sandbox

A request can check its own work after each turn (`verify:` and `## Acceptance`), run in phases (`phases: [research, plan, implement]`, or a playbook such as `playbook: bug-fix`), and run in Claude Code's sandbox (`sandbox:`). See [Workflows](workflows.md).

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

Each run saves a request note and starts a session from it, like **New task**. The request takes `verify`, `verify_retry`, `verify_retries`, `verify_timeout`, `verify_model`, `phases`, `playbook`, `phase_gate` and `sandbox` from the schedule; see [Workflows](workflows.md). An interval counts from the last run; a run is skipped while the previous one is still in its turn; runs missed while Marq was closed are made up once when it opens. The sidebar shows when each schedule runs next, with **Run now** and **Pause** on hover.

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

Type `/` at the start of a line in the session composer or the New task prompt to complete skills and slash commands (↑↓, Enter or Tab, Esc). The list comes from Claude Code for the session's directory, with your skills, commands and plugins before the built-ins. Skills and commands that other agents keep on disk are listed too, from the project (up to the repository root) and your home directory: `.claude/skills` and `.claude/commands`, `.codex/skills` and `.codex/prompts`, `.gemini/` and `.qwen/` (`skills`, and `commands` as TOML), `.opencode/` and `~/.config/opencode/`, and `.agents/skills`. A badge shows which agent a skill came from. This also keeps the list working when `claude` is not installed, though without Claude Code's built-ins and plugins.

## Referring to notes

Type `[[` in the message box of a session or the New task dialog to pick a note by title, file name, alias or path. When you send, Marq attaches each note you named after your message, so the agent reads exactly that:

- `[[Note]]` attaches the whole note, without its frontmatter.
- `[[Note#Heading]]` attaches only that section (the heading and everything under it, down to the next heading of the same level).
- A note over 20,000 characters is named instead, for the agent to read with `read_note`. A name that matches no note is reported to the agent as missing.

The conversation shows your message as you typed it, with each `[[...]]` as a link that opens the note. Links in a request note's body are attached the same way when its session starts.

## Sending text between notes and sessions

Select text in a note or a session and choose **Send to session** (⌘⇧↵ in the editor). Pick a session, add an optional instruction, and Marq sends the instruction followed by the excerpt with its source and line numbers. A stopped session is resumed. **New task with this** opens the New task dialog with the same text. In a session, **Fix here** quotes the selection in that session's own message box, so you can ask for a change to exactly that part.

The ↪ button next to Send in a session's message box sends what you typed, with that session's latest answer, to another session. When the text comes from a session (this button or a selection in it), **Send its answer back** returns the other session's answer to the first one when it finishes that turn, so two sessions can work on something together. Both sessions show where a message came from and went; click it to open the other session.

Agents can also coordinate with each other through `list_sessions`, `read_session` and `send_to_session`; every send needs your approval. A message sent with `send_to_session` gets its answer back the same way unless the agent passes `reply: false`. See [Vault tools for agents](tools.md).

## Learnings

Agents can add learnings to the session note themselves with `append_learning`.
