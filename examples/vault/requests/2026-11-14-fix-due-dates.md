---
type: request
title: Fix "in N days" due dates
status: todo
project: __PROJECT__
permission_mode: acceptEdits
context:
  - query: 'import "section" | nodes | section::find("Due dates") | section::body()'
    from: notes/design-taskly.md
created: 2026-11-14T09:30:00+09:00
---
# Fix "in N days" due dates

`python -m taskly add x --due "in 3 days"` gives a date one day too early. Find the cause, fix it, and make the tests pass. Keep the change small and do not touch unrelated code.
