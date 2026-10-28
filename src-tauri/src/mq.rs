//! mq evaluation for the query view and mq code blocks (SPEC §6, §7).

use std::path::Path;

use serde::Serialize;

use crate::error::{Error, Result};

/// One file's results.
#[derive(Debug, Serialize)]
pub struct FileResult {
    pub file: Option<String>,
    pub items: Vec<String>,
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
    // Non-aggregated `select` yields None for non-matching nodes, so drop empty results (SPEC §7).
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
