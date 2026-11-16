//! Environment notes: how a project runs next to other sessions, kept as Markdown.
//!
//! ```markdown
//! ---
//! type: environment
//! title: "marq dev"
//! project: ~/dev/git/marq        # a vault note only; a repository's own file is for its project
//! ports: [web, api]              # MARQ_PORT_WEB, MARQ_PORT_API (the first of the session's four ports, and so on)
//! vars:
//!   DATABASE_URL: "postgres://localhost/app_{id}"   # {id} is the session's short id
//! ---
//! ## Rules
//! - Start the dev server on $MARQ_PORT_WEB.
//! - Never deploy without asking.
//! ```
//!
//! The text goes into the session's system prompt. `ports:` names some of the session's reserved
//! ports and `vars:` sets environment variables, both for the agent's process.
//!
//! There are two places for it. A repository's `.marq/environment.md` is shared with whoever clones
//! it and wins; otherwise a vault note of `type: environment` for the project (or for no project)
//! is used. A repository is not trusted to set variables on its own: `PATH`, `NODE_OPTIONS` or
//! `ANTHROPIC_BASE_URL` in a cloned repository's file would take over the agent's process. Its `vars:`
//! are shown to the agent as text instead, and the agent sets them itself where needed, in a command
//! the usual permissions apply to. Ports are only named, so they are always safe to take from it.
//!
//! The user can trust a repository's variables (New task asks). That is remembered in
//! `~/.marq/trusted-environments.json` as the project and the exact variables trusted, so a change to
//! them asks again.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::Result;
use crate::{knowledge, memory, vault};

/// A repository's environment note, relative to the project.
pub const FILE: &str = ".marq/environment.md";
/// The `type` of a vault note that describes an environment.
pub const KIND: &str = "environment";
/// A session reserves this many ports, so this many can be named.
pub const MAX_PORTS: usize = 4;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Environment {
    /// Where it was read from, for the agent and the user to see.
    pub source: String,
    /// Upper-case names: `web` is `MARQ_PORT_WEB`.
    pub ports: Vec<String>,
    /// Unexpanded: `{id}` is still in the values.
    pub vars: Vec<(String, String)>,
    /// Whether `vars` may be set: a vault note is the user's own, a repository's file has to be trusted.
    pub trusted: bool,
    /// From a repository's file rather than a vault note.
    pub from_repo: bool,
    pub body: String,
}

fn port_name(raw: &str) -> Option<String> {
    let n: String = raw.trim().to_uppercase().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    (!n.is_empty()).then_some(n)
}

fn var_name_ok(name: &str) -> bool {
    let mut c = name.chars();
    c.next().is_some_and(|f| f.is_ascii_alphabetic() || f == '_') && c.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn vars_of(fm: &str) -> Vec<(String, String)> {
    use yaml_rust2::{Yaml, YamlLoader};
    let Some(doc) = YamlLoader::load_from_str(fm).ok().and_then(|d| d.into_iter().next()) else { return vec![] };
    let Yaml::Hash(map) = &doc["vars"] else { return vec![] };
    map.iter()
        .filter_map(|(k, v)| {
            let k = k.as_str()?;
            let v = match v {
                Yaml::String(s) => s.clone(),
                Yaml::Integer(n) => n.to_string(),
                Yaml::Boolean(b) => b.to_string(),
                _ => return None,
            };
            var_name_ok(k).then(|| (k.to_string(), v))
        })
        .collect()
}

/// An environment note's text. A note without frontmatter is all body.
pub fn parse(text: &str, source: &str, trusted: bool) -> Environment {
    let (fm, body) = vault::split_frontmatter(text);
    let mut ports: Vec<String> = vec![];
    for p in vault::fm_list(text, "ports").iter().filter_map(|p| port_name(p)) {
        if !ports.contains(&p) && ports.len() < MAX_PORTS {
            ports.push(p);
        }
    }
    let body = memory::clip(&memory::without_comments(body));
    Environment { source: source.into(), ports, vars: fm.map(vars_of).unwrap_or_default(), trusted, from_repo: false, body }
}

/// Where the variables the user trusted are remembered.
fn trust_file() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".marq/trusted-environments.json")
}

/// The variables as one string, to tell whether they are the ones that were trusted.
fn vars_key(vars: &[(String, String)]) -> String {
    let mut lines: Vec<String> = vars.iter().map(|(k, v)| format!("{k}={v}")).collect();
    lines.sort();
    lines.join("\n")
}

fn trusted_vars(file: &Path, project: &str) -> Option<String> {
    let map: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    map[knowledge::norm(project)].as_str().map(str::to_string)
}

/// Remembers that the user trusts the variables in `project`'s environment file as they are now.
pub fn trust_in(file: &Path, project: &str) -> Result<()> {
    let text = std::fs::read_to_string(vault::expand_home(project).join(FILE))?;
    let key = vars_key(&parse(&text, FILE, false).vars);
    let mut map: serde_json::Value = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| serde_json::json!({}));
    map[knowledge::norm(project)] = serde_json::Value::String(key);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(file, map.to_string())?;
    Ok(())
}

