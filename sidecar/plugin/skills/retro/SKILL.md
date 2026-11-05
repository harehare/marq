---
name: retro
description: Look back at the task just done and record what is worth keeping, so later sessions start smarter. Use when the user asks for a retro or retrospective, what was learned, or to wrap up a task.
---

# Retro

Go over this session (and, if the task spanned several, `search_sessions` for the others) and keep what the next agent on this project would want to know.

1. List what cost time or went wrong: wrong assumptions, commands that failed, files that were hard to find, checks that failed and why.
2. Turn each into a short, specific learning: what, why, and where in the code. Drop what anyone would know, what the code makes obvious, and one-off details. Use the glossary's terms (`glossary.md`).
3. Record each with `append_learning`. Marq's knowledge gardening merges them into knowledge notes, and once the user has reviewed those, the promotion schedule writes them into the repository's CLAUDE.md and skills.
4. If a learning means the project's instructions are wrong right now (CLAUDE.md, AGENTS.md, a skill), tell the user what to change instead of waiting for that.

Reply with the learnings you recorded, one line each.
