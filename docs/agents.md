# Agents and models

> [!WARNING]
> Only **Claude** and **Ollama** are supported for now. Support for other agents may be added later.

## How sessions run

Sessions run with the Claude Agent SDK in a Node sidecar (`sidecar/main.ts`). One sidecar process serves every session and talks to the app with JSON lines over stdio.

- The sidecar uses **your own `claude`** (found through your login shell), so sessions use your Claude Code login and settings (user, project and local).
- A session's process stays alive between turns. Follow-ups sent during a turn are queued, and **Stop** interrupts the current turn.
- Marq's session ID is the Claude session ID. The first turn creates it; later processes resume it.
- Each message is appended to `sessions/.raw/<id>.jsonl`. At the end of a turn, the session Markdown is re-rendered and the result is written back to the origin note. A request moves to `review`.

## Choosing a model

The `model` in a note's frontmatter, or the model picker in the New task dialog, selects the model:

| Value | Runs on |
| --- | --- |
| empty | Claude Code's default |
| `opus`, `sonnet`, `haiku`, or a full Claude model name | Claude |
| `ollama:<name>` | A local model served by Ollama |

The model is stored with the session and used again when it is resumed or summarized.

## Ollama

An `ollama:<name>` session runs Claude Code against Ollama's Anthropic-compatible API, with every model alias and subagent mapped to that model.

1. Install Ollama, pull a model, and start it (`ollama serve`).
2. Pick the model under **Ollama** in the model picker. The list is what your Ollama has pulled.

Choose a model with **tool calling** and a context window of **64k or more**; agent sessions send long prompts and rely on tools.

Marq reads Ollama's URL from `$OLLAMA_HOST`, then `[ollama] url` in [`~/.marq/config.toml`](settings.md) (default `http://127.0.0.1:11434`). Restart Marq after changing it.

Limitations:

- Crews always use Claude.
- Quality depends on the model. Smaller local models may follow tool instructions less reliably than Claude.

## Permission modes

`permission_mode` in the note selects how tool calls are handled (`auto` when empty). Anything that would prompt shows an approval card in the session; see [Sessions](sessions.md).

## Vault tools

Agents get the vault as an MCP server, so they can search and read notes, run mq, save documents, organize folders, and coordinate with other sessions. See [Vault tools for agents](tools.md).