pub fn trust(project: &str) -> Result<()> {
    trust_in(&trust_file(), project)
}

/// The environment for a session on `project`: the repository's file, else the vault note for it.
pub fn load(vault: &Path, project: &str) -> Option<Environment> {
    load_with(vault, project, &trust_file())
}

fn load_with(vault: &Path, project: &str, trust: &Path) -> Option<Environment> {
    if let Ok(text) = std::fs::read_to_string(vault::expand_home(project).join(FILE)) {
        let mut e = parse(&text, &format!("{FILE} in the repository"), false);
        e.from_repo = true;
        e.trusted = e.vars.is_empty() || trusted_vars(trust, project).is_some_and(|k| k == vars_key(&e.vars));
        return Some(e);
    }
    let p = knowledge::norm(project);
    let mut general = None;
    for f in vault::list_files(vault).into_iter().filter(|f| f.kind.as_deref() == Some(KIND)) {
        let Ok(text) = std::fs::read_to_string(&f.path) else { continue };
        let np = vault::fm_get(&text, "project").unwrap_or_default();
        if np.is_empty() {
            general.get_or_insert_with(|| parse(&text, &f.rel, true));
        } else if knowledge::norm(&np) == p {
            return Some(parse(&text, &f.rel, true));
        }
    }
    general
}

const FIELDS: &str = "# ports: [web, api]          # MARQ_PORT_WEB and MARQ_PORT_API: names for the ports reserved for each session
# vars:                        # set in the agent's environment ({id} is the session's short id)
#   DATABASE_URL: \"postgres://localhost/app_{id}\"
";

const RULES: &str = "<!-- Everything below goes into the system prompt of each session on the project, so keep it short.
     This comment is not sent. For example:

     - Start the dev server on $MARQ_PORT_WEB, never on 3000.
     - Never deploy without asking. A migration runs on the shared database: check its state before you repeat one.
-->
## Rules
";

/// A vault note for `project`, created with the fields commented out so it can be filled in.
pub fn ensure_note(vault: &Path, project: &str) -> Result<PathBuf> {
    let name: String = vault::expand_home(project)
        .file_name()
        .map(|n| n.to_string_lossy().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect())
        .unwrap_or_default();
    let name = if name.is_empty() { "default".to_string() } else { name };
    let path = vault.join("environments").join(format!("{name}.md"));
    if !path.exists() {
        std::fs::create_dir_all(path.parent().unwrap())?;
        let project_line = if project.trim().is_empty() { String::new() } else { format!("project: {}\n", project.trim()) };
        std::fs::write(&path, format!("---\ntype: {KIND}\ntitle: \"{name} environment\"\n{project_line}{FIELDS}---\n{RULES}"))?;
    }
    Ok(path)
}

/// The project's own `.marq/environment.md`, created the same way, to be committed with the code.
pub fn ensure_repo_file(project: &str) -> Result<PathBuf> {
    let root = vault::expand_home(project);
    if project.trim().is_empty() || !root.is_dir() {
        return Err(crate::error::Error::Other(format!("not a directory: {project}")));
    }
    let path = root.join(FILE);
    if !path.exists() {
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, format!("---\n{FIELDS}---\n{RULES}"))?;
    }
    Ok(path)
}

/// What New task shows about the environment of a project.
#[derive(Debug, Serialize)]
pub struct Status {
    pub source: String,
    pub from_repo: bool,
    pub ports: Vec<String>,
    pub vars: Vec<(String, String)>,
    pub trusted: bool,
}

pub fn status(vault: &Path, project: &str) -> Option<Status> {
    let e = load(vault, project)?;
    Some(Status { source: e.source, from_repo: e.from_repo, ports: e.ports, vars: e.vars, trusted: e.trusted })
}

/// `{id}` replaced by the session's short id.
pub fn expand(value: &str, short: &str) -> String {
    value.replace("{id}", short)
}

