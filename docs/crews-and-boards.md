# Crews and boards

> [!NOTE]
> Crews use Claude only. They do not run on Ollama models.

## Crews

A crew is several sessions working on one project as a team. Each member has a role, and members message each other by role. The crew opens in one tab that shows the message timeline, the members, and any member's session beside them.

### Starting a crew

- **New task** with **Team**: the prompt becomes the Goal, and the crew is kicked off at once.
- From a session: an ordinary session can suggest a crew for a large task that needs several kinds of work in parallel. You approve it. The crew works on the session's repository, and the session shows a card for it.
- **+** next to Crews in the sidebar writes a template for you to fill in. Then press **Kick off**.

A new crew has only a `lead`. The lead designs the team first (you approve each member), discusses the plan with everyone, records decisions in the crew note, and then splits the work into a shared task list. Listing more members in the note skips the first step.

### The crew note

A crew is a note with `type: crew` in `crews/`:

```yaml
---
type: crew
title: Improve mq LSP
project: ~/dev/git/mq       # where members work
max_hops: 20                # see Hops below
model: sonnet               # the members' model unless they set their own
routes:                     # see Routes below
  - from: impl
    to: reviewer
restart: 2                  # see Restarts below
sandbox: on                 # on | strict, for every member unless it sets its own
members:
  - role: lead
    worktree: false         # work in the project directory
    model: opus
  - role: impl
    permission_mode: acceptEdits
  - role: reviewer
    worktree: false
---
# Improve mq LSP

## Goal

...

## Roles

### lead
...
### impl
...
```

- `members` lists roles in order. **Kick off** sends the Goal to the first one. `user` and `all` are reserved.
- `### <role>` under `## Roles` is that member's instructions. They go into the member's system prompt with the Goal and the roster.
- A member gets its own worktree on `marq/<role>-<short id>` when the project is a git repository, unless `worktree: false`. Members can read each other's directories.
- The note is read whenever a message is sent or a member starts, so edits apply from then on.

### Workspaces

