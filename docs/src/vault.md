# Vault and file formats

The Markdown files in the vault are the source of truth. There is no database to migrate or lose: edit files with any editor, sync them with git or a cloud drive, and Marq picks up the change.

## Layout

```
<vault>/
├─ notes/**.md
├─ scratch/YYYY-MM-DD-HHMM.md          # scratch memos, cleaned up after a while
├─ requests/YYYY-MM-DD-<slug>.md      # tasks and requests
├─ sessions/YYYY-MM-DD-<short-id>.md  # derived from .raw, regenerable
├─ sessions/.raw/<id>.jsonl           # raw agent log (source of truth for a session)
├─ docs/*.md                          # documents written by agents
├─ crews/<name>.md, crews/<name>/     # crews: the note, its task list and documents
├─ boards/<name>.md                   # kanban boards
├─ specs/<slug>.md                    # specs: requirements, design, tasks, acceptance
├─ playbooks/<name>.md                # playbooks: the phases a kind of task runs in
├─ workspaces/<slug>.md               # sets of directories to pick for tasks
├─ phases/<request>-<phase>.md        # each phase's reply, for the phases after it
├─ queries/*.mq                       # saved mq queries
├─ instructions.md                    # standing instructions every session reads
└─ .marq/                             # inbox.json, timers.json, progress/<session>.md (see Inbox)
```

Only `sessions/` and dot folders belong to Marq; `instructions.md` is yours, and [Inbox and follow-ups](inbox.md) says what `.marq/` holds. Everything else can be edited or moved freely, by you or by other editors.

## IDs

- Every ID is a UUID v7, so IDs sort by time.
- A session's ID is the Claude session ID too.
- Links between Marq's own files use IDs, not paths, so renames do not break them. Relative Markdown links are rewritten when you move a note from Marq.

## Frontmatter

```yaml
---
id: 0192f0c4-...            # assigned the first time Marq links something to the file
type: note                  # note | scratch | request | session | crew | board | doc | schedule | glossary | knowledge
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
base: latest                # optional; head (default), latest, or a branch name
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

### Search filters

A search can be narrowed by what the frontmatter says. Pick from the pull-downs under the search box (⇧⌘F), or type the filter yourself; either way it is part of the query:

| Filter | Keeps |
| --- | --- |
| `type:request` | Notes of that `type:` (a file without one is a `note`). `type:session` brings session notes into a notes search |
| `status:todo` | Requests, or sessions, with that status |
| `project:git/mq` | Requests and sessions whose project path contains the text (`~` is expanded) |
| `workspace:docs` | Requests and sessions of a workspace, by part of its title or path. Quote a name with spaces: `workspace:"mq + docs"` |
| `since:2026-11-01`, `since:7d` | Started or created on or after the date (`7d`, `2w`, `3m` and `today` count back from today). Notes without `created:` go by when they were last changed |
| `before:2026-11-01` | Started or created before the date |

Giving one filter twice (`type:request type:doc`) keeps either; different filters must all hold. Filters work without any words, so `type:request status:todo project:mq` lists the open requests of a project.

A session records the workspace its request or crew named, as `workspace:` in the session note. Sessions from before that take it from their request.

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

Whatever an agent writes is a **draft**: it is marked with a dot in the Notes tree, and **Mark reviewed** in the note's properties marks it checked. A new session is given the knowledge notes for its project (and those for no project), marked draft or reviewed, and reads the ones that bear on its task before starting.

## Markers in the body

Markers are HTML comments, so other Markdown viewers show nothing. mq sees them as `.html` nodes.

### Anchor

An anchor ties a session to part of a note. It sits directly under the heading or list item it belongs to:

```markdown
### How should we design this?
<!-- marq:anchor id="0192f0c6-..." -->
```

The anchor's scope is its section: from the heading up to the next heading of the same or a higher level. Linked sessions are found through each session's `origin`, so the marker never changes when you run again.

### Comment

```markdown
Some text you are reviewing.

<!-- comment: This is unclear. @marq make it shorter -->
```

A comment is one line under the text it is about. The preview shows it as a card. Add one by selecting text in the preview and choosing **Comment**, with the comment button on a heading, or with the comment button in the toolbar (edit and split views). You can also type the line yourself.

- **`@marq` in a comment** starts an agent on it as soon as you add the comment. The agent gets the text above the comment and what the comment says.
- Without `@marq` the comment just stays in the note. **Ask marq** on its card sends it later, and **Ask marq (n)** in the toolbar sends all the comments not sent yet to one session.
- Comments on the same note go to one session, so asking often does not pile up sessions: a document an agent wrote sends them to the session that wrote it, and any other note to the session its first comment started. A new session starts when that one is gone or more than half of its context is used, and the later comments go to the new one. ⌥-click **Ask marq** to start a new session yourself.
- A comment that was sent reads `<!-- comment (sent): ... -->` and is shown dimmed. It is not sent again by **Ask marq (n)**, but **Sent** on its card asks again.

Comments are left out of **Copy as Markdown**. Agents list them with `list_comments` (path, line, text, whether it was sent or mentions @marq, and the text it is under), for example to pick up the open `@marq` comments in a schedule.

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

- `## Summary` and `## Learnings` can be edited by hand; agents add to Learnings with `append_learning`. They are kept when the Transcript is regenerated.
- Each tool use is a fenced block with the info string `tool:<ToolName>` and its main argument (path, command, pattern) as the body. Results longer than 20 lines go inside `<details>`.
- Thinking blocks are not rendered.

## Quick notes and scratch memos

- **Quick note** (⌥⌘N) creates `notes/<date>-<time>.md` and opens it for typing, without asking for a name.
- **Scratch memo** (⇧⌘M) does the same in `scratch/`, with `type: scratch`. Memos appear under `scratch/` in the Notes tree.

Both are marked `untitled: true`, so their title is the first heading, or else the first line, of what you write. Rename the file whenever you like.

They clean up after themselves:

- One closed with nothing in it is deleted. So is an empty one left over from before, when the vault opens.
- A scratch memo not changed for `[scratch] keep_days` days (7 by default; 0 never) goes to the Trash when the vault opens.
- To keep a memo, right-click it and choose **Keep as note…**: it moves to the path you give and becomes `type: note`, so it is no longer cleaned up.

## Documents from agents

Reports, plans, designs, investigations and how-tos that an agent writes for you are collected in the vault instead of being left in the working directory. A new document goes to `docs/<date>-<slug>.md` with `type: doc`, `sessions: [<session id>]` and `origin: <request or anchor id>`. An agent can revise only `type: doc` notes, so your hand-written notes are never overwritten. The session view shows each document as a card that opens it.
