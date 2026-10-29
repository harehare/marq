//! The vault's vocabulary: which words mean the same thing, so a search for one finds the others.
//!
//! Terms come from glossary notes (`type: glossary`, `glossary.md` by default), one `## ` heading
//! per preferred term:
//!
//! ```markdown
//! ## 認証
//! - aliases: auth, login, authentication
//! - broader: セキュリティ
//! - narrower: OAuth, セッション管理
//!
//! What the term means here.
//! ```
//!
//! and from every note's own title with its `aliases:`. Terms that share a word are one group. A
//! search for a term matches its group and the groups of its narrower terms, one level down.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use crate::vault::{self, FileEntry};

pub const GLOSSARY: &str = "glossary.md";

/// A glossary entry as written.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct Term {
    pub term: String,
    pub aliases: Vec<String>,
    pub broader: Vec<String>,
    pub narrower: Vec<String>,
    pub related: Vec<String>,
}

fn split_list(s: &str) -> Vec<String> {
    s.split([',', '、']).map(|t| t.trim().trim_start_matches('#').to_string()).filter(|t| !t.is_empty()).collect()
}

/// The `## ` entries of a glossary note.
pub fn parse_glossary(text: &str) -> Vec<Term> {
    let mut terms: Vec<Term> = vec![];
    for line in vault::split_frontmatter(text).1.lines() {
        if let Some(h) = line.strip_prefix("## ") {
            terms.push(Term { term: h.trim().to_string(), ..Default::default() });
            continue;
        }
        let Some(t) = terms.last_mut() else { continue };
        let Some((key, value)) = line.trim().strip_prefix("- ").and_then(|l| l.split_once(':')) else { continue };
        let list = split_list(value);
        match key.trim().to_lowercase().as_str() {
            "aliases" | "alias" | "synonyms" => t.aliases.extend(list),
            "broader" => t.broader.extend(list),
            "narrower" => t.narrower.extend(list),
            "related" | "see also" => t.related.extend(list),
            _ => {}
        }
    }
    terms
}

/// Groups of words that mean the same, and what is narrower than each group.
#[derive(Debug, Default)]
pub struct Thesaurus {
    /// Lowercased word → its group.
    group_of: HashMap<String, usize>,
    groups: Vec<Vec<String>>,
    narrower: Vec<Vec<String>>,
}

impl Thesaurus {
    /// From the glossary notes and the notes' titles and aliases in `files`.
    pub fn load(files: &[FileEntry]) -> Self {
        let mut sets: Vec<(Vec<String>, Vec<String>)> = vec![];
        for f in files.iter().filter(|f| f.kind.as_deref() == Some("glossary") || f.rel == GLOSSARY) {
            for t in parse_glossary(&std::fs::read_to_string(&f.path).unwrap_or_default()) {
                let mut words = vec![t.term.clone()];
                words.extend(t.aliases.clone());
                sets.push((words, t.narrower.clone()));
            }
        }
        for f in files.iter().filter(|f| !f.aliases.is_empty()) {
            let title = f.title.clone().unwrap_or_else(|| {
                Path::new(&f.rel).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
            });
            let mut words = vec![title];
            words.extend(f.aliases.clone());
            sets.push((words, vec![]));
        }
        Self::from_sets(sets)
    }

    fn from_sets(sets: Vec<(Vec<String>, Vec<String>)>) -> Self {
        let mut th = Thesaurus::default();
        for (words, narrower) in sets {
            let words: Vec<String> = words.iter().map(|w| w.trim().to_lowercase()).filter(|w| !w.is_empty()).collect();
            // A word already in a group joins the whole set to that group (and merges groups it bridges).
            let mut found: Vec<usize> = words.iter().filter_map(|w| th.group_of.get(w).copied()).collect();
            found.sort();
            found.dedup();
            let g = match found.split_first() {
                Some((&first, rest)) => {
                    for &other in rest.iter().rev() {
                        let moved = std::mem::take(&mut th.groups[other]);
                        let nar = std::mem::take(&mut th.narrower[other]);
                        for w in &moved {
                            th.group_of.insert(w.clone(), first);
                        }
                        th.groups[first].extend(moved);
                        th.narrower[first].extend(nar);
                    }
                    first
                }
                None => {
                    th.groups.push(vec![]);
                    th.narrower.push(vec![]);
                    th.groups.len() - 1
                }
            };
            for w in words {
                if th.group_of.insert(w.clone(), g).is_none() {
                    th.groups[g].push(w);
                }
            }
            th.narrower[g].extend(narrower.iter().map(|n| n.trim().to_lowercase()));
        }
        th
    }

    /// What a search for `word` should match: its group and its narrower terms' groups. Lowercased,
    /// `word` first.
    pub fn expand(&self, word: &str) -> Vec<String> {
        let w = word.to_lowercase();
        let mut out = vec![w.clone()];
        let Some(&g) = self.group_of.get(&w) else { return out };
        let mut add = |x: &String| {
            if !out.contains(x) {
                out.push(x.clone());
            }
        };
        self.groups[g].iter().for_each(&mut add);
        for n in &self.narrower[g] {
            match self.group_of.get(n) {
                Some(&ng) => self.groups[ng].iter().for_each(&mut add),
                None => add(n),
            }
        }
        out
    }

