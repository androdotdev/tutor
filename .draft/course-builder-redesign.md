# Course-Builder Redesign — research notes

Status: research draft → **P0 (Option A) landed 2026-08-05** on `feat/pi-migration`
(research → `.lyceum/research.json`, plan → `.lyceum/outline.json`, both via
`write_file`; `submit_findings`/`submit_outline` deleted). **2026-08-05 (main):
plan handoff refined to MODULE-WISE delivery** — `.lyceum/outline.json` carries
only `{ name, topic }` and each module is its own `.lyceum/modules/<id>.json`;
a complete outline delivered as final TEXT is parsed and persisted stage-side
(no more "planned but never wrote the file" failures). Remaining phases P1
(test-verified status, parallel authoring, health beacon ✓ already shipped via
stash), P2 (hybrid fallback, per-file resume, plan.md) not started.

## TL;DR

The pipeline's hard dependency on **tool-call ARGUMENT transport** is the
systemic fragility. Every transport failure this session (kilo.ai chunk
splitting, a gateway stripping all arguments, truncated monolithic payloads)
hit that channel — while **content deltas (streaming text) never failed once**.
The redesign moves stage handoffs from tool arguments to **files the model
writes** (content streams as deltas, accumulates robustly, survives crashes),
reuses the existing validators, and deletes the forced-capture machinery.
Second-order wins: parallel module authoring, test-verified module status,
mid-stage checkpoints.

## 1. Current architecture (as built)

```
lyceum new <prompt...> [--dir <path>]           (packages/cli/src/bin.ts)
  └─ runClarify   → ask_user ×≤3 → recap text (in-memory QA)
  └─ runResearch  → web_search + submit_findings (FORCED tool-call capture)
                    ResearchReport lives ONLY in memory → re-fed to planner
                    as prompt text; nothing on disk.
  └─ planCourse   → submit_outline (FORCED tool-call capture)
                    → .lyceum/plan.json checkpoint (only disk artifact)
  └─ buildCourse  → per-module author session, SEQUENTIAL loop
                    (packages/agents/src/course-builder.ts:66-99)
                    status: pending | drafted | failed (module-level only)
```

Key facts:

- `submit_findings` / `submit_outline` are `createTool` wrappers whose
  `execute` stashes the args in a closure; the stage reads the closure after
  `runtime.run()` and validates with hand-rolled guards
  (`reportErrors` / `outlineErrors`). Both now have
  `lifecycle: { completesRun: true }` (v0.1.3).
- The provider (`packages/llms/src/provider.ts`) streams SSE chunks; tool-call
  deltas carry `toolCallId` per index (v0.1.6 kilo fix), text/content deltas
  stream as plain events.
- One 60s `AbortSignal.timeout` wraps the whole model request; no retry with
  backoff, no configurable timeout.
- `plan.json` is written AFTER the plan stage. A crash in clarify or research
  loses everything (research especially: findings are never persisted).
- Module authoring: `write_file` writes `exercise/index.js`, `tests/…`,
  `README.md`; "drafted" means the session completed — **no test run
  verifies the module actually passes its own grader**.

## 2. Failure log — observed live this session

| # | Symptom | Root cause | Fix shipped |
| --- | --- | --- | --- |
| 1 | "not showing any thinking, looks stuck" | stages print a label then wait silently; no streaming, no tool activity | progressLogger streaming (0.1.1) |
| 2 | `Researcher did not produce a valid findings report` | stage failed with zero diagnostics | reportErrors + payload sketch + last output (0.1.1) |
| 3 | model called `ask_user {}` forever, never recapping | tool-arg transport empty; unbounded loop; blank prompt | cap ×3 + fallback question (0.1.2/0.1.3) |
| 4 | `web_search {}` ×10 feeding "undefined" pages back | kilo.ai streams id+name in first delta, args fragments after; runtime keyed fragments by different ids → split records: named `{}` call executed, real args dropped as missing_name | per-index id memory in provider (0.1.6) |
| 5 | gateway stripped ALL tool arguments | every tool call arrived `{}`; submit payloads impossible → stage failed by design | empty-query guard + stripped-args hint (0.1.5); **no true fix possible in-tool** |
| 6 | `lyceum new make a docker course…` → topic "make", dir "a" | two positionals + allowExcessArguments(true) dropped the rest | variadic prompt + `--dir` (0.2.0) |
| 7 | `lyceum new …` times out, blank output | under investigation (see §5): likely invisible inquirer prompt (ANSI) or provider stall before first token; no health beacon during the wait | none yet |

Observation: failures 3, 4, 5 are all the SAME channel — tool-call
`function.arguments`. Streaming text (reasoning, recaps, prose) never failed
through the same providers in the same runs.

## 3. Root-cause analysis

1. **Tool arguments are a fragile transport.** Providers chunk them
   arbitrarily, some gateways strip them, models truncate long payloads at
   max output tokens. The pipeline put its two most important handoffs
   (findings, outline) through exactly this channel, as single monolithic
   JSON blobs in ONE tool call.
2. **No fallback channel.** When args arrive `{}`, ask_user had a fallback
   (prompt), web_search got a guard (error), but submit_* had NOTHING —
   the stage could only fail. The model's final text (which was reliable)
   was never used as a delivery channel.
3. **No mid-stage durability.** Research has no disk artifact at all; a crash
   re-runs it. Plan.json exists only after planning. Long stages are
   all-or-nothing.
4. **Sequential, unverified builds.** Modules are authored one at a time;
   "drafted" ≠ "tests pass". A broken module ships silently.
