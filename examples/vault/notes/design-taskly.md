---
type: note
title: "Design: taskly"
tags: [taskly, design]
aliases: [taskly design]
created: 2026-11-10T10:00:00+09:00
---
# Design: taskly

taskly is a small command-line task list. It keeps its data in one JSON file and has no dependencies.

## Commands

- `add TEXT [--due WHEN]` adds a task.
- `list` shows every task, done ones marked with `x`.
- `done ID` marks a task done.

## Due dates

`WHEN` is `today`, `tomorrow`, `in N days`, a weekday (the next one, never today) or `YYYY-MM-DD`. Anything else is an error that names what was typed.

## Storage

`tasks.json` in the current directory: a list of `{id, text, due, done}`. IDs grow by one and are never reused.

## Open questions

- Should `list` hide done tasks by default?
- Do we want priorities? A single `--priority high|normal|low` would be enough.
- Recurring tasks (`--every week`) are out of scope until the above are settled.
