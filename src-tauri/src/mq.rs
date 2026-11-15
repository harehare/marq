//! mq evaluation for the query view and mq code blocks.

use crate::vault::PathSlash;
use std::path::Path;

use serde::Serialize;

use crate::error::{Error, Result};

/// One file's results.
#[derive(Debug, Serialize)]
pub struct FileResult {
    pub file: Option<String>,
    pub items: Vec<String>,
}

/// A query note saved by `save_query`: what to run and, optionally, what to tell an agent about the results.
#[derive(Debug, PartialEq)]
pub struct Saved {
    pub query: String,
    pub glob: String,
    pub aggregate: bool,
    /// The prompt an agent started from the results begins with.
    pub agent: Option<String>,
    /// One session per file instead of one for all the results.
    pub each: bool,
}

/// A frontmatter value written as a JSON string (as `save_query` does) or bare.
fn fm_text(text: &str, key: &str) -> Option<String> {
    let (fm, _) = crate::vault::split_frontmatter(text);
    let raw = fm?.lines().find_map(|l| l.strip_prefix(key)?.strip_prefix(':').map(|v| v.trim().to_string()))?;
    Some(serde_json::from_str::<String>(&raw).unwrap_or_else(|_| raw.trim_matches(['"', '\'']).to_string()))
}

/// Reads a query note: the first mq block is the query, the frontmatter has the rest.
pub fn read_saved(text: &str) -> Option<Saved> {
    let start = text.find("```mq")?;
    let body = &text[start..];
    let body = &body[body.find('\n')? + 1..];
    let query = body[..body.find("\n```")?].trim().to_string();
    Some(Saved {
        query,
        glob: fm_text(text, "glob").filter(|g| !g.is_empty()).unwrap_or_else(|| "**/*.md".into()),
        aggregate: fm_text(text, "aggregate").as_deref() != Some("false"),
        agent: fm_text(text, "agent").filter(|a| !a.trim().is_empty()),
        each: fm_text(text, "agent_each").as_deref() == Some("true"),
    })
}

/// Longest text from query results that goes into one prompt.
const MAX_CONTEXT: usize = 40_000;

/// Results as prompt text for an agent: the query, then each file's items. Returns the text for all
/// results and the text for each file on its own, in the same order as `results`.
pub fn prompt_context(vault: &Path, query: &str, glob: &str, results: &[FileResult]) -> (String, Vec<String>) {
    let head = format!("The results of this mq query over {glob} (vault: {}):\n\n```mq\n{query}\n```", vault.display());
    let section = |r: &FileResult| {
        let file = r.file.as_deref().map_or("this note".to_string(), |f| {
            Path::new(f).strip_prefix(vault).unwrap_or(Path::new(f)).to_slash()
        });
        format!("### {file}\n\n{}", r.items.join("\n\n"))
    };
    let cut = |text: String| match text.char_indices().nth(MAX_CONTEXT) {
        Some((at, _)) => format!("{}\n\n… (cut, ask for the rest by reading the file)", &text[..at]),
        None => text,
    };
    let all = results.iter().map(&section).collect::<Vec<_>>().join("\n\n");
    (cut(format!("{head}\n\n{all}")), results.iter().map(|r| cut(format!("{head}\n\n{}", section(r)))).collect())
}

/// Whether `query` already starts with `nodes`, after any `import "…" |`, so it is not wrapped again.
fn starts_with_nodes(query: &str) -> bool {
    let mut rest = query.trim_start();
    while rest.starts_with("import ") {
        match rest.split_once('|') {
            Some((_, r)) => rest = r.trim_start(),
            None => return false,
        }
    }
    rest.starts_with("nodes")
}

/// Evaluates `query` with reads limited to `vault`. Other access stays denied.
fn engine(vault: &Path) -> mq_lang::DefaultEngine {
    let io = mq_lang::SandboxedIo::new(mq_lang::NativeIo::default()).allow_read(vec![vault.to_path_buf()]);
    let mut engine = mq_lang::DefaultEngine::with_default_io(mq_lang::Shared::new(io));
    engine.load_builtin_module();
    engine.set_timeout(std::time::Duration::from_secs(10));
    engine
}

