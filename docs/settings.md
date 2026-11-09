# Settings and keys

Settings live in `~/.marq/config.toml`. **Settings** (⌘,) creates the file from a template if it does not exist and opens it in `$EDITOR` in a terminal tab. Changes apply when the window regains focus; `[ollama]` applies after restarting Marq.

```toml
[appearance]
font = "Inter"                  # UI font
mono_font = "JetBrains Mono"    # editor and code; the terminal too unless [terminal] font is set
font_size = 13                  # UI, px
editor_font_size = 14
palette = "tarn"                # tarn | amber | nord | solarized | rose-pine
mode = "system"                 # system | light | dark
content_width = "wide"          # normal | wide | full: how wide notes and conversations are

[editor]
default_mode = "preview"        # preview | edit | split; new notes always open in edit

[terminal]
shell = "/bin/zsh"              # default: $SHELL
args = ["-l"]
font = "Fira Code"              # default: mono_font
font_size = 13
ligatures = true                # -> != |> … drawn as ligatures with fonts that have them
cursor = "block"                # block | bar | underline

[notifications]
enabled = true                  # system notifications when a session finishes, stops or needs an approval

[tabs]
pinned_layout = "inline"        # inline | row: pinned tabs first in the tab bar, or in a row above the others

[ollama]
url = "http://127.0.0.1:11434"  # default: $OLLAMA_HOST, then this

[scratch]
keep_days = 7                   # scratch memos not changed for this many days go to the Trash; 0 keeps them

[sandbox]
unattended = "on"               # on | strict: sandbox board queues and schedules that do not set one

[agents]
gemini = { command = "gemini", args = ["--experimental-acp"] }
kimi = { label = "Kimi", command = "kimi", args = ["acp"] }
```

`palette` is used until you pick one in the 🎨 menu.

## Agents

Tasks run on Claude Code by default. The New task dialog can run one on another agent that speaks [ACP](https://agentclientprotocol.com) (Agent Client Protocol) instead: Gemini CLI (`gemini --experimental-acp`), Codex (`codex-acp`), OpenCode (`opencode acp`), Qwen Code (`qwen --experimental-acp`) or Goose (`goose acp`). `[agents.<id>]` changes an agent's `command` or `args`, or adds another ACP agent.

Such a session uses the agent's own model and tools. Marq's tools reach it over MCP (HTTP) when the agent supports that, and its permission requests show up as approval cards. Teams, model choice and comparisons are Claude only, and a summary is written from the session note.

## Keys

Keys follow zellij's modes:

| Mode | Enter with | Behavior |
| --- | --- | --- |
| Normal | | Direct shortcuts |
| Tab | ⌃T | Single keys until Esc or ↵ |
| Pane | ⌃P | Single keys until Esc or ↵ |
| Lock | ⌃G | Every key goes to the focused view |

A status bar shows the current mode and its keys. Bound keys are taken before the editor sees them. **⌘K** lists every command with its keys.

Pinned terminal tabs come back when Marq restarts, as a new shell in the same directory with the same title. What ran in them and their scrollback are not restored.

In a terminal tab only keys with ⌘ are taken; everything else, ⌃T, ⌃P and ⌃G included, goes to the shell, so zellij, tmux and readline keep their keys. The status bar shows **TERMINAL** and the ⌘ shortcuts that still work there (⌘T, ⌘W, ⇧⌘[ / ⇧⌘], ⌘1–9, ⇧⌘E, ⌘K). To use the modes from a terminal, click outside it, or bind the mode keys to something with ⌘:

```toml
[keys]
"mode.tab" = ["Ctrl+T", "Cmd+Ctrl+T"]
```

Bind commands in `[keys]` (normal mode), `[keys.tab]`, `[keys.pane]` and `[keys.locked]`. A value is a key or a list of keys, and `""` unbinds:

```toml
[keys]
"terminal.new" = "Cmd+T"
"tab.next" = ["Cmd+Shift+]", "Ctrl+Tab"]

[keys.tab]      # after Ctrl+T
"tab.next" = ["L", "Right"]

[keys.pane]     # after Ctrl+P
"tree.focus" = "H"

[keys.locked]   # Ctrl+G
"mode.normal" = "Ctrl+G"
```

Modifiers are `Ctrl`, `Alt`, `Shift` and `Cmd`.

With the file tree focused (⇧⌘E, or ⌃P then H): J and K move, L or ↵ opens, H closes a folder or goes to its parent, and Esc returns to the content.

Terminal tabs take their title from the shell until you rename them (⇧⌘R, ⌃T then R, or double-click).

## Shell environment

Apps started from Finder get a minimal `PATH`. Marq reads the `PATH` of an interactive login shell (`$SHELL -ilc`) once and uses it to find `git`, `gh`, `node` and `claude`. It is also passed to the sidecar, so an agent's Bash tool sees the same commands as your terminal.
