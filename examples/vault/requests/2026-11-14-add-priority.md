---
type: request
title: Add a priority to tasks
status: todo
project: __PROJECT__
permission_mode: acceptEdits
context:
  - query: 'import "section" | nodes | section::find("Open questions") | section::body()'
    from: notes/design-taskly.md
created: 2026-11-14T09:40:00+09:00
---
# Add a priority to tasks

Add `--priority high|normal|low` to `taskly add` (default `normal`), store it with the task, and show it in `taskly list`, with high priority first. Old `tasks.json` files without a priority must keep working. Add tests.
