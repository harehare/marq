# Inbox and follow-ups

Marq can keep working while you are away, and tell you what needs you when you come back. The **Inbox** at the top of the sidebar is where that happens: it holds what waits for you and what waits its turn to run.

## What is in the Inbox

| Entry | Meaning |
| --- | --- |
| **Needs your approval** | A session asks to run a tool. It stays until you answer it or the session ends |
| **Stopped with an error** | A session ended with an error |
| **Queued** / **Starting…** | Work waiting for room to run: a schedule, a request you queued (from New task or a board card), or a follow-up that fell due |
| **Failed** | Queued work that could not start, with the reason. It stays until you dismiss it |
| **todo** | A request saved for later, and a knowledge draft nobody has checked yet |

Click an entry to open its session (or its note, for work that has not started). **×** dismisses an entry, and the button in the header dismisses them all. A session has one entry per kind: five turns in a row leave one entry with the latest result.

Entries are saved in `.marq/inbox.json` in the vault, so they survive a restart. Done and dismissed ones are kept as history, the newest 200.

## Work queues

Three things start sessions on their own. All of them wait in the Inbox first and start from there:

| Work | How it gets queued |
| --- | --- |
| [Schedule](sessions.md#schedules) | When it falls due. Each schedule waits at most once: a schedule that is still queued or running is not queued again |
| Request | You choose **Queue** in New task or in a [board card](boards.md)'s dialog, or press ▶ **Queue** on a request saved for later. Nothing is queued without it |
| Follow-up | A timer an agent set for itself falls due (see below) |

**Start** in New task, **Ask** and a card's **Start a session** still start at once; only **Queue** waits for room. Schedules and queued requests are worked through one after the other, oldest first; a slot frees when the running session's first turn ends. To run more at once, set **Run at once** under **Settings → Inbox** (`parallel` under `[inbox]` in `config.toml`, 1 to 8). Follow-ups are not counted: they resume a session that already exists, once it is idle, and never in the middle of a turn.

A queued schedule or follow-up cannot be dismissed, because the thing that queued it would queue it again at once. To stop a schedule, switch it off. A queued request can be dismissed.

If Marq closes while something is starting, it is queued again the next time Marq opens, so it is not lost.

## Follow-ups

An agent can ask to be resumed later, for example to check a CI run or see whether someone replied. It uses the `set_followup` tool with how long to wait (`5m`, `2h`, `1d` or `1w`, at least five minutes) and a note to itself about what to check and do next. Then it ends its turn instead of waiting.

- Waiting follow-ups are kept in `.marq/timers.json`, apart from the Inbox: the Inbox holds what is ready now, the timers what is not due yet.
- When one falls due it is queued in the Inbox, and the session is resumed with its note once the session is idle.
- A follow-up fires once. A session can have five waiting. `list_followups` shows them and `cancel_followup` removes one.
- For anything that repeats, use a schedule.

## Standing instructions and progress notes

Two things carry over from one run of a session to the next, besides its transcript:

- **`instructions.md`** at the vault's root holds rules every session should follow ("when a task is done, branch from main and commit", "reply in Japanese"). Open it with **Standing instructions** in the command palette, which creates it with an explanation the first time. Each session reads it when it starts, so keep it short; the first 4,000 characters are used. `<!-- comments -->` in it are not sent. It applies to every session, whatever the project. A project's own `CLAUDE.md` or `AGENTS.md` is a separate file that an agent reads from the repository, as it would outside Marq; use that for rules about one project.
- **Progress notes**: on a long task an agent keeps its own notes with `set_progress` (done, left, where it stopped). They are saved in `.marq/progress/<session>.md` and given back at every later run of that session, including after a follow-up or when the conversation was compacted. They should hold only what cannot be looked up again.

Notes about the project itself are [knowledge notes](vault.md#knowledge-notes), listed by title and read when a session needs them.

## Notifications

A system notification and a Dock badge tell you when a session finishes, stops with an error or needs an approval. The first notification is sent at once; ones that follow within five seconds are combined into a single "N updates" notification, so a schedule that starts several sessions does not bury the screen. Turn them off under **Settings → Notifications**.

A finished turn is not listed here. Sessions with changes to check wait under **Needs review** until you mark them done.
