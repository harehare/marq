<div align="center">
  <img src="assets/logo.svg" width="128" height="128" alt="Marq"/>

<h1>Marq</h1>

**A Markdown knowledge base and an IDE for coding agents, in one app.**

</div>

Marq runs coding agents in parallel, each in its own git worktree, and keeps everything they do (prompts, sessions, results, tasks) as plain Markdown files next to your notes. Because it is all Markdown, you can query it with [mq](https://github.com/harehare/mq) and hand exactly the parts you pick to an agent.

> [!WARNING]
> Marq is under active development. Features, file formats and keybindings may change without notice.
>
> - Only **Claude** and **Ollama** are supported as agents for now.
> - Sessions run from source with `pnpm tauri dev`. Release builds do not bundle the Node sidecar yet.
> - Developed and used on macOS.

## Features

### Agent IDE

- **Parallel tasks in git worktrees.** Each task gets its own worktree and branch, so several agents can work on one repository at once.
- **Review in the app.** The **Changes** panel shows the diff against the base commit. Comment on diff lines and send the review back to the agent, then commit, push and create a PR.
- **Run an agent from a note.** Hover a heading and choose **Ask Claude**. The session is linked to the heading, and the result comes back as a card under the section.
- **Crews.** Several sessions work on one project as a team by role, with a shared task list. Kanban boards are Markdown too.
- **Compare models.** Run one task on 2 to 4 models, each in its own worktree, look at the diffs side by side, and keep the one you prefer.
- **Notifications.** A system notification and a Dock badge when a session finishes, stops with an error or needs an approval, and an unread marker in the sidebar.
- **Approvals and resume.** Tool calls that need permission show an approval card. Interrupted sessions can be resumed, and you can send follow-ups while an agent is working.
- **Terminal and browser tabs** next to your sessions, for dev servers and previews.
- **Claude and Ollama.** Use your own `claude` login, or a local model served by Ollama.

### Knowledge base

- **Everything is Markdown.** Notes, requests, session logs, crews, boards and documents written by agents are all `.md` files in your vault. Edit them with any editor; Marq only rewrites the parts between its own markers.
- **Query with mq.** `mq` code blocks run in the preview and show their output right below. The same queries power the inbox, the learnings across sessions, and the Query tab.
- **Pick what the agent sees.** Extract a section with mq, select text in a note or a session, or attach `context:` queries to a request, then send exactly that to an agent.
- **Sessions feed back into notes.** Summaries and learnings are written into the session note, and agents can search your notes and save documents to the vault.

## Markdown in, Markdown out

A request is a note. Its body is the prompt, and `context:` attaches pieces of other notes picked with mq:

```markdown
---
type: request
status: todo
project: ~/dev/git/mq
context:
  - query: 'import "section" | nodes | section::find("Design") | section::body()'
    from: notes/design.md
---
# Show types on hover

Implement what the design note says.
```

When the session finishes, Marq writes the result back under `## Result`, and the full transcript to `sessions/`, also Markdown. Because sessions are Markdown, mq can query them as well:

```sh
# Learnings from every session
mq -A 'import "section" | section::find("Learnings") | section::body()' sessions/*.md

# Every command Claude ran
mq 'select(.code.lang == "tool:Bash") | .code.value' sessions/*.md
```

## Quick start

Requirements:

- Rust (stable), Node.js and pnpm
- The `claude` CLI, logged in. Sessions run through the Claude Agent SDK in a Node sidecar (`sidecar/`), using your own `claude` and its login. For Ollama, see [Agents and models](docs/agents.md).

```sh
pnpm install     # also installs sidecar/ dependencies
pnpm tauri dev
pnpm check       # type checks, clippy and Rust tests
```

Open a folder as the vault (any folder of Markdown files works), then open a note, hover a heading and choose **Ask Claude**, or press ⌘N for a new task.

## Documentation

| Page | Contents |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, open a vault, your first session, the sidebar |
| [Vault and file formats](docs/vault.md) | Folder layout, frontmatter, anchors, result blocks, session files |
| [Sessions](docs/sessions.md) | Ask Claude, tasks and requests, worktrees and review, approvals, resume, sending text |
| [mq queries](docs/mq.md) | `mq` code blocks, pinning, built-in queries, picking context for an agent |
| [Crews and boards](docs/crews-and-boards.md) | Teams of sessions, the shared task list, kanban boards |
| [Agents and models](docs/agents.md) | Claude, Ollama, permission modes, how sessions run |
| [Vault tools for agents](docs/tools.md) | The MCP tools agents use to read and organize the vault |
| [Settings and keys](docs/settings.md) | `~/.marq/config.toml`, keybindings, shell environment |

## Compatibility

| Agent | Status |
| --- | --- |
| Claude (through your `claude` CLI) | Supported |
| Ollama (`ollama:<model>`) | Supported, except for crews |
| Other agents | Not supported |

mq queries use [mq-lang](https://github.com/harehare/mq) 0.9.3, embedded in the app.
