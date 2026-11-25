# Marq

**Run agents. Keep everything.**

Marq is a Markdown knowledge base and an IDE for coding agents, in one app. It runs coding agents in parallel, each in its own git worktree, and keeps every prompt, session, task and document they produce as plain Markdown files in your vault. Because it is all Markdown, you can query it with [mq](https://github.com/harehare/mq) and hand exactly the parts you pick to the next agent.

> [!WARNING]
> Marq is under active development. Features, file formats and keybindings may change without notice.

## Where to start

| Page | Contents |
| --- | --- |
| [Getting started](getting-started.md) | Install, open a vault, your first session, the sidebar |
| [Vault and file formats](vault.md) | Folder layout, frontmatter, anchors, result blocks, session files |
| [Sessions](sessions.md) | Ask, tasks and requests, worktrees and review, approvals, resume |
| [Inbox and follow-ups](inbox.md) | What waits for you, queued work, agents' follow-ups, standing instructions, notifications |
| [mq queries](mq.md) | `mq` code blocks, pinning, built-in queries, picking context |
| [Boards](boards.md) | Kanban boards as Markdown, and starting sessions from their cards |
| [Workflows](workflows.md) | Checks, acceptance criteria, phases, the sandbox, specs, skills |
| [Agents and models](agents.md) | Claude, Ollama, ACP agents, permission modes, how sessions run |
| [Vault tools for agents](tools.md) | The MCP tools agents use to read and organize the vault |
| [Settings and keys](settings.md) | `~/.marq/config.toml`, keybindings, shell environment |
| [Building and distribution](building.md) | Build Marq for macOS, Windows and Linux, and publish the site |
