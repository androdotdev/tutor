# PLAN.md — "Self-Learning Tutor" CLI

## Goal
A provider-agnostic CLI (`tutor`) that drives ANY interactive course (this repo and future ones built per `SKILL.md`) through **Socratic tutoring** and **Feynman technique**, using the course's own `bun test` suite as the referee. It never reveals solutions or pastes finished code; it asks what the student tried / predicted / observed before answering, and tracks Learn-in-Public progress in `PROGRESS.md`.

**Build planned only — this doc, not the code.**

## Runtime & dependencies
- Bun 1.x, plain TypeScript, ESM. No build step for running (`bun run`).
- Packages mirror Cline's real SDK layout; all pinned **`@cline/*@0.0.69`** (npm).
  - `@cline/cli` is a re-export — skip it; we ship our own `tutor` bin. No `replace-lib` needed.
- Verified SDK surface we build on (v0.0.69):
  - `@cline/sdk` = `export * from "@cline/core"` (we mirror this as our `sdk` package).
  - `@cline/agents`: `createAgentRuntime`, `createAgent`, `Agent`/`AgentRuntime` (same class, two names), `AgentRuntimeConfig` (discriminated `WithModel | WithProvider`), `createTool` (re-exported), types `AgentRunResult`/`AgentMessage`.
  - `@cline/core`: `LocalRuntimeHost`, `createRuntimeHost`, `createDefaultTools`/`createDefaultExecutors`, `createShellTool` (can spawn `bun test`), `createBuiltinSystemPrompt`, `createLlmsSdk`, providers, `createSkillsConfigDefinition`/`loadSkillConfig`, Sqlite storage, `CoreSession`.
  - `@cline/llms`: `createLlmsSdk`, `getAllProvider`, `registerProvider`/`registerModel`, `defineLlmsConfig`/`loadLlmsConfigFromFile`.
  - `@cline/shared`: `createTool`, schemas, `Message`/`ToolDefinition`, prompt utils, zod `toJsonSchema`.

## Where the monorepo lives
**`tutor/` subdirectory inside the course repo** (this repo). Rationale: the referee (`bun test modules/...`) and the artifacts it reads (`PROGRESS.md`, `AGENTS.md`, module files) are course-relative; the tutor must be able to point at ANY course dir via a `--course <dir>` arg (defaults to cwd). A `tutor/` workspace keeps toolcode adjacent while leaving the course root `package.json` for the course's own `test` script. A `tutor setup` command makes any new dir a course, so the tool is course-agnostic in practice.

```
tutor/
├── package.json              # workspace root ("workspaces": ["packages/*"])
├── bun.lock
├── README.md                 # (P3) usage doc for tutor + the module-layout contract
├── AGENTS.md                 # (P0) the tutor's own Socratic policy = shared core artifact
├── packages/
│   ├── sdk/       # @tutor/sdk    — alias: `export * from "@tutor/core"`
│   ├── core/      # @tutor/core    — harness: runtime host, tool defs+runtime, run_tests executor (spawns `bun test`)
│   ├── agents/    # @tutor/agents  — Socratic agent loop: AgentRuntime + tools + system-prompt policy
│   ├── llms/      # @tutor/llms    — provider gateway (anthropic/openai/ollama) via @cline/llms
│   ├── shared/    # @tutor/shared  — course-layout resolver (modern + legacy), progress model, shared types
│   ├── cli/       # @tutor/cli     — `tutor` bin: list / run / test / feynman / interactive REPL
│   └── setup/     # @tutor/setup   — `tutor setup <dir>` scaffolds a new SKILL.md-compliant course
```

## Architecture

