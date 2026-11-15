//! Skills and custom slash commands found on disk, for the `/` completion. Claude Code lists its own
//! through the Agent SDK, but that needs the `claude` executable; this reads the places each agent
//! keeps its skills and commands, so completion works without it and also offers what other agents have.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::vault::split_frontmatter;

/// `SKILL.md` folders, relative to the home directory and to a project directory: (dir, agent).
const SKILL_DIRS: &[(&str, &str)] = &[
    (".claude/skills", "claude"),
    (".codex/skills", "codex"),
    (".gemini/skills", "gemini"),
    (".qwen/skills", "qwen"),
    (".opencode/skill", "opencode"),
    (".opencode/skills", "opencode"),
    // A folder several agents read.
    (".agents/skills", "agents"),
];

/// Single-file commands: (dir, agent, name prefix, extension).
const COMMAND_DIRS: &[(&str, &str, &str, &str)] = &[
    (".claude/commands", "claude", "", "md"),
    (".codex/prompts", "codex", "prompts:", "md"),
    (".gemini/commands", "gemini", "", "toml"),
    (".qwen/commands", "qwen", "", "toml"),
    (".opencode/command", "opencode", "", "md"),
    (".opencode/commands", "opencode", "", "md"),
];

/// Extra places under `~/.config`, which OpenCode uses.
const CONFIG_DIRS: &[(&str, &str, &str, &str)] = &[
    ("opencode/command", "opencode", "", "md"),
    ("opencode/commands", "opencode", "", "md"),
];
const CONFIG_SKILL_DIRS: &[(&str, &str)] = &[("opencode/skill", "opencode"), ("opencode/skills", "opencode")];

/// Skills and commands for `cwd`: project folders (from `cwd` up to the repository root) first, then
/// the user's. Where a name appears twice, the first one wins.
pub fn scan(cwd: &Path) -> Vec<Value> {
    let home = dirs::home_dir();
    let mut roots: Vec<PathBuf> = vec![];
    for dir in cwd.ancestors() {
        if Some(dir) == home.as_deref() || dir.parent().is_none() {
            break;
        }
        roots.push(dir.to_path_buf());
        if dir.join(".git").exists() {
            break;
        }
    }
    if let Some(h) = &home {
        roots.push(h.clone());
    }

    let mut out = vec![];
    let mut seen = HashSet::new();
    let mut add = |c: Value| {
        if seen.insert(c["name"].as_str().unwrap_or_default().to_string()) {
            out.push(c);
        }
    };
    for root in &roots {
        for (dir, agent) in SKILL_DIRS {
            skills(&root.join(dir), agent, &mut add);
        }
        for (dir, agent, prefix, ext) in COMMAND_DIRS {
            commands(&root.join(dir), agent, prefix, ext, &mut add);
        }
    }
    if let Some(cfg) = home.map(|h| h.join(".config")) {
        for (dir, agent) in CONFIG_SKILL_DIRS {
            skills(&cfg.join(dir), agent, &mut add);
        }
        for (dir, agent, prefix, ext) in CONFIG_DIRS {
            commands(&cfg.join(dir), agent, prefix, ext, &mut add);
        }
    }
    out
}

fn entry(name: &str, description: String, hint: String, agent: &str) -> Value {
    json!({"name": name, "description": description, "argumentHint": hint, "builtin": false, "source": agent})
}

/// `<dir>/<skill>/SKILL.md`, named by its frontmatter `name` or else the folder.
fn skills(dir: &Path, agent: &str, add: &mut impl FnMut(Value)) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut folders: Vec<_> = read.flatten().map(|e| e.path()).collect();
    folders.sort();
    for folder in folders {
        // Reading through the path follows symlinks, as skill folders are often linked in.
        let Ok(text) = std::fs::read_to_string(folder.join("SKILL.md")) else { continue };
        let folder_name = folder.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        let (name, description, hint) = front(&text);
        add(entry(name.as_deref().unwrap_or(folder_name), description, hint, agent));
    }
}

/// Command files under `dir`; a file in a subfolder is `folder:name`.
fn commands(dir: &Path, agent: &str, prefix: &str, ext: &str, add: &mut impl FnMut(Value)) {
    for f in walkdir::WalkDir::new(dir).follow_links(true).sort_by_file_name().into_iter().flatten() {
        let p = f.path();
        if !f.file_type().is_file() || p.extension().and_then(|e| e.to_str()) != Some(ext) {
            continue;
        }
        let Ok(rel) = p.strip_prefix(dir) else { continue };
        let name = rel.with_extension("").components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join(":");
        let Ok(text) = std::fs::read_to_string(p) else { continue };
        let (description, hint) = if ext == "toml" { toml_front(&text) } else { let (_, d, h) = front(&text); (d, h) };
        add(entry(&format!("{prefix}{name}"), description, hint, agent));
    }
}

/// (name, description, argument hint) from a Markdown file's frontmatter. Without a description, the first line of text.
fn front(text: &str) -> (Option<String>, String, String) {
    use yaml_rust2::YamlLoader;
    let (fm, body) = split_frontmatter(text);
    let doc = fm.and_then(|f| YamlLoader::load_from_str(f).ok()).and_then(|mut d| (!d.is_empty()).then(|| d.remove(0)));
    let get = |k: &str| doc.as_ref().and_then(|d| d[k].as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let description = get("description").unwrap_or_else(|| {
        body.lines().map(|l| l.trim().trim_start_matches('#').trim()).find(|l| !l.is_empty()).unwrap_or_default().to_string()
    });
    (get("name"), description, get("argument-hint").or_else(|| get("argument_hint")).unwrap_or_default())
}

/// (description, hint) from a TOML command, as Gemini CLI and Qwen Code write them.
fn toml_front(text: &str) -> (String, String) {
    let table: toml::Table = text.parse().unwrap_or_default();
    let description = table.get("description").and_then(|v| v.as_str()).unwrap_or_default().trim().to_string();
    (description, String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_skills_and_commands_of_several_agents() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        std::fs::create_dir_all(p.join(".git")).unwrap();
        std::fs::create_dir_all(p.join(".claude/skills/review")).unwrap();
        std::fs::write(p.join(".claude/skills/review/SKILL.md"), "---\nname: review\ndescription: >\n  Review the diff.\n---\nbody").unwrap();
        std::fs::create_dir_all(p.join(".codex/prompts")).unwrap();
        std::fs::write(p.join(".codex/prompts/fix.md"), "---\ndescription: Fix it\nargument-hint: ISSUE\n---\nx").unwrap();
        std::fs::create_dir_all(p.join(".gemini/commands/git")).unwrap();
        std::fs::write(p.join(".gemini/commands/git/commit.toml"), "description = \"Commit\"\nprompt = \"x\"").unwrap();
        std::fs::create_dir_all(p.join(".agents/skills/plan")).unwrap();
        std::fs::write(p.join(".agents/skills/plan/SKILL.md"), "# Plan\nMake a plan").unwrap();

        let all = scan(p);
        let find = |n: &str| all.iter().find(|c| c["name"] == n).unwrap_or_else(|| panic!("{n} missing in {all:?}"));
        assert_eq!(find("review")["description"], "Review the diff.");
        assert_eq!(find("review")["source"], "claude");
        assert_eq!(find("prompts:fix")["argumentHint"], "ISSUE");
        assert_eq!(find("git:commit")["description"], "Commit");
        assert_eq!(find("plan")["description"], "Plan");
    }
}
