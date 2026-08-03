# lyceum — Socratic self-learning tutor

**Alpha.** APIs, storage layouts, and behavior can change without notice between
0.0.x releases.

A provider-agnostic coach that drives interactive courses through **Socratic
tutoring**: it never reveals solutions or pastes finished code, it asks what you
tried / predicted / observed before answering, and it uses the course's own
`bun test` suite as the only grader.

Built as a small monorepo of packages on top of the `@cline/*` SDK agent loop.

## Features

- **Per-module TUI coach** — open a course, pick a module, chat with the tutor.
  Live streaming responses, scrollable transcript (Shift+Up/Down, Home/End).
- **Spoiler-proof** — `solutions/` and `project/solution.js` are mechanically
  gated: the model's `read_file` and `grep` tools refuse them at the code level,
  not just in the prompt.
- **`run_tests` is the only grader** — the coach runs the module's own test
  suite and relays the output verbatim.
- **Module context** — each session injects the module README and your exercise
  stub into the prompt, so the coach actually reads the question.
- **Session history** — every conversation is stored under the course at
  `session/<module-id>.json`; reopening a module resumes the transcript and
  seeds the coach with your earlier turns.
- **Per-user coaching config** — XDG config dir with provider defaults, custom
  coaching instructions, and on-demand skills (see Configuration).
- **Provider-agnostic** — OpenAI-compatible endpoints, OpenRouter, Ollama; env
  vars or config file.
- **Course authoring** — scaffold courses, append modules, and draft modules
  with the AI agent.

## Quick start

```sh
npm install -g @androff/tutor-ai
# point at a course (defaults to the current directory)
lyceum --course /path/to/course    # or: cd /path/to/course && lyceum
```

Inside the TUI: pick a module, ask about the exercise, let the coach run the
tests. `Esc` stops a run, `Ctrl+C` quits.

## Course layout

A course is any directory with `modules/`, one subdirectory per module:

```
course/
├── package.json          # `bun test` is the referee for the whole course
├── modules/
│   └── 01-routing/
│       ├── README.md     # module notes (injected into the coach's context)
│       ├── exercises/    # student exercise files
│       ├── tests/        # the grader (or legacy: tests inside exercises/)
│       ├── project/      # optional capstone (solution.js is gated)
│       └── solutions/    # NEVER shown to the coach
├── session/              # per-module conversation history (gitignore this)
└── PROGRESS.md           # Learn-in-Public progress notes (optional)
```

Scaffold a new course with `lyceum new <dir>`.

## CLI

| Command | Description |
| --- | --- |
| `lyceum` / `lyceum run [module]` | Open the Socratic TUI (optionally straight into a module) |
| `lyceum new <dir>` | Scaffold a course |
| `lyceum add [title]` | Append a module to the course |
| `lyceum draft [title]` | Author a module with the AI agent |
| `lyceum list` | List the course modules |
| `lyceum test [module]` | Run a module's tests headlessly |
| `lyceum provider` | Show the resolved LLM provider |

See [packages/cli/README.md](packages/cli/README.md) for the full CLI reference
(commands, environment variables, config layout, TUI keys).

## Configuration

Resolution order: environment variables win, then the per-user config file.

| Env var | Meaning |
| --- | --- |
| `OPENAI_API_KEY` | API key |
| `OPENAI_BASE_URL` | Base URL for an OpenAI-compatible endpoint |
| `TUTOR_MODEL` | Model id |
| `OLLAMA_HOST` | Ollama endpoint (implies the Ollama provider) |
| `LYCEUM_COURSE` | Course root (defaults to cwd, then `defaultCourse` from config) |
| `XDG_CONFIG_HOME` | Config base dir (default `~/.config`) |

Per-user config lives in `~/.config/lyceum/` (or `$XDG_CONFIG_HOME/lyceum`):

```
lyceum/
├── config.json        # { "provider": { apiKey, baseUrl, model }, "defaultCourse", "systemPrompt" }
├── system-prompt.md   # coaching instructions (wins over the config.json key, 8 KB cap)
└── skills/            # *.md skills, loaded on demand (list_skills / get_skill)
```

## Session history

Each module keeps its conversation in `<course>/session/<module-id>.json`
(JSON array of `{ who, text, ts }` turns, capped at 500). On resume the last 50
turns are seeded into the model, so follow-up questions carry context. Writes
are best-effort: a read-only course directory never breaks the chat.

Add `session/` to your course's `.gitignore` so the conversations stay local.

## Monorepo layout

```
packages/
├── agents/   # Socratic agent loop: session, policy (system prompt), authoring
├── cli/      # `lyceum` — commander CLI + pi-tui TUI (published as @androff/tutor-ai)
├── core/     # spoiler-gated tools: run_tests, read_file, grep
├── llms/     # provider gateway (openai / openrouter / ollama)
└── shared/   # course-layout resolver, module types, spoiler checks
```

## Development

Requires Bun >= 1.3.14.

```sh
bun install
bun test            # 46 tests: spoiler gates, skills, config, provider, history, transcript
bun run typecheck   # tsc --noEmit (typescript 6.0.3, strict)
bun run lint        # eslint packages
bun run smoke       # live agent-loop smoke against a mock SSE server
bun run build       # bundle packages/cli with tsup
```

`AGENTS.md` at the repo root is the tutor's own Socratic policy — the load-bearing
spec for how the coach behaves.

### Releases

`packages/cli` is published to npm as `@androff/tutor-ai`. Version bumps land on
`main`; the `cli-v<semver>` tag triggers the publish workflow (see
`.github/workflows/publish.yml`). CI runs the full check suite on every push.
