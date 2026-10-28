# Vault and file formats

The Markdown files in the vault are the source of truth. There is no database to migrate or lose: edit files with any editor, sync them with git or a cloud drive, and Marq picks up the change.

## Layout

```
<vault>/
├─ notes/**.md
├─ requests/YYYY-MM-DD-<slug>.md      # tasks and requests
├─ sessions/YYYY-MM-DD-<short-id>.md  # derived from .raw, regenerable
├─ sessions/.raw/<id>.jsonl           # raw agent log (source of truth for a session)
├─ docs/*.md                          # documents written by agents
├─ crews/<name>.md, crews/<name>/     # crews: the note, its task list and documents
├─ boards/<name>.md                   # kanban boards
└─ queries/*.mq                       # saved mq queries
```

Only `sessions/` and dot folders belong to Marq. Everything else can be edited or moved freely, by you or by other editors.

## IDs

- Every ID is a UUID v7, so IDs sort by time.
- A session's ID is the Claude session ID too.
- Links between Marq's own files use IDs, not paths, so renames do not break them. Relative Markdown links are rewritten when you move a note from Marq.

## Frontmatter

```yaml
---
id: 0192f0c4-...            # assigned the first time Marq links something to the file
type: note                  # note | request | session | crew | board | doc
title: ...                  # optional, defaults to the first heading or the filename
created: 2026-10-27T10:12:00+09:00
updated: 2026-10-27T11:40:00+09:00
tags: [mq, lsp]
---
```

Files without frontmatter are treated as `type: note`.

### Request

A request is a note whose body is the prompt:

```yaml
status: todo                # todo | running | review | done | dropped
project: ~/dev/git/mq       # working directory for the agent
model: opus                 # optional; see Agents and models
permission_mode: acceptEdits
worktree: false             # optional; skip the own worktree
branch: marq/my-branch      # optional; name for the worktree's branch
carry_changes: true         # optional; start from your uncommitted changes
sessions: [0192f0c5-...]    # all runs, including retries
context:                    # attached to the prompt at run time
  - note: 0192e...          # a whole note by id
  - query: 'import "section" | nodes | section::find("Design") | section::body()'
    from: notes/design.md   # an mq query applied to a file
```

Status moves like this:

```
todo ──run──▶ running ──exit 0──▶ review ──you──▶ done
                 │
                 └──error/interrupt──▶ todo (the session keeps status error|interrupted)
any ──you──▶ dropped
```

The prompt is the body up to `## Result`, followed by each `context:` entry as a `<context source="...">` block.

## Markers in the body

Markers are HTML comments, so other Markdown viewers show nothing. mq sees them as `.html` nodes.

### Anchor

An anchor ties a session to part of a note. It sits directly under the heading or list item it belongs to:

```markdown
### How should we design this?
<!-- claude:anchor id="0192f0c6-..." -->
```

The anchor's scope is its section: from the heading up to the next heading of the same or a higher level. Linked sessions are found through each session's `origin`, so the marker never changes when you run again.

### Result block

```markdown
<!-- claude:result session="0192f0c5-..." -->
...summary...
<!-- /claude:result -->
```

Marq only rewrites text between these two markers. A request's result block is under `## Result`; an anchor's goes right after its section body.

### Pinned mq output

```markdown
<!-- mq:output -->
...
<!-- /mq:output -->
```

See [mq queries](mq.md).

## Session file

`sessions/.raw/<id>.jsonl` is the raw log, one JSON object per line. The Markdown file is rendered from it and can be regenerated at any time:

````markdown
---
id: 0192f0c5-...
type: session
title: Show types on hover
origin: 0192f0c4-...         # request id or anchor id
origin_path: requests/2026-10-27-hover.md   # a hint; the id is authoritative
cwd: ~/dev/git/mq
model: claude-opus-5-5
status: done                  # running | done | error | interrupted
started: 2026-10-27T10:15:00+09:00
ended: 2026-10-27T10:42:00+09:00
cost_usd: 0.84
files_changed: [crates/mq-lsp/src/hover.rs]
---
## Summary

## Learnings
- ...

## Transcript

### 👤 User
...

### 🤖 Claude
...

```tool:Read
crates/mq-lsp/src/hover.rs
```

<details><summary>result</summary>

...

</details>
````

- `## Summary` and `## Learnings` are filled in by **Summarize**. You can edit them by hand; they are kept when the Transcript is regenerated.
- Each tool use is a fenced block with the info string `tool:<ToolName>` and its main argument (path, command, pattern) as the body. Results longer than 20 lines go inside `<details>`.
- Thinking blocks are not rendered.

## Documents from agents

Reports, plans, designs, investigations and how-tos that an agent writes for you are collected in the vault instead of being left in the working directory. A new document goes to `docs/<date>-<slug>.md` with `type: doc`, `sessions: [<session id>]` and `origin: <request or anchor id>`. An agent can revise only `type: doc` notes, so your hand-written notes are never overwritten. The session view shows each document as a card that opens it.
