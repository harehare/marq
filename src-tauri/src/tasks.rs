//! A crew's task list: a Markdown file with one section per status (SPEC §21).
//!
//! ```markdown
//! ## Doing
//!
//! - [ ] **T1** Show types on hover — @impl
//!   - branch marq/impl-1a2b3c
//! ```
//!
//! Members change it through tools and the user can edit it by hand: moving an item to another
//! section changes its status. Each change reads the file, applies one edit and writes it back.

use serde::Serialize;

pub const STATUSES: [&str; 5] = ["todo", "doing", "review", "blocked", "done"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub status: String,
    pub owner: Option<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Default, PartialEq)]
pub struct TaskList {
    /// Everything before the first status section (frontmatter, title and any text), kept as is.
    pub head: String,
    pub tasks: Vec<Task>,
}

fn heading(status: &str) -> String {
    let mut c = status.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

pub fn parse(text: &str) -> TaskList {
    let mut list = TaskList::default();
    let mut status: Option<String> = None;
    let mut in_head = true;
    for line in text.lines() {
        if let Some(h) = line.strip_prefix("## ") {
            let h = h.trim().to_lowercase();
            if STATUSES.contains(&h.as_str()) {
                in_head = false;
                status = Some(h);
                continue;
            }
        }
        if in_head {
            list.head.push_str(line);
            list.head.push('\n');
            continue;
        }
        let Some(st) = &status else { continue };
        if let Some(item) = line.strip_prefix("- [ ] ").or_else(|| line.strip_prefix("- [x] ")) {
            let Some(rest) = item.strip_prefix("**") else { continue };
            let Some((id, rest)) = rest.split_once("**") else { continue };
            let rest = rest.trim();
            let (title, owner) = match rest.rsplit_once(" — @") {
                Some((t, o)) if !o.contains(' ') => (t.trim(), Some(o.trim().to_string())),
                _ => (rest, None),
            };
            list.tasks.push(Task { id: id.trim().into(), title: title.into(), status: st.clone(), owner, notes: vec![] });
        } else if let Some(note) = line.strip_prefix("  - ")
            && let Some(t) = list.tasks.last_mut()
        {
            t.notes.push(note.trim().into());
        }
    }
    list
}

pub fn render(list: &TaskList) -> String {
    let mut out = list.head.trim_end().to_string();
    for st in STATUSES {
        out.push_str(&format!("\n\n## {}\n", heading(st)));
        for t in list.tasks.iter().filter(|t| t.status == st) {
            let check = if st == "done" { "x" } else { " " };
            let owner = t.owner.as_ref().map(|o| format!(" — @{o}")).unwrap_or_default();
            out.push_str(&format!("\n- [{check}] **{}** {}{owner}", t.id, t.title.replace('\n', " ")));
            for n in &t.notes {
                out.push_str(&format!("\n  - {}", n.replace('\n', " ")));
            }
        }
    }
    out.push('\n');
    out
}

/// A new list's file.
pub fn new_file(crew_id: &str, title: &str) -> String {
    format!(
        "---\ntype: crew-tasks\ncrew: {crew_id}\ntitle: {}\n---\n# {title} — Tasks\n\n\
The crew keeps this list up to date. You can edit it too: move an item to another section to change its status.\n",
        serde_json::to_string(&format!("{title} — Tasks")).unwrap()
    )
}

impl TaskList {
    pub fn get_mut(&mut self, id: &str) -> Option<&mut Task> {
        self.tasks.iter_mut().find(|t| t.id.eq_ignore_ascii_case(id))
    }

    /// The next free id: T1, T2…
    pub fn next_id(&self) -> String {
        let n = self.tasks.iter().filter_map(|t| t.id.strip_prefix('T')?.parse::<u32>().ok()).max().unwrap_or(0);
        format!("T{}", n + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_list() {
        let text = "---\ntype: crew-tasks\n---\n# X — Tasks\n\nIntro.\n\n## Todo\n\n- [ ] **T2** Write tests — @tester\n  - after T1\n\n## Doing\n\n- [ ] **T1** Hover types — @impl\n\n## Done\n\n- [x] **T3** Design\n";
        let list = parse(text);
        assert_eq!(list.tasks.len(), 3);
        assert_eq!(list.tasks[0], Task { id: "T2".into(), title: "Write tests".into(), status: "todo".into(), owner: Some("tester".into()), notes: vec!["after T1".into()] });
        assert_eq!(list.tasks[2].owner, None);
        assert_eq!(list.next_id(), "T4");
        let again = parse(&render(&list));
        assert_eq!(again, list);
        assert!(render(&list).contains("Intro.\n\n## Todo\n\n- [ ] **T2**"));
        assert!(render(&list).contains("## Done\n\n- [x] **T3** Design\n"));
    }

    #[test]
    fn a_hand_moved_item_takes_its_section_status() {
        let list = parse("# T\n\n## Review\n\n- [ ] **T1** A — @impl\n");
        assert_eq!(list.tasks[0].status, "review");
    }
}
