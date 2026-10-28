# Settings and keys

Settings live in `~/.marq/config.toml`. **Settings** (⌘,) creates the file from a template if it does not exist and opens it in `$EDITOR` in a terminal tab. Changes apply when the window regains focus; `[ollama]` applies after restarting Marq.

```toml
[appearance]
font = "Inter"                  # UI font
mono_font = "JetBrains Mono"    # editor, code and terminal
font_size = 13                  # UI, px
editor_font_size = 14
palette = "tarn"                # tarn | amber | nord | solarized | rose-pine
mode = "system"                 # system | light | dark

[editor]
default_mode = "preview"        # preview | edit | split; new notes always open in edit

[terminal]
shell = "/bin/zsh"              # default: $SHELL
args = ["-l"]
font_size = 13
cursor = "block"                # block | bar | underline

[notifications]
enabled = true                  # system notifications when a session finishes, stops or needs an approval

[ollama]
url = "http://127.0.0.1:11434"  # default: $OLLAMA_HOST, then this
```

`palette` is used until you pick one in the 🎨 menu.

## Keys

Keys follow zellij's modes:

| Mode | Enter with | Behavior |
| --- | --- | --- |
| Normal | | Direct shortcuts |
| Tab | ⌃T | Single keys until Esc or ↵ |
| Pane | ⌃P | Single keys until Esc or ↵ |
| Lock | ⌃G | Every key goes to the focused view |

A status bar shows the current mode and its keys. Bound keys are taken before the editor and terminal see them. **⌘K** lists every command with its keys.

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
