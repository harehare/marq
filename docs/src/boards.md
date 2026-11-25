# Boards

A board is a Markdown note, `boards/<name>.md` with `type: board`. Each `## ` heading is a list, and each checklist item a card:

```markdown
## Todo

- [ ] **T1** Write docs — @me
  - start with the README

## Done

- [x] **T2** Add logo
```

Editing the Markdown is editing the board: moving an item under another heading moves the card, items written without `**T<n>**` get an id on the next save, and moving a card into a list named Done checks it. New boards start with Todo, Doing and Done.

The board tab shows the lists as columns (**Board**) or stacked (**List**). Drag cards between and within lists; lists can be added, renamed, moved and removed when empty. **Markdown** opens the note itself.

Open a card to work on it with an agent:

- **Start a session** opens New task with the card as the prompt (its text and linked notes, and where the card lives so the agent keeps it up to date with `board_update_card`). When the session starts, the card moves to a list named Doing, if the board has one.
- **Queue** puts the card in the [Inbox](inbox.md) as a request, with the project and permissions your last task used, and it starts when there is room. With no earlier task to go on, it opens New task instead.

Agents read and change boards with `list_boards`, `read_board`, `search_cards` (cards across boards by label, owner or done), `board_add_card`, `board_update_card` and `board_add_list`. See [Vault tools for agents](tools.md).