fn eval_one(
    engine: &mut mq_lang::DefaultEngine,
    query: &str,
    content: &str,
    file: Option<&Path>,
) -> Result<Vec<String>> {
    if let Some(f) = file {
        let name = f.file_name().unwrap_or_default().to_string_lossy();
        let stem = f.file_stem().unwrap_or_default().to_string_lossy();
        engine.define_string_values(&[
            ("__FILE__", &f.to_string_lossy()),
            ("__FILE_NAME__", &name),
            ("__FILE_STEM__", &stem),
        ]);
    }
    let input = mq_lang::parse_markdown_input(&crate::vault::strip_pinned(content)).map_err(|e| Error::Mq(e.to_string()))?;
    let values = engine.eval(query, input.into_iter()).map_err(|e| Error::Mq(format!("{e:?}")))?;
    // Non-aggregated `select` yields None for non-matching nodes, so drop empty results.
    Ok(values
        .into_iter()
        .filter(|v| !v.is_none())
        .map(|v| v.to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

/// Runs `query` over `content` (the open note) or over vault files matching `glob`.
/// `aggregate` prefixes the query with `nodes |`, which is what `mq -A` does.
pub fn eval(
    vault: &Path,
    query: &str,
    content: Option<&str>,
    glob: Option<&str>,
    base: Option<&Path>,
    aggregate: bool,
) -> Result<Vec<FileResult>> {
    let wrap = aggregate && !starts_with_nodes(query);
    let query = if wrap { format!("nodes | {query}") } else { query.to_string() };
    let mut engine = engine(vault);
    match glob {
        Some(pattern) => {
            let root = base.unwrap_or(vault);
            let full = root.join(pattern);
            let vault = vault.canonicalize()?;
            let mut out = Vec::new();
            for path in glob::glob(&full.to_string_lossy()).map_err(|e| Error::Other(e.to_string()))? {
                let path = path.map_err(|e| Error::Other(e.to_string()))?;
                if !path.canonicalize()?.starts_with(&vault) {
                    return Err(Error::OutsideVault(path.to_string_lossy().into_owned()));
                }
                let text = std::fs::read_to_string(&path)?;
                let rel = path.strip_prefix(root).unwrap_or(&path);
                let items = eval_one(&mut engine, &query, &text, Some(rel))?;
                if !items.is_empty() {
                    out.push(FileResult { file: Some(path.to_string_lossy().into_owned()), items });
                }
            }
            Ok(out)
        }
        None => Ok(vec![FileResult { file: None, items: eval_one(&mut engine, &query, content.unwrap_or(""), None)? }]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_saved_query() {
        let note = "---\ntype: query\ntitle: \"open\"\nglob: \"requests/*.md\"\naggregate: false\nagent: \"Fix each:\\nthen test\"\nagent_each: true\n---\n# open\n\n```mq input=../requests/*.md aggregate=false\nselect(.h)\n```\n";
        assert_eq!(
            read_saved(note),
            Some(Saved { query: "select(.h)".into(), glob: "requests/*.md".into(), aggregate: false, agent: Some("Fix each:\nthen test".into()), each: true })
        );
        assert_eq!(read_saved("no block"), None);
    }

    #[test]
    fn prompt_context_per_file_and_cut() {
        let v = Path::new("/v");
        let r = vec![
            FileResult { file: Some("/v/a.md".into()), items: vec!["one".into(), "two".into()] },
            FileResult { file: Some("/v/b.md".into()), items: vec!["x".repeat(50_000)] },
        ];
        let (all, each) = prompt_context(v, "q", "*.md", &r);
        assert!(all.contains("### a.md\n\none\n\ntwo") && all.contains("(cut"));
        assert_eq!(each.len(), 2);
        assert!(each[0].contains("### a.md") && !each[0].contains("### b.md") && !each[0].contains("(cut"));
    }

    #[test]
    fn inbox_query_over_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("requests")).unwrap();
        std::fs::write(dir.path().join("requests/a.md"), "---\ntitle: A\nstatus: todo\n---\n# a\n").unwrap();
        std::fs::write(dir.path().join("requests/b.md"), "---\ntitle: B\nstatus: done\n---\n# b\n").unwrap();
        let q = r#"import "yaml" | let fm = yaml::yaml_parse(to_text(first(.))) | if (fm["status"] == "todo"): fm["title"]"#;
        let r = eval(dir.path(), q, None, Some("requests/*.md"), None, true).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].items, vec!["A"]);
    }

    #[test]
    fn explicit_nodes_is_not_wrapped_twice() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("s.md"), "# S\n\n## Summary\n\nDid it.\n\n## Other\n\nx\n").unwrap();
        let q = r#"section::find("Summary") | section::body()"#;
        let plain = eval(dir.path(), &format!(r#"import "section" | {q}"#), None, Some("*.md"), None, true).unwrap();
        let explicit = eval(dir.path(), &format!(r#"import "section" | nodes | {q}"#), None, Some("*.md"), None, true).unwrap();
        assert_eq!(plain[0].items, explicit[0].items);
        assert!(explicit[0].items.join("").contains("Did it."));
    }

    #[test]
    fn pinned_output_is_not_queried() {
        let note = "# A\n\n```mq\n.h1\n```\n\n<!-- mq:output -->\n# A\n<!-- /mq:output -->\n";
        let r = eval(Path::new("."), ".h1", Some(note), None, None, false).unwrap();
        assert_eq!(r[0].items, vec!["# A"]);
    }

    #[test]
    fn select_drops_none() {
        let r = eval(Path::new("."), ".h2", Some("# a\n\n## b\n\ntext\n"), None, None, false).unwrap();
        assert_eq!(r[0].items, vec!["## b"]);
    }

    #[test]
    fn reads_outside_vault_are_denied() {
        let dir = tempfile::tempdir().unwrap();
        let r = eval(dir.path(), r#"read_file("/etc/hosts")"#, Some("x"), None, None, false);
        assert!(r.is_err());
    }
}
