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
sidebar = "full"                # full | rail: with rail only icons show, and one opens its list over the content

[editor]
default_mode = "preview"        # preview | edit | split; new notes always open in edit
vim = false                     # Vim keys in the note editor; :w saves

[chat]
send = "mod-enter"               # mod-enter | enter | shift-enter: the key that sends a message (⌘↵ always does); the others add a line

[terminal]
shell = "/bin/zsh"              # default: $SHELL (Windows: pwsh, else powershell)
args = ["-l"]
font = "Fira Code"              # default: mono_font
font_size = 13
ligatures = true                # -> != |> … drawn as ligatures with fonts that have them
cursor = "block"                # block | bar | underline

[notifications]
enabled = true                  # system notifications when a session finishes, stops or needs an approval (bursts are combined)

[tabs]
pinned_layout = "inline"        # inline | row: pinned tabs first in the tab bar, or in a row above the others
overflow = "scroll"             # scroll | wrap: tabs that do not fit scroll sideways, with a count of those out of sight, or wrap onto more rows

[ollama]
url = "http://127.0.0.1:11434"  # default: $OLLAMA_HOST, then this

[scratch]
keep_days = 7                   # scratch memos not changed for this many days go to the Trash; 0 keeps them

[inbox]
parallel = 1                    # scheduled runs and queued requests that go at once (1 to 8); the rest wait in the Inbox

[sandbox]
unattended = "on"               # on | strict: sandbox schedules that do not set one

[agents]
gemini = { command = "gemini", args = ["--experimental-acp"] }
kimi = { label = "Kimi", command = "kimi", args = ["acp"] }
```

`palette` is used until you pick one in the 🎨 menu.

With `sidebar = "rail"` (or **Settings → Appearance → Sidebar**, or the **Icons only** button at the top of the sidebar) only a column of icons shows: Search (full-text, ⇧⌘F), New task, then Inbox, Active, Sessions, Recent, Boards, Crews, Schedules and Notes, with note, terminal, theme and settings below. An icon opens that list over the content; picking an item, clicking outside it or pressing the icon again puts it away. ⌘B hides the icons too, and the button at the bottom of the rail brings the full sidebar back.

## Agents

Tasks run on Claude Code by default. The New task dialog can run one on Codex (`codex app-server`, Codex's own embedding interface) or on another agent that speaks [ACP](https://agentclientprotocol.com) (Agent Client Protocol) instead: Gemini CLI (`gemini --experimental-acp`), OpenCode (`opencode acp`), Qwen Code (`qwen --experimental-acp`) or Goose (`goose acp`). **Settings → Agents** changes an agent's `command` or `args`, or adds another ACP agent; they are saved as `[agents.<id>]`, which you can also edit in the file.

Such a session uses the agent's own model and tools. Marq's tools reach it over MCP (HTTP) when the agent supports that, and its permission requests show up as approval cards. Teams and model choice are Claude only (such an agent can still be one run of a comparison).

## Keys

Keys follow zellij's modes:

| Mode | Enter with | Behavior |
| --- | --- | --- |
| Normal | | Direct shortcuts |
| Tab | ⌃T | Single keys until Esc or ↵ |
| Pane | ⌃P | Single keys until Esc or ↵ |
| Lock | ⌃G | Every key goes to the focused view |

A status bar shows the current mode and its keys. Bound keys are taken before the editor sees them. **⌘K** lists every command with its keys.

With `[editor] vim = true` (or **Settings → Editor → Vim keys**) notes are edited with Vim keys and a mode line. `:w` and `:wq` save the note. While Vim has focus, **⌃T**, **⌃P** and **⌃G** go to Vim; the **⌘** shortcuts still work.

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

A terminal tab can be split into panes like tmux, each with its own shell in the tab's directory:

| Keys | |
| --- | --- |
| ⌘D / ⇧⌘D | Split the focused pane: new one on the right / below |
| ⌥⌘← → ↑ ↓ | Focus the pane in that direction (⌘] cycles) |
| ⇧⌘↵ | Zoom the focused pane, again to restore |
| ⌘W | Close the focused pane; the last one closes the tab |

Drag a divider to resize. A pane closes when its shell exits, unless it is the last one. Panes are not restored when Marq restarts (a pinned tab comes back as one shell). Bind them with `terminal.splitRight`, `terminal.splitDown`, `terminal.paneLeft`, `terminal.paneRight`, `terminal.paneUp`, `terminal.paneDown`, `terminal.paneNext`, `terminal.paneZoom` and `terminal.paneClose` in `[keys]`.

## Shell environment

Apps started from Finder get a minimal `PATH`. On macOS and Linux, Marq reads the `PATH` of an interactive login shell (`$SHELL -ilc`) once and uses it to find `git`, `gh`, `node` and `claude`. It is also passed to the sidecar, so an agent's Bash tool sees the same commands as your terminal. On Windows, apps get your own `PATH`, which is used as is.
