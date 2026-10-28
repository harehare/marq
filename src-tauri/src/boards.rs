//! Boards: kanban lists in `boards/<name>.md` (`type: board`), editable as Markdown (SPEC §23).
//!
//! ```markdown
//! ## Doing
//!
//! - [ ] **T1** Show types on hover — @me
//!   - a note
//! ```
//!
//! Each `## ` heading is a list; moving an item under another heading moves it. Items written by
//! hand without `**T<n>**` get an id on the next save.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::vault;

/// One change at a time, so concurrent edits never drop each other.
static LOCK: Mutex<()> = Mutex::new(());

const DEFAULT_LISTS: [&str; 3] = ["Todo", "Doing", "Done"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Card {
    pub id: String,
    pub title: String,
    pub done: bool,
    pub owner: Option<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct List {
    pub name: String,
    pub cards: Vec<Card>,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Board {
    /// Everything before the first list (frontmatter, title, text), kept as is.
    #[serde(skip)]
    pub head: String,
    pub lists: Vec<List>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Change {
    /// The list to move the card to.
    pub list: Option<String>,
    /// Position in that list; the end when absent.
    pub index: Option<usize>,
    pub owner: Option<String>,
    pub title: Option<String>,
    pub done: Option<bool>,
    /// Appended as a nested item.
    pub note: Option<String>,
}

fn parse_card(item: &str, done: bool) -> Card {
    let (id, rest) = match item.strip_prefix("**").and_then(|r| r.split_once("**")) {
        Some((id, rest)) => (id.trim().to_string(), rest.trim()),
        None => (String::new(), item.trim()),
    };
    let (title, owner) = match rest.rsplit_once(" — @") {
        Some((t, o)) if !o.contains(' ') => (t.trim(), Some(o.trim().to_string())),
        _ => (rest, None),
    };
    Card { id, title: title.to_string(), done, owner, notes: vec![] }
}

pub fn parse(text: &str) -> Board {
    let mut b = Board::default();
    for line in text.lines() {
        if let Some(h) = line.strip_prefix("## ") {
            b.lists.push(List { name: h.trim().to_string(), cards: vec![] });
            continue;
        }
        let Some(list) = b.lists.last_mut() else {
            b.head.push_str(line);
            b.head.push('\n');
            continue;
        };
        let item = line.strip_prefix("- [ ] ").map(|i| (i, false)).or_else(|| {
            line.strip_prefix("- [x] ").or_else(|| line.strip_prefix("- [X] ")).map(|i| (i, true))
        });
        if let Some((item, done)) = item {
            list.cards.push(parse_card(item, done));
        } else if let Some(note) = line.strip_prefix("  - ")
            && let Some(c) = list.cards.last_mut()
        {
            c.notes.push(note.trim().into());
        }
    }
    // Ids for items written by hand.
    let mut next = b.max_id();
    for c in b.lists.iter_mut().flat_map(|l| l.cards.iter_mut()).filter(|c| c.id.is_empty()) {
        next += 1;
        c.id = format!("T{next}");
    }
    b
}

pub fn render(b: &Board) -> String {
    let mut out = b.head.trim_end().to_string();
    for l in &b.lists {
        out.push_str(&format!("\n\n## {}", l.name));
        if !l.cards.is_empty() {
            out.push('\n');
        }
        for c in &l.cards {
            let owner = c.owner.as_ref().map(|o| format!(" — @{o}")).unwrap_or_default();
            out.push_str(&format!("\n- [{}] **{}** {}{owner}", if c.done { "x" } else { " " }, c.id, c.title));
            for n in &c.notes {
                out.push_str(&format!("\n  - {}", n.replace('\n', " ")));
            }
        }
    }
    out.push('\n');
    out
}

impl Board {
    fn max_id(&self) -> u32 {
        self.lists.iter().flat_map(|l| &l.cards).filter_map(|c| c.id.strip_prefix('T')?.parse().ok()).max().unwrap_or(0)
    }

    fn list_index(&self, name: &str) -> Result<usize> {
        let n = name.trim().to_lowercase();
        self.lists.iter().position(|l| l.name.to_lowercase() == n).ok_or_else(|| {
            let names: Vec<_> = self.lists.iter().map(|l| l.name.as_str()).collect();
            Error::Other(format!("no list \"{name}\"; lists: {}", names.join(", ")))
        })
    }

    /// Removes a card, returning it with the list it was in.
    fn take(&mut self, id: &str) -> Result<(usize, usize, Card)> {
        for (li, l) in self.lists.iter_mut().enumerate() {
            if let Some(ci) = l.cards.iter().position(|c| c.id.eq_ignore_ascii_case(id)) {
                return Ok((li, ci, l.cards.remove(ci)));
            }
        }
        Err(Error::Other(format!("no card {id}")))
    }
}

/// Reads, edits and writes a board under the lock.
fn edit<T>(path: &Path, f: impl FnOnce(&mut Board) -> Result<T>) -> Result<T> {
    let _lock = LOCK.lock().unwrap();
    let mut b = read(path)?;
    let out = f(&mut b)?;
    std::fs::write(path, render(&b))?;
    Ok(out)
}

pub fn read(path: &Path) -> Result<Board> {
    Ok(parse(&std::fs::read_to_string(path)?))
}

/// Creates `boards/<name>.md` with Todo, Doing and Done. Returns its path.
pub fn create(vault: &Path, name: &str) -> Result<PathBuf> {
    let name = name.trim().trim_end_matches(".md");
    if name.is_empty() {
        return Err(Error::Other("a board needs a name".into()));
    }
    let rel = format!("boards/{name}.md");
    if name.split('/').any(|p| p == "..") {
        return Err(Error::OutsideVault(rel));
    }
    std::fs::create_dir_all(vault.join(&rel).parent().unwrap())?;
    let path = vault::resolve(vault, &rel)?;
    if path.exists() {
        return Err(Error::Other(format!("already exists: {rel}")));
    }
    let title = Path::new(name).file_name().unwrap_or_default().to_string_lossy().into_owned();
    let b = Board {
        head: format!(
            "---\nid: {}\ntype: board\ntitle: {}\ncreated: {}\n---\n# {title}\n",
            vault::new_id(),
            serde_json::to_string(&title).unwrap(),
            vault::now()
        ),
        lists: DEFAULT_LISTS.iter().map(|n| List { name: n.to_string(), cards: vec![] }).collect(),
    };
    std::fs::write(&path, render(&b))?;
    Ok(path)
}

/// Every board with its lists and card counts.
pub fn list(vault: &Path) -> Vec<Value> {
    vault::list_files(vault)
        .into_iter()
        .filter(|f| f.kind.as_deref() == Some("board"))
        .map(|f| {
            let b = read(Path::new(&f.path)).unwrap_or_default();
            let lists: Vec<_> = b.lists.iter().map(|l| json!({"name": l.name, "cards": l.cards.len()})).collect();
            json!({"path": f.path, "rel": f.rel, "title": f.title, "lists": lists})
        })
        .collect()
}

/// A board by path, vault-relative path, title or file name; the only board when `board` is empty.
pub fn find(vault: &Path, board: &str) -> Result<PathBuf> {
    let boards: Vec<_> = vault::list_files(vault).into_iter().filter(|f| f.kind.as_deref() == Some("board")).collect();
    let b = board.trim().trim_end_matches(".md").to_lowercase();
    let found = if b.is_empty() && boards.len() == 1 {
        boards.first()
    } else {
        boards.iter().find(|f| {
            let stem = Path::new(&f.rel).file_stem().map(|s| s.to_string_lossy().to_lowercase());
            f.path.trim_end_matches(".md").to_lowercase() == b
                || f.rel.trim_end_matches(".md").to_lowercase() == b
                || f.title.as_deref().map(str::to_lowercase).as_deref() == Some(b.as_str())
                || stem.as_deref() == Some(b.as_str())
        })
    };
    found.map(|f| PathBuf::from(&f.path)).ok_or_else(|| {
        let names: Vec<_> = boards.iter().map(|f| f.rel.as_str()).collect();
        Error::Other(format!("no board \"{board}\"; boards: {}", if names.is_empty() { "none".into() } else { names.join(", ") }))
    })
}

/// Adds a card to `list` (the first list when absent).
pub fn add(path: &Path, title: &str, list: Option<&str>, owner: Option<&str>, note: Option<&str>) -> Result<Card> {
    let title = title.trim().replace('\n', " ");
    if title.is_empty() {
        return Err(Error::Other("a card needs a title".into()));
    }
    edit(path, |b| {
        let li = match list.filter(|l| !l.trim().is_empty()) {
            Some(l) => b.list_index(l)?,
            None if b.lists.is_empty() => return Err(Error::Other("the board has no lists".into())),
            None => 0,
        };
        let card = Card {
            id: format!("T{}", b.max_id() + 1),
            title,
            done: false,
            owner: owner.map(str::trim).filter(|o| !o.is_empty()).map(str::to_string),
            notes: note.map(str::trim).filter(|n| !n.is_empty()).map(|n| vec![n.to_string()]).unwrap_or_default(),
        };
        b.lists[li].cards.push(card.clone());
        Ok(card)
    })
}

/// Moves and edits a card. Moving into a list named Done checks it, moving out unchecks it.
pub fn update(path: &Path, id: &str, change: Change) -> Result<Card> {
    edit(path, |b| {
        let (from, at, mut c) = b.take(id)?;
        let to = match &change.list {
            Some(l) => b.list_index(l)?,
            None => from,
        };
        if to != from {
            c.done = b.lists[to].name.eq_ignore_ascii_case("done");
        }
        if let Some(d) = change.done {
            c.done = d;
        }
        if let Some(o) = &change.owner {
            c.owner = Some(o.trim().to_string()).filter(|o| !o.is_empty());
        }
        if let Some(t) = change.title.as_deref().map(|t| t.trim().replace('\n', " ")).filter(|t| !t.is_empty()) {
            c.title = t;
        }
        if let Some(n) = change.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            c.notes.push(n.to_string());
        }
        let cards = &mut b.lists[to].cards;
        let index = change.index.unwrap_or(if to == from { at } else { cards.len() }).min(cards.len());
        cards.insert(index, c.clone());
        Ok(c)
    })
}

pub fn remove(path: &Path, id: &str) -> Result<()> {
    edit(path, |b| b.take(id).map(|_| ()))
}

pub fn add_list(path: &Path, name: &str) -> Result<()> {
    let name = name.trim().to_string();
    edit(path, |b| {
        if name.is_empty() || b.list_index(&name).is_ok() {
            return Err(Error::Other(format!("list \"{name}\" is empty or exists")));
        }
        b.lists.push(List { name, cards: vec![] });
        Ok(())
    })
}

pub fn rename_list(path: &Path, from: &str, to: &str) -> Result<()> {
    let to = to.trim().to_string();
    edit(path, |b| {
        let i = b.list_index(from)?;
        if to.is_empty() || b.list_index(&to).is_ok_and(|j| j != i) {
            return Err(Error::Other(format!("list \"{to}\" is empty or exists")));
        }
        b.lists[i].name = to;
        Ok(())
    })
}

/// Moves a list by `delta` places.
pub fn move_list(path: &Path, name: &str, delta: i32) -> Result<()> {
    edit(path, |b| {
        let i = b.list_index(name)?;
        let j = (i as i32 + delta).clamp(0, b.lists.len() as i32 - 1) as usize;
        let l = b.lists.remove(i);
        b.lists.insert(j, l);
        Ok(())
    })
}

/// Moves a list to position `index`.
pub fn move_list_to(path: &Path, name: &str, index: usize) -> Result<()> {
    edit(path, |b| {
        let i = b.list_index(name)?;
        let l = b.lists.remove(i);
        b.lists.insert(index.min(b.lists.len()), l);
        Ok(())
    })
}

/// Removes an empty list.
pub fn remove_list(path: &Path, name: &str) -> Result<()> {
    edit(path, |b| {
        let i = b.list_index(name)?;
        if !b.lists[i].cards.is_empty() {
            return Err(Error::Other(format!("list \"{name}\" still has cards; move them first")));
        }
        b.lists.remove(i);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hand_written_items_get_ids_and_round_trip() {
        let b = parse("# B\n\n## Ideas\n\n- [ ] **T3** Old — @me\n  - n\n- [ ] new one\n\n## Done\n\n- [x] finished\n");
        assert_eq!(b.lists.len(), 2);
        assert_eq!(b.lists[0].cards[1].id, "T4");
        assert_eq!(b.lists[1].cards[0], Card { id: "T5".into(), title: "finished".into(), done: true, owner: None, notes: vec![] });
        assert_eq!(parse(&render(&b)), b);
    }

    #[test]
    fn creates_finds_and_edits_a_board() {
        let dir = tempfile::tempdir().unwrap();
        let v = &dir.path().canonicalize().unwrap();
        let p = create(v, "work").unwrap();
        assert_eq!(find(v, "").unwrap(), p);
        assert_eq!(find(v, "Work").unwrap(), p);
        let t = add(&p, "Write docs", None, Some("me"), Some("start with SPEC")).unwrap();
        assert_eq!(t.id, "T1");
        add_list(&p, "Review").unwrap();
        move_list(&p, "Review", -1).unwrap();
        let t = update(&p, "t1", Change { list: Some("done".into()), ..Default::default() }).unwrap();
        assert!(t.done);
        assert!(update(&p, "T1", Change { list: Some("later".into()), ..Default::default() }).is_err());
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains("type: board") && text.contains("## Review\n\n## Done\n\n- [x] **T1** Write docs — @me\n  - start with SPEC"));
        assert!(remove_list(&p, "Done").is_err());
        rename_list(&p, "Review", "In review").unwrap();
        move_list_to(&p, "In review", 0).unwrap();
        move_list_to(&p, "In review", 2).unwrap();
        remove(&p, "T1").unwrap();
        remove_list(&p, "Done").unwrap();
        let names: Vec<_> = read(&p).unwrap().lists.into_iter().map(|l| l.name).collect();
        assert_eq!(names, ["Todo", "Doing", "In review"]);
    }
}
