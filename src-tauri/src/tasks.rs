//! A crew's task list: a Markdown file with one section per status.
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

use crate::boards;

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

/// Reads a task list. Items are parsed as board cards (see `boards`), so the two formats cannot drift
/// apart; only the lists named after a status count, and anything before the first one is kept as the head.
pub fn parse(text: &str) -> TaskList {
    let mut head = String::new();
    let mut body = String::new();
    for line in text.lines() {
        let is_status = line.strip_prefix("## ").is_some_and(|h| STATUSES.contains(&h.trim().to_lowercase().as_str()));
        let dest = if body.is_empty() && !is_status { &mut head } else { &mut body };
        dest.push_str(line);
        dest.push('\n');
    }
    let tasks = boards::parse(&body)
        .lists
        .into_iter()
        .map(|l| (l.name.to_lowercase(), l.cards))
        .filter(|(status, _)| STATUSES.contains(&status.as_str()))
        .flat_map(|(status, cards)| {
            cards.into_iter().map(move |c| Task { id: c.id, title: c.title, status: status.clone(), owner: c.owner, notes: c.notes })
        })
        .collect();
    TaskList { head, tasks }
}

pub fn render(list: &TaskList) -> String {
    let lists = STATUSES
        .iter()
        .map(|st| boards::List {
            name: heading(st),
            cards: list
                .tasks
                .iter()
                .filter(|t| t.status == *st)
                .map(|t| boards::Card {
                    id: t.id.clone(),
                    title: t.title.replace('\n', " "),
                    done: *st == "done",
                    owner: t.owner.clone(),
                    notes: t.notes.clone(),
                })
                .collect(),
        })
        .collect();
    boards::render(&boards::Board { head: list.head.clone(), lists })
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

    #[test]
    fn text_before_the_first_status_is_kept() {
        let text = "# T\n\n## Background\n\nWhy.\n\n## Todo\n\n- [ ] **T1** A\n";
        let list = parse(text);
        assert_eq!(list.tasks.len(), 1);
        assert!(render(&list).contains("## Background\n\nWhy.\n\n## Todo\n\n- [ ] **T1** A\n"));
    }
}
