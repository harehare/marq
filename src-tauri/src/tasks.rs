//! A crew's task list: a board (`type: board`, `crew: <id>`) with one list per status.
//!
//! ```markdown
//! ## Doing
//!
//! - [ ] **T1** Show types on hover — @impl
//!   - branch marq/impl-1a2b3c
//! ```
//!
//! Members change it through tools, and the user on the crew's Tasks tab, which is the board view:
//! moving a card to another list changes its status. Lists not named after a status are kept as they
//! are. Each change reads the file, applies one edit and writes it back.

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
    /// The lists from the first status section on, in file order; the cards of status lists come from `tasks`.
    lists: Vec<boards::List>,
}

fn heading(status: &str) -> String {
    let mut c = status.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn status_of(list: &str) -> Option<&'static str> {
    let l = list.trim().to_lowercase();
    STATUSES.into_iter().find(|s| *s == l)
}

/// Reads a task list. Items are parsed as board cards (see `boards`), so the two formats cannot drift
/// apart; only the lists named after a status hold tasks, and anything before the first one is kept as the head.
pub fn parse(text: &str) -> TaskList {
    let mut head = String::new();
    let mut body = String::new();
    for line in text.lines() {
        let is_status = line.strip_prefix("## ").is_some_and(|h| status_of(h).is_some());
        let dest = if body.is_empty() && !is_status { &mut head } else { &mut body };
        dest.push_str(line);
        dest.push('\n');
    }
    let lists = boards::parse(&body).lists;
    let tasks = lists
        .iter()
        .filter_map(|l| Some((status_of(&l.name)?, &l.cards)))
        .flat_map(|(status, cards)| {
            cards.iter().map(move |c| Task { id: c.id.clone(), title: c.title.clone(), status: status.into(), owner: c.owner.clone(), notes: c.notes.clone() })
        })
        .collect();
    TaskList { head, tasks, lists }
}

/// Writes the list back as a board with every status list, other lists where they were.
pub fn render(list: &TaskList) -> String {
    let cards = |st: &str| -> Vec<boards::Card> {
        list.tasks
            .iter()
            .filter(|t| t.status == st)
            .map(|t| boards::Card {
                id: t.id.clone(),
                title: t.title.replace('\n', " "),
                done: st == "done",
                owner: t.owner.clone(),
                notes: t.notes.clone(),
            })
            .collect()
    };
    let mut lists: Vec<boards::List> = list
        .lists
        .iter()
        .map(|l| match status_of(&l.name) {
            Some(st) => boards::List { name: l.name.clone(), cards: cards(st) },
            None => l.clone(),
        })
        .collect();
    for st in STATUSES {
        if !lists.iter().any(|l| status_of(&l.name) == Some(st)) {
            lists.push(boards::List { name: heading(st), cards: cards(st) });
        }
    }
    boards::render(&boards::Board { head: list.head.clone(), lists, queue: None })
}

/// A new list's file.
pub fn new_file(crew_id: &str, title: &str) -> String {
    let head = format!(
        "---\ntype: board\ncrew: {crew_id}\ntitle: {}\n---\n# {title} — Tasks\n\n\
The crew keeps this list up to date. You can edit it too: move a card to another list to change its status.\n",
        serde_json::to_string(&format!("{title} — Tasks")).unwrap()
    );
    render(&TaskList { head, ..Default::default() })
}

impl TaskList {
    pub fn get_mut(&mut self, id: &str) -> Option<&mut Task> {
        self.tasks.iter_mut().find(|t| t.id.eq_ignore_ascii_case(id))
    }

    /// The next free id: T1, T2…, counting cards in every list.
    pub fn next_id(&self) -> String {
        let n = self
            .tasks
            .iter()
            .map(|t| &t.id)
            .chain(self.lists.iter().flat_map(|l| l.cards.iter().map(|c| &c.id)))
            .filter_map(|id| id.strip_prefix('T')?.parse::<u32>().ok())
            .max()
            .unwrap_or(0);
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
        assert_eq!(again.tasks, list.tasks);
        assert!(render(&list).contains("Intro.\n\n## Todo\n\n- [ ] **T2**"));
        assert!(render(&list).contains("## Done\n\n- [x] **T3** Design\n"));
        // Every status gets a list, so the board shows them all.
        assert!(render(&list).contains("## Blocked"));
    }

    #[test]
    fn other_lists_are_kept() {
        let list = parse("# T\n\n## Todo\n\n- [ ] **T1** A\n\n## Ideas\n\n- [ ] **T5** Later\n");
        assert_eq!(list.tasks.len(), 1);
        assert_eq!(list.next_id(), "T6");
        assert!(render(&list).contains("## Ideas\n\n- [ ] **T5** Later\n"));
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
