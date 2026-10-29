# Getting started

> [!WARNING]
> Marq is under active development. Sessions run from source for now, and only Claude and Ollama are supported as agents.

## Requirements

- Rust (stable), Node.js and pnpm
- The `claude` CLI, logged in. Sessions run through the Claude Agent SDK in a Node sidecar (`sidecar/`), using your own `claude` and its login and settings.
- Optional: [Ollama](https://ollama.com) for local models (see [Agents and models](agents.md)), `git` and `gh` for worktrees and pull requests.

## Run from source

```sh
pnpm install     # also installs sidecar/ dependencies
pnpm tauri dev
pnpm check       # type checks, clippy and Rust tests
```

Release builds do not bundle the sidecar yet, so use `pnpm tauri dev` to run sessions.

Apps started from Finder get a minimal `PATH`. Marq reads the `PATH` of your login shell once, so `git`, `gh`, `node` and `claude` are found, and Claude's Bash tool sees the same commands as your terminal.

## Open a vault

Open a folder as the vault. Any folder of Markdown files works; there is nothing to convert. See [Vault and file formats](vault.md) for the folders Marq writes to.

## Your first session

1. Open a note. Notes open in **Preview**; switch to **Edit** or **Split** from the toolbar, press **⌘E** to switch between preview and editing where you are reading, or ⌘-click a block in the preview to edit that line. A note opened from search, a link or a session stays in Preview and scrolls to the line; only new notes open in the editor.
2. Hover a heading and choose **Ask**, or press ⌘↵ in the editor. Pick an intent (Do it, Review, Plan or Explain), add an instruction if you like, and press ↵.
3. Marq adds an anchor under the heading, starts a session and opens it in a tab. When the session finishes, the result shows up as a card under the section.

To work on a repository instead, press ⌘N for **New task**. See [Sessions](sessions.md).

## The sidebar

| Section | Contents |
| --- | --- |
| Notes | The folder tree. Create, rename, move and drag notes and folders; relative links are rewritten |
| Inbox | Requests that have not been started (`status: todo`) |
| Needs you | Sessions waiting for an approval |
| Needs review | Stopped sessions with changes in their worktree and no review state |
| Running / Recent | Sessions. Crew members appear only under their crew |
| Crews | Teams of sessions. See [Crews and boards](crews-and-boards.md) |
| Boards | Kanban boards stored as Markdown |
| Query | A query tab with presets (inbox, learnings, Bash commands). See [mq queries](mq.md) |

Find things with **⌘P** (open a note, board or crew by fuzzy title or path; ⇧↵ searches text instead) and **⇧⌘F** (the Search tab: lines that contain every word, grouped by note). ⌘K lists every command with its keys.

## Browser tabs

**⇧⌘B** opens a browser tab: an address bar (a URL, `localhost:5173`, or a file path), back and forward, reload, phone width (390px) and open in the default browser. Sites that refuse framing get a link to open them outside. Agents can show you a dev server or an HTML file they wrote with `open_preview`.