A crew can work across several directories, like a [request](sessions.md#workspaces) can. Add `workspace:` (a workspace note) or `directories:` to the crew note, or choose them in the New task dialog with **Team**. A crew that a session starts with `start_crew` gets that session's directories.

```yaml
project: ~/dev/git/mq          # or the workspace's project when empty
workspace: workspaces/mq-docs.md
```

Every member can read and edit the directories. A member with its own worktree also gets a worktree on its branch in each repository marked `worktree: true`, so implementers working in parallel do not overwrite each other. Members with `worktree: false`, such as the lead and reviewers, use the directories as they are. Members can also read the other members' copies of the directories, as they can read each other's worktrees. The workspace note's text is added to every member's instructions.

### Models

Each member runs on its own `model`, else the crew's `model`, else Claude Code's default. Use `opus`, `sonnet`, `haiku` or a full Claude model name; crews do not run on Ollama.

The lead picks a model for each member it adds, and any member can switch one with `crew_set_model` when the work changes (for example, opus for a hard design question, then sonnet for the implementation). The switch is written to the crew note and shown in the timeline. You can also pick a member's model at the top of its session pane in the crew view. A new model applies from the member's next turn.

### Messages

A member is an ordinary session, listed and reviewed like any other. Members send messages with `crew_send` to a role, to `user`, to `all`, or to several roles at once. A message is delivered only between turns: if the member is in the middle of a turn it waits, and when the turn ends everything waiting arrives together. A member never waits for an answer inside a turn; replies come as new messages.

A message to several members starts a discussion. Members speak once per round and only with something new, and whoever started it (usually the lead) closes it with `crew_decide`, which appends to `## Decisions` in the crew note. You write to a member from the crew view's composer, and members write to you with `to: "user"`.

### Hops

Every message from you has hop 0. A message a member sends has the hop of the last batch it received plus one. A message to a member with a hop over `max_hops` (default 20) is **held**: it is logged but not delivered, and the timeline shows it with **Let it through**. This keeps members from messaging each other forever without you.

### Routes

`routes` forward a member's reply automatically. When `from` ends a turn, its final reply goes to `to` as a message from `from`. For example, every implementation result reaches the reviewer without the implementer having to send it. Routed messages count hops like any other message.

### Restarts

With `restart: N`, a member whose process ends with an error is started again on its own, up to N times per role. It continues its conversation and is told to check its work and the task list. Each restart shows in the timeline.

### Task list and documents

The crew's folder `crews/<name>/` holds the task list and the members' documents.

`crews/<name>/tasks.md` is a [board](#boards) (`type: board` with `crew: <id>`) with a list per status (Todo, Doing, Review, Blocked, Done) and a card per task, with notes as nested items:

```markdown
## Doing

- [ ] **T1** Show types on hover — @impl
  - impl: branch marq/impl-1a2b3c
```

Moving a card to another list changes its status; lists you add that are not a status are kept but hold no tasks. Members take a task by setting it to `doing`, which makes them its owner; if another member is already doing it, that fails, so members working in parallel never pick the same task. Documents members write are saved in the crew's folder and linked from `## Documents` in the crew note.

### The crew view

- **Left**: members with status, unread mail and branch. Click one to show its session on the right, with approvals; double-click to open it in its own tab.
- **Center**: the timeline of every message, with `ask` and `reply` badges, `queued` until delivered, and held messages. The composer sends to one member or to all.
- **Header**: the project, **Kick off** and **Edit crew note**. A banner names members waiting for an approval.
- **Tasks** shows the task list as a board: drag cards between statuses, add cards, link notes, and pick the owner from the members (the new owner is told). Crew boards are not listed under Boards in the sidebar. **Docs** lists the crew's documents.

Each member can also set `sandbox:` in `members`; see [Workflows](workflows.md#sandbox).

## Boards

A board is a Markdown note, `boards/<name>.md` with `type: board`. Each `## ` heading is a list, and each checklist item a card:

```markdown
## Todo

- [ ] **T1** Write docs — @me
  - start with the README

## Done

- [x] **T2** Add logo
```

Editing the Markdown is editing the board: moving an item under another heading moves the card, items written without `**T<n>**` get an id on the next save, and moving a card into a list named Done checks it. New boards start with Todo, Doing and Done.

The board tab shows the lists as columns (**Board**) or stacked (**List**). Drag cards between and within lists; lists can be added, renamed, moved and removed when empty. A card can start a session whose prompt names the card. **Markdown** opens the note itself.

### Queue

**Queue** in the board's header lets Marq work through a list on its own while it runs. Pick the queue list (e.g. Agent), the list cards move to while a session works on them (Doing) and the one they move to when its turn ends (Review), how many run at once, the project, permissions and model. Lists that do not exist yet are added.

Every 30 seconds Marq puts the cards in the queue list into the [Inbox](sessions.md#inbox), where they show as **Queued**, and starts them from there, up to the board's limit. **Queue** in a card's dialog puts that card in the queue list and queues it at once, next to **Start a session**, which still starts immediately; on a board with no queue it opens the queue settings. To take a card back, move it out of the queue list; a queued card cannot be dismissed in Inbox. A started card moves to the working list, gets a link to the request note it started, and runs like **Start a session**, in its own worktree unless you turn that off. When the session's turn ends the card moves to the review list, unless the session or you moved it elsewhere already. When you mark the session done (or its request note's status), the card moves to the Done list; until then it waits in review for you to check the result. A card that fails to start goes to the review list with the reason.

**Check** runs a command after each card's turn, and **Sandbox** sandboxes the queue's sessions. A card moves to the review list only after its check has passed or given up. Cards linked to a [spec](workflows.md#specs) also get the spec as context, plus its check, sandbox and acceptance criteria.

The settings are frontmatter keys on the board note (`queue`, `queue_doing`, `queue_review`, `queue_max`, `queue_project`, `queue_model`, `queue_permission_mode`, `queue_worktree`, `queue_verify`, `queue_sandbox`). Nobody watches these sessions start, so with **Ask** permissions they wait for your approval; **Accept edits** or **Auto** lets them get on with it.

Agents read and change boards with `list_boards`, `read_board`, `board_add_card`, `board_update_card` and `board_add_list`. See [Vault tools for agents](tools.md).
