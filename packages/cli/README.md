# `@androff/tutor-ai` — the `lyceum` CLI

**Alpha.** Commands, flags, and config formats can change between 0.0.x releases.

Socratic tutor & author for self-learning courses. A provider-agnostic coach
that never reveals solutions, never pastes finished code, and uses the course's
own `bun test` suite as the only grader.

## Install

```sh
npm install -g @androff/tutor-ai
```

Requires Bun >= 1.3.14 at runtime (the bundled binary is a Bun script).

## Commands

### `lyceum run [module]`

Open the Socratic TUI. With no argument you get the module picker; pass a
module id, directory, or title to jump straight into a session. Bare `lyceum`
is an alias for `lyceum run`.

TUI keys:

| Key | Action |
| --- | --- |
| Up / Down, Enter | Pick a module |
| Enter | Send the input line |
| Esc | Stop the in-flight run (or go back) |
| Shift+Up / Shift+Down | Scroll the transcript |
| Home / End | Jump to the top / tail of the transcript |
| Ctrl+C | Quit |

While the coach is working, the streaming answer renders incrementally; the
transcript follows the tail automatically (re-engage scroll keys to browse
history, then press Enter to snap back).

### `lyceum new <dir>`

Scaffold a course: `modules/` skeleton, `package.json` with the test script,
`PROGRESS.md`, and an initial module.

```
lyceum new my-course --name "Express Basics" --topic routing --modules 5
```

Options: `--name <name>`, `--topic <topic>` (alias `--title`), `--modules <n>`
(default 3).

### `lyceum add [title]`

Append an empty module to the current course (title defaults to
"Next module"). Use `--topic <topic>` to set the module topic.

### `lyceum draft [title]`

Author a module with the AI agent. If the title matches an existing module,
continue (and finish) that module instead of drafting a new one.

### `lyceum list`

List the course's modules (id, title, topic) and the course root.

### `lyceum test [module]`

Run a module's tests headlessly and print the output. With no argument, runs
every module. The tests are the sole authority on whether an exercise passes —
the coach itself never grades.

### `lyceum provider`

Print the resolved LLM provider (provider id, model, base URL) — useful for
debugging config precedence.

## Environment variables

| Env var | Meaning |
| --- | --- |
| `OPENAI_API_KEY` | API key |
| `OPENAI_BASE_URL` | Base URL for an OpenAI-compatible endpoint |
| `TUTOR_MODEL` | Model id (default `gpt-4o-mini`, or `openrouter/free` on OpenRouter) |
| `OLLAMA_HOST` | Ollama endpoint — implies the Ollama provider |
| `LYCEUM_COURSE` | Course root (defaults to cwd, then `defaultCourse` from config) |
| `XDG_CONFIG_HOME` | Config base dir (default `~/.config`) |

Environment variables always win over the config file, key by key.

## Per-user config (`~/.config/lyceum/`)

```
lyceum/
├── config.json        # { "provider": { apiKey, baseUrl, model }, "defaultCourse", "systemPrompt" }
├── system-prompt.md   # coaching instructions appended to the policy (8 KB cap, wins over the JSON key)
└── skills/            # *.md skills, loaded on demand via list_skills / get_skill
```

`config.json` example:

```json
{
  "provider": { "apiKey": "sk-...", "baseUrl": "http://127.0.0.1:11434/v1", "model": "llama3.2" },
  "defaultCourse": "/home/you/courses/express"
}
```

## Session history

Each module's conversation is persisted to `<course>/session/<module-id>.json`
(a JSON array of `{ who, text, ts }` turns, capped at 500). Reopening a module:

- the stored conversation renders in the transcript, and
- the last 50 turns are seeded into the model so follow-up questions keep
  context.

Writes are best-effort — a read-only course directory never breaks the chat.
Add `session/` to the course's `.gitignore` to keep conversations local.

## Building & publishing

```sh
bun run build       # tsup → dist/bin.js
npm publish         # from packages/cli; runs prepublishOnly (build) first
```

`files` ships only `dist`; npm always includes this README on the package page.