    /// The longest term starting at the front of `words`, as (words it spans, the term).
    fn term_at(&self, words: &[&str]) -> Option<(usize, String)> {
        (2..=words.len().min(4)).rev().find_map(|n| {
            let t = words[..n].join(" ").to_lowercase();
            self.group_of.contains_key(&t).then_some((n, t))
        })
    }
}

/// A query split into what each line must contain, one of each set of alternatives.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Query {
    /// Lowercased; every set must match, any word in a set will do.
    pub words: Vec<Vec<String>>,
    /// `tag:x` or `#x`: notes must carry one of these tags (or a word of their group).
    pub tags: Vec<Vec<String>>,
}

impl Query {
    pub fn parse(query: &str, th: &Thesaurus) -> Self {
        let parts: Vec<&str> = query.split_whitespace().collect();
        let mut q = Query::default();
        let mut i = 0;
        while i < parts.len() {
            let p = parts[i];
            if let Some(tag) = p.strip_prefix("tag:").or_else(|| p.strip_prefix('#').filter(|t| !t.is_empty())) {
                q.tags.push(th.expand(tag));
                i += 1;
            } else if let Some((n, term)) = th.term_at(&parts[i..]) {
                q.words.push(th.expand(&term));
                i += n;
            } else {
                q.words.push(th.expand(p));
                i += 1;
            }
        }
        q
    }

    /// What the expansion added, for showing "also matching".
    pub fn expanded(&self) -> Vec<Vec<String>> {
        self.words.iter().chain(&self.tags).filter(|w| w.len() > 1).cloned().collect()
    }

    pub fn matches_line(&self, line: &str) -> bool {
        let l = line.to_lowercase();
        self.words.iter().all(|alts| alts.iter().any(|w| l.contains(w.as_str())))
    }

    /// Whether every set of alternatives occurs somewhere in `text`, not necessarily on one line.
    pub fn matches_text(&self, text: &str) -> bool {
        let t = text.to_lowercase();
        self.words.iter().all(|alts| alts.iter().any(|w| t.contains(w.as_str())))
    }

    /// How many sets of alternatives occur in `line`.
    pub fn line_score(&self, line: &str) -> usize {
        let l = line.to_lowercase();
        self.words.iter().filter(|alts| alts.iter().any(|w| l.contains(w.as_str()))).count()
    }

    pub fn matches_tags(&self, tags: &[String]) -> bool {
        let tags: Vec<String> = tags.iter().map(|t| t.to_lowercase()).collect();
        self.tags.iter().all(|alts| alts.iter().any(|a| tags.contains(a)))
    }
}

/// `glossary.md` with a first example entry, unless it exists. Returns its path.
pub fn ensure_glossary(vault: &Path) -> std::io::Result<std::path::PathBuf> {
    let path = vault.join(GLOSSARY);
    if !path.exists() {
        std::fs::write(
            &path,
            format!(
                "---\nid: {}\ntype: glossary\ntitle: Glossary\n---\n# Glossary\n\n\
The words this vault uses for things. A search for a term or one of its aliases finds the others, \
and a search for a broader term also finds its narrower ones. Agents use the term itself when they write.\n\n\
## 認証\n- aliases: auth, authentication, login, ログイン\n- broader: セキュリティ\n- narrower: OAuth\n\n\
Checking who the user is. Not authorization (認可).\n",
                vault::new_id()
            ),
        )?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GLOSSARY_TEXT: &str = "---\ntype: glossary\n---\n# Glossary\n\n## 認証\n- aliases: auth, login\n- narrower: OAuth\n\nWho the user is.\n\n## OAuth\n- aliases: OAuth2\n\n## access token\n- aliases: トークン\n";

    fn th() -> Thesaurus {
        let sets = parse_glossary(GLOSSARY_TEXT)
            .into_iter()
            .map(|t| (std::iter::once(t.term).chain(t.aliases).collect(), t.narrower))
            .chain([(vec!["Login flow".into(), "login".into()], vec![])])
            .collect();
        Thesaurus::from_sets(sets)
    }

    #[test]
    fn parses_entries() {
        let terms = parse_glossary(GLOSSARY_TEXT);
        assert_eq!(terms.len(), 3);
        assert_eq!(terms[0], Term { term: "認証".into(), aliases: vec!["auth".into(), "login".into()], narrower: vec!["OAuth".into()], ..Default::default() });
    }

    #[test]
    fn expands_synonyms_and_narrower_terms() {
        let th = th();
        // A note aliased "login" joins the 認証 group.
        assert_eq!(th.expand("Auth"), vec!["auth", "認証", "login", "login flow", "oauth", "oauth2"]);
        assert_eq!(th.expand("oauth2"), vec!["oauth2", "oauth"]);
        assert_eq!(th.expand("other"), vec!["other"]);
    }

    #[test]
    fn parses_queries() {
        let th = th();
        let q = Query::parse("Access Token expiry #auth", &th);
        assert_eq!(q.words, vec![vec!["access token".to_string(), "トークン".into()], vec!["expiry".into()]]);
        assert_eq!(q.tags[0][0], "auth");
        assert!(q.matches_line("トークンの expiry を確認"));
        assert!(!q.matches_line("トークン only"));
        assert!(q.matches_tags(&["認証".into()]));
        assert!(!q.matches_tags(&["db".into()]));
    }
}