/// The system prompt addition: the note's text, the names of its ports and, for a repository's file,
/// the variables it asks for.
pub fn system_prompt(env: &Environment, short: &str) -> String {
    let mut out = format!("\n\nEnvironment for this project ({}). Follow it:", env.source);
    if !env.body.is_empty() {
        out.push_str(&format!("\n{}", env.body));
    }
    if !env.ports.is_empty() {
        let names: Vec<String> = env.ports.iter().map(|p| format!("${{MARQ_PORT_{p}}}")).collect();
        out.push_str(&format!("\nPorts reserved for you by name: {}.", names.join(", ")));
    }
    if !env.trusted && !env.vars.is_empty() {
        let lines: Vec<String> = env.vars.iter().map(|(k, v)| format!("- {k}={}", expand(v, short))).collect();
        out.push_str(&format!(
            "\nThe file asks for these variables. They are not set for you: set them in the commands that need them.\n{}",
            lines.join("\n")
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "---\ntype: environment\nports: [web, api, web, \"d b\", a, b]\nvars:\n  DATABASE_URL: \"postgres://localhost/app_{id}\"\n  BAD-NAME: x\n  PORT: 8080\n---\n<!-- hidden -->\n## Rules\n- Never deploy.\n";

    #[test]
    fn reads_ports_vars_and_the_body() {
        let e = parse(NOTE, "n.md", true);
        // Duplicates are dropped, names are cleaned and at most four are kept.
        assert_eq!(e.ports, ["WEB", "API", "DB", "A"]);
        assert_eq!(e.vars, [("DATABASE_URL".to_string(), "postgres://localhost/app_{id}".to_string()), ("PORT".to_string(), "8080".to_string())]);
        assert!(e.body.contains("Never deploy") && !e.body.contains("hidden"));
        assert_eq!(expand(&e.vars[0].1, "abc12345"), "postgres://localhost/app_abc12345");
    }

    #[test]
    fn a_new_note_is_valid_and_empty_and_is_not_overwritten() {
        let vault = tempfile::tempdir().unwrap();
        let path = ensure_note(vault.path(), "~/dev/git/my app").unwrap();
        assert!(path.ends_with("environments/myapp.md"));
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(vault::fm_get(&text, "type").as_deref(), Some(KIND));
        assert_eq!(vault::fm_get(&text, "project").as_deref(), Some("~/dev/git/my app"));
        let e = parse(&text, "n.md", true);
        assert!(e.ports.is_empty() && e.vars.is_empty());
        assert_eq!(e.body, "## Rules");
        std::fs::write(&path, "mine").unwrap();
        ensure_note(vault.path(), "~/dev/git/my app").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "mine");
        assert!(ensure_note(vault.path(), "").unwrap().ends_with("environments/default.md"));
    }

    #[test]
    fn a_new_repository_file_is_empty_and_needs_a_directory() {
        let repo = tempfile::tempdir().unwrap();
        let project = repo.path().to_string_lossy().to_string();
        let path = ensure_repo_file(&project).unwrap();
        assert!(path.ends_with(".marq/environment.md"));
        let e = parse(&std::fs::read_to_string(&path).unwrap(), "f", false);
        assert!(e.ports.is_empty() && e.vars.is_empty() && e.body == "## Rules");
        assert!(ensure_repo_file("").is_err() && ensure_repo_file("/no/such/dir").is_err());
    }

    #[test]
    fn a_note_without_frontmatter_is_all_body() {
        let e = parse("Start it with make dev.\n", "n.md", false);
        assert!(e.ports.is_empty() && e.vars.is_empty());
        assert_eq!(e.body, "Start it with make dev.");
    }

    #[test]
    fn a_repository_file_wins_over_a_vault_note() {
        let vault = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let project = repo.path().to_string_lossy().to_string();
        std::fs::write(vault.path().join("env.md"), format!("---\ntype: environment\nproject: {project}\n---\nfrom the vault\n")).unwrap();
        let trust = vault.path().join("trust.json");
        let e = load_with(vault.path(), &project, &trust).unwrap();
        assert!(e.trusted && e.body == "from the vault");
        std::fs::create_dir_all(repo.path().join(".marq")).unwrap();
        std::fs::write(repo.path().join(FILE), "from the repository\n").unwrap();
        let e = load_with(vault.path(), &project, &trust).unwrap();
        assert!(e.from_repo && e.body == "from the repository");
    }

    #[test]
    fn trusting_a_repositorys_variables_holds_until_they_change() {
        let vault = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let project = repo.path().to_string_lossy().to_string();
        let trust = vault.path().join("sub/trust.json");
        std::fs::create_dir_all(repo.path().join(".marq")).unwrap();
        let file = repo.path().join(FILE);
        std::fs::write(&file, "---\nvars:\n  A: one\n---\nbody\n").unwrap();
        assert!(!load_with(vault.path(), &project, &trust).unwrap().trusted);
        trust_in(&trust, &project).unwrap();
        assert!(load_with(vault.path(), &project, &trust).unwrap().trusted);
        // Editing the text around the variables does not ask again; changing a variable does.
        std::fs::write(&file, "---\nvars:\n  A: one\n---\nnew body\n").unwrap();
        assert!(load_with(vault.path(), &project, &trust).unwrap().trusted);
        std::fs::write(&file, "---\nvars:\n  A: two\n---\nnew body\n").unwrap();
        assert!(!load_with(vault.path(), &project, &trust).unwrap().trusted);
        // A file without variables has nothing to trust.
        std::fs::write(&file, "just text\n").unwrap();
        assert!(load_with(vault.path(), &project, &trust).unwrap().trusted);
    }

    #[test]
    fn a_vault_note_for_another_project_is_not_used() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(vault.path().join("env.md"), "---\ntype: environment\nproject: /somewhere/else\n---\nno\n").unwrap();
        assert!(load(vault.path(), "/not/it").is_none());
    }

    #[test]
    fn a_repositorys_variables_are_text_not_environment() {
        let e = parse(NOTE, "n.md", false);
        let p = system_prompt(&e, "abc12345");
        assert!(p.contains("DATABASE_URL=postgres://localhost/app_abc12345") && p.contains("not set for you"));
        assert!(!system_prompt(&parse(NOTE, "n.md", true), "abc12345").contains("DATABASE_URL"));
    }
}