5. **Silent waits.** Between model requests the CLI prints nothing; a slow
   provider or an invisible prompt reads as "stuck" (failure 1, 7).

## 4. Design goals

- G1: stage handoffs must not depend on tool-call argument transport.
- G2: every stage artifact lands on disk (resumable, diffable, inspectable).
- G3: keep the existing validators (`reportErrors`, `outlineErrors`,
  `parseReport`, `parseOutline`) — validation logic does not change, only
  the channel.
- G4: bounded loops, visible progress, health beacon during waits.
- G5: a module is "drafted" only when its own tests pass.

## 5. The timeout (failure 7) — hypotheses

- The paste shows `^[[A` ×7 / `^[[B` — the user was cycling inquirer's input
  HISTORY, so the process was alive and waiting at a prompt; the prompt's ANSI
  rendering did not survive the terminal copy (blank lines). Likely invisible
  prompt (terminal/wrapper that doesn't render ANSI), not a dead process.
- A literal 60s request abort would print an error; the blank paste argues
  against a hard timeout path.
- Verify before assuming: `lyceum --help` must show the variadic prompt
  argument (0.2.0); run `lyceum new x --yes --no-research` and watch whether
  the inquirer prompt renders.
- Mitigation regardless: require BOTH stdin and stdout TTY for inquirer
  (else plain readline), print a "waiting for model… (Ns)" beacon during
  inter-request gaps, make the request timeout configurable with retry+backoff.

## 6. Options

### A. File-based stage handoffs (recommended core)

Research: model writes `.lyceum/research.json` via `write_file`; plan: model
writes `.lyceum/outline.json` via `write_file`. After the run, the stage reads
+ validates the file, retrying once with corrective notes (same retry shape as
today).

- `write_file` already exists in the author toolset; add it to the research
  and plan runtimes (one-line tools arrays).
- Content streams as deltas — the channel that never failed. Long outlines
  can be written across multiple `write_file` calls, removing the
  single-call truncation risk.
- Artifacts persist: resume re-validates instead of re-running; users can
  inspect/edit `.lyceum/research.json`.
- Delete `submit_findings` / `submit_outline` and the closure-stash capture —
  clean cutover, one delivery channel.
- Contract for the model: "write your findings to `.lyceum/research.json`
  (schema: …), then reply with a one-line summary."
- Risk: model writes invalid JSON to the file → same validation/retry loop
  as today; strictly less likely than today's transport loss, and the file
  content is visible for debugging.

### B. Final-message structured output

Model emits the JSON as its final assistant text; stage parses the last
message (`response_format: json_object` where supported, fenced-JSON parse
otherwise).

- Zero tool args → survives stripped-args gateways entirely.
- Needs per-provider `response_format` support; single-message truncation
  risk remains; weaker structure guarantee without `response_format`.

### C. Hybrid (file primary, final-message fallback)

Try the file; if missing/invalid, parse the final message; retry loop
unchanged. Most robust, slightly more code. Cheap to add AFTER A lands.

### D–G. Independent improvements

- **D. Parallel module authoring** — modules are independent (own dir, own
  session, own checkpoint). Bounded concurrency (2–4) cuts wall time ~N×;
  resume safety already exists via module status.
- **E. Test-verified status** — after each module session, run its tests
  (the author toolset already has `run_tests`; or reuse `lyceum test`);
  mark `drafted` only on pass; on failure feed the test output back for one
  bounded revision pass (mirrors polish.ts) before marking `failed`.
- **F. Per-file checkpoints** — record which files a module has written;
  resume skips existing files (mid-module resume).
- **G. Plan.md (human-editable)** — `.lyceum/plan.md` with frontmatter in
  addition to plan.json, so users can hand-edit module titles/difficulty.

## 7. Recommendation — phased

- **P0 (next release): A** — file-based handoffs for research + plan.
  Kills failure classes 2/3/4/5 at the architectural level. Reuses
  validators; deletes capture machinery. + regression test that replays the
  kilo chunking and asserts the OUTLINE lands on disk (extends the existing
  kilo-chunking test).
- **P1: E + D** — test-verified module status with bounded revision; parallel
  authoring with concurrency cap.
- **P1: health beacon + dual-TTY check for inquirer + configurable request
  timeout with retry/backoff** — addresses failure 7 and the "looks stuck"
  class permanently.
- **P2: C, F, G** — hybrid fallback, per-file resume, editable plan.

## 8. Risks & migration

- A changes the stage contract: prompts change ("write the file" instead of
  "call the tool"), tests change (validators stay, mocks switch from
  `submit_*` tool calls to `write_file` calls). This is a breaking release
  (0.3.0) per repo convention.
- Old checkpoints: `plan.json` shape unchanged (outline still lands there via
  the same code path) — resume keeps working across the change.
- `write_file` must refuse absolute/`..` paths for `.lyceum/*` targets
  (already the tool's posture for modules).
- D (parallelism) interacts with rate limits: make the cap configurable,
  default conservative (2).
- E must not run the grader during a fresh scaffold (no tests yet) — only
  verify when `tests/` contains a test file.

## 9. Verification plan

- Unit: validators unchanged → existing suites stay green; new tests assert
  the model's `write_file` content (chunked like kilo.ai) validates.
- E2E: mock writes `.lyceum/research.json` / `.lyceum/outline.json` across
  multiple chunks; assert artifacts on disk, resume skips re-running, invalid
  file → corrective retry message.
- Live: `lyceum new …` against kilo.ai — confirm `web_search` args arrive
  (known good) and artifacts land before the plan stage.
