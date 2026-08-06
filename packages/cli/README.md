# `@androff/tutor-ai` — the `lyceum` CLI

**Alpha.** Commands, flags, and config formats can change between 0.3.x releases.

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

### `lyceum new <course-name> [--dir <path>]`

Generate a course from a course name. Every positional word is part of the
name, so quoting is never required: `lyceum new make a docker course` works.
Four stages run in sequence:

1. **Clarify** — asks up to 3 questions (level, scope, format) before planning;
   `--yes` skips them.
2. **Research** — the agent searches the web (`web_search`, no API key) and
   writes a sourced findings report to `.lyceum/research.json`. This stage is
   required; `--no-research` opts out for cheap or offline runs.
3. **Plan** — the planner writes the course metadata to `.lyceum/outline.json`
   (`{ name, topic }`) and delivers one module file per module, ordered by
   prerequisite dependencies (the id IS the teaching sequence, difficulty
   ramping intro → core → capstone). The assembled outline is saved to
   `.lyceum/plan.json` as the checkpoint; the per-module delivery files are
   cleaned up afterwards. A model that plans in prose instead of writing files
   is rescued by parsing the outline out of its final text.
4. **Build** — every module is authored in outline order (skeleton created
   first: `exercise/`, `tests/`, `solutions/`), continuing past a failing
   module. Each module's status is recorded in the checkpoint. A module is
   `drafted` only when `tests/index.test.js`, `exercise/index.js`, and
   `README.md` all land under `modules/<dir>/`; anything else is `failed` with
   the missing files named. A model that ends a turn without writing files
   (including turns cut off by the output token limit) is nudged back to
   `write_file` up to 3 times before the module is failed.

Every stage streams its reasoning and tool calls live and prints a
`waiting for model…` line before each model call, so a run never looks hung;
a failed research or plan stage reports exactly what the model got wrong.

```
lyceum new Express routing for beginners --dir ./express-course --modules 4
```

Options:

| Option | Meaning |
| --- | --- |
| `--dir <path>` | Course directory (default: current directory) |
| `--modules <n>` | Override the planned module count (2–8) |
| `--yes` | Skip clarifying questions |
| `--no-research` | Skip the web research stage |
| `--log` | Capture the full model stream to `.lyceum/new.log` (dev/testing) |
| `--stub` | Scaffold an empty course (no LLM) at `--dir` or cwd |

`--log` appends the raw stream of every stage (clarify, research, plan, and
each author session) to `.lyceum/new.log`: reasoning and answer text verbatim,
every tool call with its arguments and outcome, and each run's finish reason —
a fresh file per run, for debugging model behavior. It works in fresh, resume,
and append-mode runs.

**Resume** — re-running the same command rebuilds only modules still
pending/failed; a fully drafted plan is a no-op. A different prompt in a
directory that already has `modules/` appends one module with that title
(today's `add`/`draft` behavior, folded into `new`).

A non-zero exit reports how many modules failed. In append mode the joined
prompt is the new module's title (`lyceum new Query params`).

### `lyceum list`

List the course's modules (id, title, topic) and the course root.

### `lyceum setup`

Interactively write the user config to the XDG config dir
(`$XDG_CONFIG_HOME/lyceum/config.json`, default `~/.config/lyceum/config.json`):
API key, base URL, model, and default course directory. Current values are
shown as defaults, so re-running updates in place; `system-prompt.md` and other
existing settings are preserved. `lyceum provider` afterwards shows the
resolved result — remember env vars (`OPENAI_API_KEY`, `OPENAI_BASE_URL`,
`TUTOR_MODEL`, `OLLAMA_HOST`) still win over the config file.

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

## `.lyceum/` course-generation state

`lyceum new` leaves three files under the course's `.lyceum/` (gitignore it):

| File | Written by | Contents |
| --- | --- | --- |
| `research.json` | research stage | web findings `{ findings: [{ claim, source_url }], caveats }` |
| `outline.json` | plan stage | course `{ name, topic }` |
| `plan.json` | CLI after planning | checkpoint: `{ prompt, outline, modules: [{ id, title, status }] }` — updated by the build stage |

The plan stage also uses `.lyceum/modules/<id>.json` as a per-module delivery
transport while planning; those files are removed once the outline is
assembled. `session/` holds TUI conversation history, one file per module.

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
```

Releases are **tag-driven**: bump `packages/cli/package.json`, commit
(`release(cli): bump to X.Y.Z — …`), then push a `cli-vX.Y.Z` tag. The
publish workflow (`.github/workflows/publish.yml`) builds, sets the version
from the tag, and runs `npm publish --access public` with the `NPM_TOKEN`
secret. `files` ships only `dist`; npm always includes this README on the
package page.
