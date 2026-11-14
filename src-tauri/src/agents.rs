//! The agents a session can run on: Claude Code through the Agent SDK, and other agents that speak
//! ACP (Agent Client Protocol) over stdio. `[agents.<id>]` in config.toml changes an agent's command
//! or adds another ACP agent.

use serde::Serialize;

use crate::shell::which;

/// The agent a session runs on when its metadata names none.
pub const DEFAULT: &str = "claude";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Agent {
    pub id: String,
    pub label: String,
    /// The command to run, looked up on the shell's PATH. For Claude, the `claude` executable the SDK runs.
    pub command: String,
    pub args: Vec<String>,
}

/// id, label, command, args.
const BUILTIN: &[(&str, &str, &str, &[&str])] = &[
    ("claude", "Claude Code", "claude", &[]),
    ("gemini", "Gemini CLI", "gemini", &["--experimental-acp"]),
    ("codex", "Codex", "codex-acp", &[]),
    ("opencode", "OpenCode", "opencode", &["acp"]),
    ("qwen", "Qwen Code", "qwen", &["--experimental-acp"]),
    ("goose", "Goose", "goose", &["acp"]),
];

/// The built-in agents with config.toml's `[agents]` applied, built-ins first.
pub fn all() -> Vec<Agent> {
    let config = crate::config::read().unwrap_or_default();
    with_config(&config["agents"])
}

fn with_config(table: &serde_json::Value) -> Vec<Agent> {
    let mut out: Vec<Agent> = BUILTIN
        .iter()
        .map(|(id, label, command, args)| Agent {
            id: id.to_string(),
            label: label.to_string(),
            command: command.to_string(),
            args: args.iter().map(|a| a.to_string()).collect(),
        })
        .collect();
    let Some(table) = table.as_object() else { return out };
    for (id, c) in table {
        let i = match out.iter().position(|a| &a.id == id) {
            Some(i) => i,
            None => {
                out.push(Agent { id: id.clone(), label: id.clone(), command: id.clone(), args: vec![] });
                out.len() - 1
            }
        };
        let a = &mut out[i];
        if let Some(s) = c["label"].as_str() {
            a.label = s.to_string();
        }
        if let Some(s) = c["command"].as_str() {
            a.command = s.to_string();
        }
        if let Some(args) = c["args"].as_array() {
            a.args = args.iter().filter_map(|x| x.as_str().map(str::to_string)).collect();
        }
    }
    out
}

/// The agent named `id` (the default when None). An unknown id runs as an ACP agent of that name.
pub fn find(id: Option<&str>) -> Agent {
    let id = id.unwrap_or(DEFAULT);
    all().into_iter().find(|a| a.id == id).unwrap_or_else(|| Agent {
        id: id.to_string(),
        label: id.to_string(),
        command: id.to_string(),
        args: vec![],
    })
}

/// The agent's executable on the shell's PATH, and its arguments.
pub fn command(id: Option<&str>) -> (String, Vec<String>) {
    let a = find(id);
    (which(&a.command), a.args)
}

#[derive(Serialize)]
pub struct AgentInfo {
    #[serde(flatten)]
    pub agent: Agent,
    /// Whether the command was found on the PATH.
    pub installed: bool,
    /// Built into Marq, as opposed to added in config.toml.
    pub builtin: bool,
    /// A built-in agent's command and arguments without config.toml's changes.
    pub default_command: String,
    pub default_args: Vec<String>,
}

/// Every agent, with whether it is installed.
pub fn list() -> Vec<AgentInfo> {
    all()
        .into_iter()
        .map(|agent| {
            let installed = std::path::Path::new(&which(&agent.command)).is_absolute();
            let default = BUILTIN.iter().find(|b| b.0 == agent.id);
            AgentInfo {
                installed,
                builtin: default.is_some(),
                default_command: default.map(|b| b.2.to_string()).unwrap_or_default(),
                default_args: default.map(|b| b.3.iter().map(|a| a.to_string()).collect()).unwrap_or_default(),
                agent,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn config_changes_an_agent_and_adds_others() {
        let agents = with_config(&json!({
            "gemini": {"command": "/opt/bin/gemini", "args": ["--acp"]},
            "kimi": {"label": "Kimi", "command": "kimi", "args": ["acp"]},
        }));
        let gemini = agents.iter().find(|a| a.id == "gemini").unwrap();
        assert_eq!((gemini.label.as_str(), gemini.command.as_str()), ("Gemini CLI", "/opt/bin/gemini"));
        assert_eq!(gemini.args, vec!["--acp"]);
        assert_eq!(agents[0].id, "claude");
        let kimi = agents.last().unwrap();
        assert_eq!((kimi.id.as_str(), kimi.label.as_str(), kimi.args.clone()), ("kimi", "Kimi", vec!["acp".to_string()]));
    }
}
