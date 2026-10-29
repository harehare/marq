# mq queries

[mq](https://github.com/harehare/mq) is a jq-like query language for Markdown. Because notes, requests and sessions are all Markdown, one query language reaches all of it. Marq embeds mq as a library (`mq-lang`), so there is nothing extra to install for the app.

## mq code blocks

````markdown
```mq input=./notes/*.md
import "section" | nodes | section::find("Done") | section::body()
```
````

In the preview, the block is evaluated when the note changes (debounced 300 ms) and its output appears right below it as rendered Markdown, with a raw toggle.

| Option | Default | Meaning |
| --- | --- | --- |
| `input=<glob>` | the note itself | Files to run over, relative to the note |
| `aggregate=<bool>` | `true` | Same as `mq -A`: run on the whole document, since most queries need it |

With aggregate on, the query runs as `nodes | <query>`; a query that already starts with `nodes` (after any `import "…" |`) is not wrapped again. The `section` module needs `import "section"`.

Evaluation is sandboxed: files can be read only inside the vault, and network, write, run and env access are denied.

## Pinning

**Pin** on an mq block saves its current output after the block:

```markdown
<!-- mq:output -->
...
<!-- /mq:output -->
```

A new pin replaces the earlier one. The preview hides the pinned copy and shows live output, but the copy is plain Markdown in the file, so it also shows up outside Marq. Pinned output is a cache of results, not content, so every mq evaluation leaves it out of its input.

## Built-in queries

The **Query** tab has presets that you can run and edit. They run on the vault's files:

```sh
# Inbox: requests whose status is todo
mq -A 'import "yaml"
  | let fm = yaml::yaml_parse(to_text(first(.)))
  | if (fm["status"] == "todo"): s"${fm["title"]}\t${__FILE__}"' requests/*.md

# Learnings across sessions
mq -A 'import "section" | section::find("Learnings") | section::body()' sessions/*.md

# Commands the agent ran
mq 'select(.code.lang == "tool:Bash") | .code.value' sessions/*.md

# Anchors in a note
mq 'select(.html) | to_text() | capture("marq:anchor id=\"(?<id>[^\"]+)\"")' note.md
```

A few things worth knowing:

- `yaml::yaml_parse(node)` on a frontmatter node returns an array, because the `---` delimiters make it multi-document. Use `to_text()` first to get a dict.
- Without `-A`, `select(...)` yields `None` for non-matching nodes instead of dropping them. Inside the app, queries run on the node array and the `None`s are dropped.
- Nodes carry `position` (line and column), which the editor uses to jump to a result's source.

## Picking what an agent sees

Since everything is Markdown, you choose the context instead of pasting whole files:

- **`context:` in a request.** Attach a whole note by id, or an mq query applied to a file. Marq runs the query when the session starts and puts the result in the prompt:

  ```yaml
  context:
    - note: 0192e...
    - query: 'import "section" | nodes | section::find("Design") | section::body()'
      from: notes/design.md
  ```

- **A selection.** Select text in a note or a session, and choose **Send to session** (see [Sessions](sessions.md)).
- **A section.** **Ask** on a heading sends that section.
- **From the agent's side.** Agents can run read-only queries over the vault with `query_notes`. See [Vault tools for agents](tools.md).
