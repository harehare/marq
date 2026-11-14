# Examples

A sample vault and a sample project, for trying Marq and for recording its demo.

| Folder | Contents |
| --- | --- |
| `vault/` | Notes, requests, a board, a glossary and a saved query. Open it as the vault in Marq. |
| `project/` | `taskly`, a tiny Python task list with one failing test, which the agents work on. |

## Set up

```sh
examples/setup.sh            # creates ~/marq-demo/vault and ~/marq-demo/project
examples/setup.sh /tmp/demo  # or choose where
```

The script copies both folders, points the requests at the copy of the project, and makes the project a git repository, so each task gets its own worktree. Nothing in `examples/` itself is modified; delete the destination to start over.

Then start Marq (`just dev`), open `<dest>/vault`, and follow **Welcome to the demo vault**. Sessions need the `claude` CLI, logged in.

## Demo script

The recording for the README and the site follows these steps:

1. Open the vault and the welcome note.
2. Open the design note, hover **Open questions**, choose **Ask**, and let the answer come back as a card.
3. Open **Fix "in N days" due dates** and run it. Show the session working in its own worktree.
4. Open **Changes**, read the diff, and comment on a line.
5. Run **Add a priority to tasks** next to it, to show two agents at once.
6. Open the **Sprint** board and drag a card.