### Agent loop (`@tutor/agents`)
Stateless per-turn loop (browser-safe, no built-in tools — we supply our own):
1. `createAgentRuntime`/`createAgent` configured `WithProvider` (provider resolved by `@tutor/llms`).
2. Loop: (a) inject course context (module README summary + student's last attempt + test output) into the system prompt; (b) run one turn; (c) if the model emits a tool call, dispatch to the registered tool, append its result, continue.
3. The **system prompt** is assembled from `AGENTS.md` (the Socratic policy, parsed into runtime instructions) + `createBuiltinSystemPrompt` + a hard "no-answers" block.

### Tools (all light, no extra deps — exposed via `createTool` + zod `toJsonSchema`)
- **`run_tests`** — the referee. Input: `{ module, testFile? }`. Resolves the module's test dir (modern `tests/` or legacy `exercises/*.test.js`), then via `@cline/core` `createShellTool`-style spawn wraps `bun test <module>` (or the single tier file). Output: pass/fail per test, stderr on failure. Never edits files.
- **`read_file`** — the student's workspace + module README only. Input `{ path }`. **Refuses `solutions/` and `*/solutions/`, `project/solution.js`, `solutions/*-all.js`** (returns "Permanently redacted — that's the teacher's copy" instead). This is the hard no-spoiler gate at the tool layer, not just the prompt.
- **`get_progress_dimension`** — input `{ module }`; reads the module README's `## 📢 Learn in Public` section and the tail of `PROGRESS.md`; returns which learn-in-public fields are filled and the last log entry. Drives Feynman + progress UX.

### Socratic policy (the "shared" core artifact, `tutor/AGENTS.md`)
Non-negotiables (mirror course-root `AGENTS.md`):
- NEVER reveal `solutions/` or paste finished code; `read_file` blocks it mechanically.
- NEVER rewrite the student's exercise file.
- NEVER answer before asking: what did you try / predict / what did the tests say?
- Answer with smaller questions, hints, minimal non-answer examples; one nudge at a time.
- Point at `// 🐛 BUG:` comments, make them predict output before running, and only then run `run_tests`.
- Feynman: after each exercise/project, have the student explain the concept back; ask one follow-up exposing a real gap; end by offering the Learn-in-Public fill.

### Provider-agnostic wiring (`@tutor/llms`)
- Resolve provider+model in order: `tutor.config.json` (CLI-overridable) → env `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → `OLLAMA_HOST` (local model, no key).
- Via `@cline/llms` `createLlmsSdk` + `registerProvider`/`getAllProvider`; `defineLlmsConfig`/`loadLlmsConfigFromFile` for the config file.

### Progress tracking (`@tutor/shared`)
- Parse/append `PROGRESS.md`: `readLearningLog()` (get_progress_dimension) + `appendLearningEntry(module, {built, confused, explain, caption})` which stamps `### YYYY-MM-DD — Module NN: …` and posts the ready-to-post caption. Appends, never rewrites.

### Course-layout resolver (`@tutor/shared`)
- Detect per module: **modern** `modules/NN-topic/{exercise/,tests/,solutions/,project/,README.md}` (per SKILL.md) **or legacy** (this repo): `exercises/{student.js,*.test.js}`, `project/solution.js`, `solutions/*-all.js`. A single `resolveCourse(dir)` → module list with typed paths + `testDir`/`sourceFile`/`solutionPaths` (redaction list). `tutor list` is pure resolver output → deterministic.

## Scope / Phases

### P0 — Scaffold + live Socratic loop with `run_tests`, smoke-tested on modules/00
Files: `tutor/{package.json,bun.lock,AGENTS.md}`, `packages/shared` (resolver — modern+legacy), `packages/llms` (provider switch), `packages/core` (`createShellTool`-backed `run_tests` executor + spawn `bun test`; read-only `read_file` with redaction), `packages/agents` (system prompt, agent loop), `packages/cli` (minimal `bin tutor` shell: list/run), `packages/sdk`.
Maps to: `@cline/core` `createRuntimeHost`/`createShellTool`/`createBuiltinSystemPrompt`; `@cline/agents` `createAgentRuntime`/`createAgent`/`createTool`; `@cline/llms` `createLlmsSdk`/`getAllProvider`; `@cline/shared` `createTool`/zod `toJsonSchema`.
In repo state: this course only ships **legacy** shape — the P0 smoke test must prove the legacy path (`bun test modules/00-networking-basics`) green-line/works and the refactor redacts `solutions/`, `project/solution.js`, `solutions/01-all.js`.
Verify: `bun install` in `tutor/`; `bun run --cwd tutor cli run 00` prints the first Socratic question (no solution text); drive one mocked student reply; assert (a) no message contains `/code`/solution file content, (b) `read_file` on `solutions/01-all.js` returns the blocked notice.

### P1 — Progress + PROGRESS.md + Feynman command
Files: `shared/progress.ts` (appendLearningEntry/readLearning), `agents/tools.ts` adds `get_progress_dimension` runtime; `cli` adds `tutor feynman <module>` (walks the student through both tiers → plates a Learn-in-Public entry and offers to post it to `PROGRESS.md`).
Maps to: `@cline/core` `CoreSession`-adjacent for prompts; plain shared types for the reflection object.
Verify: `tutor feynman 00`, answer the Feynman questions; assert a `### 2026-08-02 — Module 00` entry lands in root `PROGRESS.md`; `get_progress_dimension` returns filled vs unfilled correctly for a fresh module.

### P2 — Full harness: session persistence, skills, provider config
Files: `core/session.ts` (Persist/restore loop state so an interrupted `tutor run` resumes — Sqlite via `@cline/core` storage), `agents/skills.ts` (`createSkill aidConfigDefinition`/`loadSkillConfig` to pull `SKILL.md` module conventions automatically where present), `llms/config.ts` (`tutor.config.json` + `defineLlmsConfig`/`loadLlmsConfigFromFile` overrides + `getAllProvider` fallback priority).
Adopts: `@cline/core` Sqlite storage + `CoreSession`; `@cline/llms` config loaders.
Verify: start a session, stop, `tutor run --resume` continues on the same module; `OLLAMA_HOST`-set env picks local provider and NO key is required; a `tutor.config.json` overrides an env key.

### P3 — Packaging: cli bin + setup cmd, root README (+ PLAN.md itself created in the create)
Files: `cli/bin.ts` (`bin: "tutor"`, `#!/usr/bin/env bun`, subcommands), `setup/create.ts` (`tutor setup <dir>` scaffolds a SKILL.md-compliant course: `package.json`, `AGENTS.md`, `PROGRESS.md`, `README.md`, `modules/00-topic/{exercise,tests,solutions,project}`), `tutor/README.md` (usage + module-layout contract).
Verify: `tutor setup /tmp/scratch-course` produces a runnable course big skeleton; `bun test /tmp/scratch-course/modules/00-*` passes stub-failure expectations; `tutor --help` lists all subcommands.

## Acceptance (deterministic)
- `tutor list` — prints `00..05` module names from resolver deterministically (no LLM involved).
- `tutor run <module>` — interactive: on each turn asks for the student's attempt/prediction/test result; only after that does it answer with questions+hints; `run_tests` is the only "grade" and results get relayed verbatim.
- `tutor test <module>` — non-interactive: runs the module's `bun test` and prints the report.
- `tutor feynman <module>` — ends with a Learn-in-Public entry append to `PROGRESS.md`.
- Interactive loop — never reveals `solutions/` (enforced in `read_file` at the code level, not just prompt), never pastes a `/code` block for exercise/project content.