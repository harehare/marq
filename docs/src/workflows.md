# Workflows

A request can check its own work, run in phases (its own, or a playbook's), run sandboxed, and start from a spec. Set these in the request note's frontmatter (or in the New task dialog, under **How it runs and is checked**), or on a schedule.

```markdown
---
type: request
project: ~/dev/git/mq
verify: pnpm check          # run after each turn; exit 0 passes
verify_retries: 3           # failures sent back before giving up (default 2)
verify_retry: fresh         # retry in a new session on the same worktree
verify_timeout: 10m         # default 10m
verify_model: opus          # the acceptance check's model
playbook: bug-fix           # a playbook's phases and what each is told
phases: [research, plan, implement]   # or only the phases
phase_gate: auto            # start the next phase on its own
sandbox: strict             # on | strict
---
## Request

Show types on hover.

## Acceptance

- Hovering a variable shows its inferred type.
- `cargo test -p mq-lsp` passes.
```

## Checks

With `verify:`, Marq runs the command in the session's directory (its worktree) when a turn ends. If the command fails, Marq sends its output back to the agent as a new message and checks again after that turn. This repeats until the check passes, or until it has failed `verify_retries` + 1 times. The session shows each check with its output, and the request records `verified: passed` or `verified: failed`.

A project can set a default check in its [environment note](sessions.md#a-check-for-every-request), so each request does not repeat it; `verify: off` in a request skips that default.

The command runs with your shell's `PATH` and `CI=1`, and stops after `verify_timeout`. It runs in the session's working directory, not in a [workspace](sessions.md#workspaces)'s other directories; to check those too, use `cd` in the command. It runs code from the worktree that the agent changed (a package script, a Makefile). So when the session is sandboxed, the check is sandboxed too: on macOS it runs under `sandbox-exec`, with writes allowed only in the working directory, the workspace's other directories and temp folders, no network except localhost, and no access to `~/.ssh`, `~/.aws` or gcloud credentials.

The check is taken from the note when the session starts, so editing the note during the session does not change it.

### Acceptance criteria

`## Acceptance` is left out of the prompt. After the agent's turn, and after the `verify:` command passes, Marq starts a separate session in the same directory. That session reads the task and the criteria, checks the work without changing files, and ends with `VERDICT: PASS` or `VERDICT: FAIL`. A failure goes back to the implementing agent as observed problems, and counts as a failed attempt like a failed command.

The criteria are not shown to the implementing agent, but they are not secret either: an agent that reads the request note can see them. Their purpose is to check the work against what you want, not against what the agent decided it means.

### Fresh retries (a loop)

`verify_retry: fresh` retries a failed check in a **new session** on the same request and worktree. That session gets the request again with only the last failure, not the whole conversation so far. This repeats until the check passes or the retries run out. Set a high `verify_retries` and a strict check to keep an agent working on a task with a clean context each time.

## Phases

`phases:` runs the request as a series of sessions, each with a fresh context:

- `research` investigates without changing files and ends with its findings.
- `plan` writes a step-by-step plan without changing files.
- The last phase (e.g. `implement`) does the work, building on the earlier phases.
- Other names work too: each phase is told to do only its part.

Each phase's reply is saved in `phases/<request>-<phase>.md`, and every later phase gets those documents as context. All phases share one worktree: the first phase creates it and the later ones reuse it. `verify:` and acceptance criteria apply to the last phase only.

After each phase, the request waits in review, and its **Ask** button reads **Start plan** (or whichever phase is next). With `phase_gate: auto`, the next phase starts on its own. `phase:` in the note is the next phase to run; change it to repeat a phase or skip one.

## Playbooks

A playbook says how a kind of task is done: which phases it runs in, and what each phase's session is told. A bug fix is not done like a refactor, so each gets its own.

A playbook is a note in `playbooks/` with `type: playbook`. Each `## ` heading is a phase, in order, and the text under it is that phase's instructions:

```markdown
---
type: playbook
title: Bug fix
description: Reproduce the bug, find its cause, then fix it
phase_gate: auto            # optional: for requests that do not set their own
---
# Bug fix

Make the smallest change the evidence supports.

## reproduce

model: haiku

Reproduce the bug before anything else. Do not fix anything yet.
End your reply with the command that reproduces it and its output.

## fix

Fix the cause, then run the reproduction again.
```

- The text above the first phase is given to every phase.
- `model:` and `effort:` lines at the top of a section apply to that phase's session, before the request's own `model` and `effort`.
- A section with no text gets the instructions `phases:` would give a phase of that name.
- `<!-- comments -->` are left out of what the agent is told.
- A playbook without any `## ` section adds its text to the request and runs it in one session.

A request names a playbook with `playbook: bug-fix` (the file's name, its title or its path). In the New task dialog, type `/` in the prompt and pick one, or choose it under **Checks**. The playbook then shows as a chip above the prompt, and the prompt is the task itself and anything else this run should do. Backspace at the start of the prompt, or the chip's **×**, removes it.

When the request first starts, the playbook's phases are written into its `phases:`, and it runs as described under [Phases](#phases). The list stays as written from then on: editing the playbook later changes what the remaining phases are told, not which phases the request runs. A request that sets its own `phases:` keeps them and takes only the instructions from the playbook, so `phases: [fix]` runs one phase of it.

Marq comes with four playbooks:

| Playbook | Phases |
| --- | --- |
| `plan-first` | research → plan → implement |
| `bug-fix` | reproduce → diagnose → fix |
| `refactor` | baseline → change |
| `organize` | survey → propose → move → index → verify |

**New playbook** in the command palette writes a note to fill in. Give it the name of one of Marq's own to get a copy to edit; a note in `playbooks/` replaces Marq's playbook of the same name.

## Sandbox

`sandbox: on` runs the agent's Bash commands in Claude Code's OS sandbox (Seatbelt on macOS, bubblewrap on Linux). Writes are allowed only in the working directory, network access goes through the sandbox's domain allowlist, and sandboxed commands run without approval cards. A command that fails in the sandbox may ask to run outside it. `sandbox: strict` takes that option away.

When the sandbox cannot run, the session fails instead of running unsandboxed. Only Claude sessions have a sandbox; an ACP agent with `sandbox:` set refuses to start.

Read, Edit and Write are not sandboxed, so keep secrets out of reach with permission rules in Claude Code's settings (for example, `"deny": ["Read(./.env*)"]`). Domains, extra writable paths and excluded commands also go in Claude Code's own `sandbox` settings: see [Sandboxing](https://code.claude.com/docs/en/sandboxing).

Schedules start sessions that nobody watches. `[sandbox] unattended = "on"` in [config.toml](settings.md) sandboxes every one of them that does not set its own sandbox.

## Specs

A spec is a note in `specs/` (`type: spec`) that describes a change before anyone builds it:

```markdown
---
type: spec
title: "Show types on hover"
project: ~/dev/git/mq
verify: cargo test -p mq-lsp
sandbox: on
board: boards/show-types-on-hover.md   # set by Break down
---
# Show types on hover

## Requirements
- WHEN the user hovers a variable THE editor SHALL show its inferred type.

## Design
…

## Tasks
- [ ] Infer types for let bindings
- [ ] Return them from the hover handler

## Acceptance
- Hovering `x` in `let x = 1` shows `number`.
```

Create one with **New spec** in the command palette, or ask an agent to write one with `/marq:spec`.

**Break down**, in the spec's toolbar, puts each open item under `## Tasks` on the spec's board as a card that links to the spec. The first time, it also creates the board and records it in `board:`. Running it again adds only the new items.

## Skills

Every Claude session loads Marq's plugin, `sidecar/plugin/`, with these skills:

| Skill | What it does |
| --- | --- |
| `/marq:spec` | Investigates, writes a spec with `write_spec`, and after you agree, breaks it down with `spec_to_board` |
| `/marq:retro` | Looks back at the task and records what is worth keeping with `append_learning` |

## From learnings to the repository

Sessions record learnings. The **knowledge gardening** schedule merges them into knowledge notes, and once you mark a knowledge note `status: reviewed`, Marq tells sessions on that project about it.

A note that names a file the project no longer has, or that was reviewed more than 90 days ago, is listed to sessions with a warning to check it against the code first, and the gardening run is told to fix or drop what no longer holds.

To turn what keeps going wrong into rules, use **Knowledge: propose rules, checks and setup from repeated failures** in the command palette. It creates a weekly schedule that looks at failed checks, denied approvals and errors across recent sessions, keeps the causes that repeat, and writes a document of proposals: an `ask` or `deny` rule, a `setup:` step, a better `verify:` command, or a line in a playbook. It changes nothing itself; you decide which to adopt.

To make that knowledge reach every agent, not only sessions started from Marq, use **Knowledge: write reviewed knowledge into a project's CLAUDE.md and skills** in the command palette. It creates a weekly schedule that is turned off at first. Set its `project:` and `enabled: true`. Each run works in a new worktree: it folds the reviewed knowledge notes into the project's CLAUDE.md (or AGENTS.md) and `.claude/skills/`, and opens a pull request with gh.
