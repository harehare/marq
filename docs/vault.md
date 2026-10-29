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
type: note                  # note | request | session | crew | board | doc | schedule | glossary | knowledge
title: ...                  # optional, defaults to the first heading or the filename
created: 2026-10-27T10:12:00+09:00
updated: 2026-10-27T11:40:00+09:00
tags: [mq, lsp]             # or a YAML list; a leading # is dropped
aliases: [language server]  # other names for the note
---
```

Files without frontmatter are treated as `type: note`.

Tags show in the preview's properties; click one to search for it. Aliases find the note in Quick Open and count as synonyms of its title in search.

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

## Links between notes

Link to another note with `[[Name]]`, where the name is the note's title, file name, vault-relative path (without `.md`) or one of its `aliases:`, ignoring case. `[[Name|shown text]]` changes the text and `[[Name#Heading]]` points into the note. Typing `[[` in the editor suggests notes. Relative Markdown links (`[plan](../docs/plan.md)`) work too and count the same.

In the preview, a link to a note that does not exist yet is dashed; click it to create `notes/<Name>.md`. Moving or renaming a note updates relative links and `[[links]]` that name it by file name or path.

The note's right panel (the panel button in the toolbar) shows, under its sessions:

- **Linked from**: lines in other notes that link here.
- **Mentioned in**: lines that name the note (its title, an alias or the file name) without linking. The link button turns the mention into `[[Name]]`, keeping the words as written.
- **Links to** and **Not written yet**: where this note links, and its `[[links]]` that name no note, with a button to create one.

Session logs are left out, since they quote everything. Agents link with `[[Name]]` too, open notes by the same names with `read_note`, and see these lists with `note_links`.

## Glossary

`glossary.md` (or any note with `type: glossary`) lists the words the vault uses for things, so a search for one finds the others. Open it with **Glossary** in the command palette; it is created with an example the first time. Each `## ` heading is a preferred term:

```markdown
## 認証
- aliases: auth, authentication, login, ログイン
- broader: セキュリティ
- narrower: OAuth

Checking who the user is. Not authorization (認可).
```

- **aliases**: other words for the same thing. Searching any of them matches all of them, together with notes whose `aliases:` share a word.
- **narrower**: more specific terms. Searching a term also finds its narrower terms (one level), so 認証 finds OAuth but not the other way round.
- **broader**, **related**: kept for people and agents reading the glossary.

Search lists what each word was widened to. `tag:name` (or `#name`) keeps notes with that tag, and tags are widened the same way. Agents search the same way, are told to write with the preferred terms, and can tag the documents they save.

## Knowledge notes

Sessions write what they learn under their own `## Learnings`, so the same lesson ends up in many places and old ones never go away. Knowledge notes in `knowledge/` gather it by topic instead:

```markdown
---
type: knowledge
title: "Worktrees"
project: "~/dev/git/marq"   # the project it applies to; empty for the whole vault
status: draft               # draft until you mark it reviewed
sources: [0192f0c5-..., …]  # sessions whose learnings it took in
---
Worktrees live in .marq/worktrees/<id> …

## Sources

- [[sessions/2026-10-29-fix-cleanup|Fix the worktree cleanup]] (2026-10-29)
```

**Knowledge: merge session learnings into knowledge notes** in the command palette sets up a daily [schedule](sessions.md#schedules) that does the merging: it lists the learnings no knowledge note has taken in yet (`list_learnings`), merges them topic by topic into knowledge notes (`write_knowledge`), drops duplicates and what no longer holds, and keeps contradictions with reviewed notes under `## Open questions` instead of overwriting them. Edit the schedule note to change when it runs or what it does; **Run now** on it in the sidebar runs it at once.

Whatever an agent writes is a **draft**: it shows in the Inbox, and **Mark reviewed** in the note's properties marks it checked. A new session is given the knowledge notes for its project (and those for no project), marked draft or reviewed, and reads the ones that bear on its task before starting.

## Markers in the body

Markers are HTML comments, so other Markdown viewers show nothing. mq sees them as `.html` nodes.

### Anchor

An anchor ties a session to part of a note. It sits directly under the heading or list item it belongs to:

```markdown
### How should we design this?
<!-- marq:anchor id="0192f0c6-..." -->
```

The anchor's scope is its section: from the heading up to the next heading of the same or a higher level. Linked sessions are found through each session's `origin`, so the marker never changes when you run again.

### Result block

```markdown
<!-- marq:result session="0192f0c5-..." -->
...summary...
<!-- /marq:result -->
```

Marq only rewrites text between these two markers. A request's result block is under `## Result`; an anchor's goes right after its section body.

Notes written by earlier versions use `claude:anchor` and `claude:result`. Marq still reads them, and replaces an old result block with a `marq:` one the next time that session writes back.

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
project: ~/dev/git/mq         # the worktree's repository, else cwd; knowledge is grouped by it
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

### 🤖 Assistant
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
