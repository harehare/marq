---
name: spec
description: Write a spec for a feature or change before building it, then break it into board cards that a Marq queue can run. Use when the user asks for a spec, requirements, a design to agree on first, or to plan a large change as separate tasks.
---

# Write a spec

A spec is a note in the user's vault (`specs/`, `type: spec`). The user reviews it; then its tasks become cards on a board, and a board queue can run each card in its own session with the spec as context.

## 1. Find out what is needed

- Read the code the change touches, and search the vault (`search_notes`, `search_sessions`) for earlier notes, decisions and sessions on the topic.
- Ask the user only what you cannot find out. Note open questions in the spec instead of guessing.

## 2. Write it with `write_spec`

`content` has these sections, in this order:

- `## Requirements`: what the change must do, one testable statement per item. Prefer `WHEN <situation> THE <part> SHALL <behaviour>`. Cover errors and edge cases, not only the happy path.
- `## Design`: how it fits the codebase: the parts to change, data and interfaces, and each decision with why. Name real files and functions.
- `## Tasks`: a checklist (`- [ ] …`). One item is one session's work: it can be done and checked on its own, in order. Start each with a verb and name the area, e.g. `- [ ] Parse type annotations in the LSP hover handler`. Avoid tasks that only make sense together.
- `## Acceptance`: how to tell the whole change is done, as observable behaviour (commands to run and what they print, what the user sees). The agents doing the tasks do not get this section in their prompt; a separate session checks their work against it. Do not repeat the requirements word for word.

Pass `verify` when the project has a command that checks a change (tests, type checks, lint), e.g. `pnpm check` or `cargo test`. It runs after every task's turn, and a failure goes back to the agent.

## 3. Hand it over

Tell the user the spec's path and ask them to review it. Only when they agree, or asked you to go ahead, call `spec_to_board` and tell them the board: putting the board's queue on a list (Queue in the board header) runs the cards.
