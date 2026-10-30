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
# content_width = "wide"          # normal | wide | full: how wide notes and conversations are

[editor]
# default_mode = "preview"        # preview | edit | split; new notes always open in edit
# autosave = true                 # save notes shortly after typing stops, and when they close

[tabs]
# pinned_layout = "inline"        # inline | row: pinned tabs first in the tab bar, or in a row above the others

[terminal]
# shell = "/bin/zsh"              # default: $SHELL
# args = ["-l"]
# font_size = 13
# cursor = "block"                # block | bar | underline

[notifications]
# enabled = true                  # notify when a session finishes, stops with an error or needs an approval

[agents]                          # agents other than Claude talk ACP (Agent Client Protocol)
# gemini = { command = "gemini", args = ["--experimental-acp"] }
# kimi = { label = "Kimi", command = "kimi", args = ["acp"] }   # any other ACP agent

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

/// Sets `section.key` values, keeping the file's comments and layout; null removes a key.
pub fn write(changes: &serde_json::Map<String, Value>) -> Result<()> {
    let p = ensure()?;
    let text = edit(&std::fs::read_to_string(&p)?, changes).map_err(|e| Error::Other(format!("{}: {e}", p.display())))?;
    std::fs::write(&p, text)?;
    Ok(())
}

fn edit(text: &str, changes: &serde_json::Map<String, Value>) -> Result<String> {
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(|e| Error::Other(format!("{e}")))?;
    for (key, v) in changes {
        let (section, name) = key.split_once('.').ok_or_else(|| Error::Other(format!("not a section.key: {key}")))?;
        let table = doc
            .entry(section)
            .or_insert(toml_edit::table())
            .as_table_mut()
            .ok_or_else(|| Error::Other(format!("[{section}] is not a table")))?;
        match to_toml(v) {
            Some(v) => table.insert(name, toml_edit::value(v)),
            None => table.remove(name),
        };
    }
    Ok(doc.to_string())
}

fn to_toml(v: &Value) -> Option<toml_edit::Value> {
    Some(match v {
        Value::Bool(b) => (*b).into(),
        Value::Number(n) => n.as_i64().map(Into::into).or_else(|| n.as_f64().map(Into::into))?,
        Value::String(s) => s.as_str().into(),
        Value::Array(a) => toml_edit::Value::Array(a.iter().filter_map(to_toml).collect()),
        Value::Null | Value::Object(_) => return None,
    })
}

/// Shells listed in /etc/shells, then common ones found on the shell PATH but not listed there
/// (Homebrew does not add them).
pub fn shells() -> Vec<String> {
    let mut found: Vec<String> = std::fs::read_to_string("/etc/shells")
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('/'))
        .map(str::to_string)
        .collect();
    for name in ["zsh", "bash", "fish", "nu", "elvish", "xonsh", "pwsh"] {
        let p = crate::shell::which(name);
        if p.starts_with('/') && !found.contains(&p) {
            found.push(p);
        }
    }
    found
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

    #[test]
    fn edit_keeps_comments() {
        let changes = serde_json::json!({
            "terminal.shell": "/bin/bash",
            "terminal.args": ["-l", "-i"],
            "terminal.font_size": 14,
            "notifications.enabled": false,
            "editor.default_mode": null,
            "new.key": "x",
        });
        let out = super::edit(super::TEMPLATE, changes.as_object().unwrap()).unwrap();
        assert!(out.contains("# Marq settings.") && out.contains("# cursor = \"block\""), "{out}");
        let t: toml::Table = out.parse().unwrap();
        assert_eq!(t["terminal"]["shell"].as_str(), Some("/bin/bash"));
        assert_eq!(t["terminal"]["args"].as_array().unwrap().len(), 2);
        assert_eq!(t["terminal"]["font_size"].as_integer(), Some(14));
        assert_eq!(t["notifications"]["enabled"].as_bool(), Some(false));
        assert_eq!(t["new"]["key"].as_str(), Some("x"));
        assert!(t["keys"]["tab"].is_table());
        let again = super::edit(&out, serde_json::json!({"terminal.shell": null}).as_object().unwrap()).unwrap();
        assert!(again.parse::<toml::Table>().unwrap()["terminal"].get("shell").is_none());
    }
}
