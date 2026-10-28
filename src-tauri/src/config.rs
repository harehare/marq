//! App settings in `~/.marq/config.toml`.

use std::path::PathBuf;

use serde_json::Value;

use crate::error::{Error, Result};

const TEMPLATE: &str = r#"# Marq settings. Changes apply when the window regains focus
# ([ollama] applies after restarting Marq).

[appearance]
# font = "Inter"                  # UI font
# mono_font = "JetBrains Mono"    # editor, code and terminal
# font_size = 13                  # UI, px
# editor_font_size = 14
# palette = "tarn"                # tarn | amber | nord | solarized | rose-pine; used until picked in the 🎨 menu
# mode = "system"                 # system | light | dark

[editor]
# default_mode = "preview"        # preview | edit | split; new notes always open in edit

[terminal]
# shell = "/bin/zsh"              # default: $SHELL
# args = ["-l"]
# font_size = 13
# cursor = "block"                # block | bar | underline

[notifications]
# enabled = true                  # notify when a session finishes, stops with an error or needs an approval

[ollama]
# url = "http://127.0.0.1:11434"   # default: $OLLAMA_HOST, then this

# Keys: a command id = "Key" or ["Key", ...]; "" unbinds. Modifiers: Ctrl, Alt, Shift, Cmd.
# All commands and their keys: ⌘K (command palette).
[keys]
# "terminal.new" = "Cmd+T"
# "tab.next" = ["Cmd+Shift+]", "Ctrl+Tab"]

[keys.tab]      # after Ctrl+T
# "tab.next" = ["L", "Right"]

[keys.pane]     # after Ctrl+P
# "tree.focus" = "H"

[keys.locked]   # Ctrl+G: every key goes to the focused view
# "mode.normal" = "Ctrl+G"
"#;

pub fn path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".marq/config.toml")
}

/// The settings as JSON; empty when there is no file.
pub fn read() -> Result<Value> {
    let Ok(text) = std::fs::read_to_string(path()) else { return Ok(Value::Object(Default::default())) };
    let table: toml::Table = text.parse().map_err(|e| Error::Other(format!("{}: {e}", path().display())))?;
    serde_json::to_value(table).map_err(|e| Error::Other(e.to_string()))
}

/// The config file, created from the template when missing.
pub fn ensure() -> Result<PathBuf> {
    let p = path();
    if !p.exists() {
        std::fs::create_dir_all(p.parent().unwrap())?;
        std::fs::write(&p, TEMPLATE)?;
    }
    Ok(p)
}

/// `[terminal] shell` and `args`.
pub fn terminal_shell() -> (Option<String>, Option<Vec<String>>) {
    let Ok(c) = read() else { return (None, None) };
    let shell = c.pointer("/terminal/shell").and_then(|v| v.as_str()).map(str::to_string).filter(|s| !s.is_empty());
    let args = c
        .pointer("/terminal/args")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect());
    (shell, args)
}

/// `[ollama] url`, for the sidecar's OLLAMA_HOST.
pub fn ollama_url() -> Option<String> {
    read().ok()?.pointer("/ollama/url")?.as_str().map(str::to_string).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    #[test]
    fn template_parses() {
        let t: toml::Table = super::TEMPLATE.parse().unwrap();
        assert!(t["keys"]["tab"].is_table());
    }
}
