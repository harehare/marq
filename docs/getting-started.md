# Getting started

> [!WARNING]
> Marq is under active development. Sessions run from source for now, and Claude and Ollama are fully supported, and other agents work through ACP with fewer features.

## Requirements

- Rust (stable), Node.js and pnpm
- The `claude` CLI, logged in. Sessions run through the Claude Agent SDK in a Node sidecar (`sidecar/`), using your own `claude` and its login and settings.
- Optional: [Ollama](https://ollama.com) for local models, or another agent such as Gemini CLI, Codex or OpenCode (see [Agents and models](agents.md)), `git` and `gh` for worktrees and pull requests.

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
| Needs you | Sessions waiting for an approval |
| Needs review | Stopped sessions with changes in their worktree and no review state |
| Running / Recent | Sessions. Crew members appear only under their crew |
| Crews | Teams of sessions. See [Crews and boards](crews-and-boards.md) |
| Boards | Kanban boards stored as Markdown |
| Query | A query tab with presets (todo requests, drafts, learnings, Bash commands). See [mq queries](mq.md) |

Find things with **⌘P** (open a note, board, crew or session by fuzzy title or path: crews open in the crew view and sessions in their conversation, sessions at work listed first; ⇧↵ searches text instead) and **⇧⌘F** (the Search tab: lines that contain every word, grouped by note). **⌘F** finds within the open note (in the preview, or in the source when only the editor is shown) or, on a session tab, in the Changes panel's diffs; ↵ and ⇧↵ move between matches. ⌘K lists every command with its keys.

To see two tabs at once, such as a session and a document it wrote, **⌥-click** a tab, or anything that opens one (a note in the tree, a document card, a session), to open it to the side. **⌘\\**, the split button at the end of the tab bar, or **Open to the side** in a tab's right-click menu do the same for the tab shown. Click in a pane to focus it; the tab bar's buttons put the panes side by side or one above the other, and close the split. ⌃P then S, O, D and X split, move to the other pane, turn the split and close it.
