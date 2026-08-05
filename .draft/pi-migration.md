# PLAN — migrate to `@earendil-works/{pi-agent-core,pi-ai,pi-tui}`

Status: **P0–P3 complete** (each landed green on `feat/pi-migration`: `980df44` plan,
`baaf176` P1, `baefe76` P2, `8736f33` P3). P4/P5 deferred as scoped below.

## Why

`@cline/agents`'s tool-call finalizer silently turns an empty argument string into a
"successful" `{}` call — no error, no signal to the model, so it can't self-correct.
`pi-ai`'s `validateToolArguments` runs every tool call through a compiled TypeBox
validator and throws a real, formatted error (naming the missing field) before
`execute()` ever runs — that's the missing piece that made `ask_user {}` loop forever
and made `submit_findings`/`submit_outline` fail with zero diagnostics. Fixes that bug
class at the SDK layer for every tool at once, permanently.

## Verified facts (source-verified against 0.83.0 tarballs, 2026-08-05)

- **`@cline/shared` `createTool` does not enforce `inputSchema`.** Two overloads:
  `inputSchema: Record<string, unknown>` (opaque metadata) or a zod schema. The repo
  passes plain JSON-schema objects → the loop never validates; empty/malformed args
  reach `execute` silently. (`@cline/shared/dist/tools/create.d.ts`; `inputSchema`
  appears once in the minified runtime bundle.)
- **`pi-agent-core` validates unconditionally.** `agent-loop.js:403-404`:
  `prepareToolCallArguments` → `validateToolArguments` — inside try/catch, before
  `beforeToolCall`/`execute`. Failures become error tool results fed back to the model.
  Tool-not-found similarly returns `Tool X not found`.
- **Error format** (`pi-ai/dist/utils/validation.js`): `Validation failed for tool
  "X":\n  - <path>: <message>\n\nReceived arguments:\n<json>`.
- **baseURL is NOT a blocker.** `Model.baseUrl` is a required field
  (`types.d.ts:652`) with `compat` overrides auto-detected from baseUrl
  (`types.d.ts:664`); `Provider` has optional `baseUrl` + `auth: ProviderAuth`
  (`apiKey.resolve()`/`oauth`) + `getModels()` — custom providers (Ollama,
  `OPENAI_BASE_URL`) are first-class. `openrouterProvider()` exists for the
  `sk-or-` path. `MutableModels.setProvider` (`models.d.ts:126`) is the
  registration point.
- **Shared openai-completions stream**: `pi-ai/dist/api/openai-completions.d.ts:16`
  exports `streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions>` —
  same chat-completions SSE wire format the repo hand-rolls today. Options carry
  `signal` + `apiKey`. Tool-call fragments are assembled by index AND id (two maps),
  so the kilo.ai chunk-split bug is structurally handled (`openai-completions.js`).
- **TUI fork divergence**: `@earendil-works/pi-tui@0.83.0` has **zero**
  `ScrollView`/`SymbolTheme` (recursive grep). The repo's `Transcript extends
  ScrollView` (`cli/src/tui/App.ts:58`) needs a real port — P4 is NOT a rename.
- **Event mapping** (pi → cline, for the P1 adapter):
  `text_delta`→`text-delta`; `thinking_delta`→`reasoning-delta`;
  `toolcall_end`(full ToolCall)→one `tool-call-delta`{toolCallId,toolName,
  inputText}; `done`→`finish`{toolUse→"tool-calls", stop→"stop",
  length→"max-tokens"} + `usage` from `message.usage`; `error`→`finish`{error}.
- **P0 spike (2026-08-05)**: `ask_user` AgentTool (required `question`, TypeBox)
  + `createFauxCore` scripted model emitting `ask_user {}` + real `Agent` loop —
  validator threw, loop emitted `tool_execution_end isError=true`, error text was the
  last message of the model's next-turn context, loop recovered and finished
  (`agent_end`). All assertions passed on Bun 1.3.14. Spike lives in `/tmp/pispike`.

## What's being replaced

| Today | Replacement | Role |
|---|---|---|
| `@cline/agents` (`createAgentRuntime`) | `@earendil-works/pi-agent-core` (`Agent`, `agent-loop`) | runtime/loop (P3) |
| `@cline/shared` (`createTool`, JSON-schema) | `@earendil-works/pi-ai` `Tool`/`AgentTool` + TypeBox | tool definitions (P2) |
| `@tutor/llms` `buildModel` (hand-rolled SSE — **this repo's own package**; `@cline/llms` was never installed) | `@earendil-works/pi-ai` providers (`openai-completions` streamSimple) | model/provider layer (P1) |
| `@oh-my-pi/pi-tui` (fork) | `@earendil-works/pi-tui` (upstream) | TUI rendering (P4, real port) |
| `@oh-my-pi/pi-natives` | upstream bundles its own natives | native bindings (P4) |

NOT using: `@earendil-works/pi-coding-agent` (its tools/TUI need the full app runtime
— `ExtensionContext`, sessions; the repo's `App.ts` isn't being replaced).

## P1 — Provider/model layer ✅ (`baaf176`)

Swap `packages/llms/src/provider.ts` internals to pi's `openai-completions`
`streamSimple`. Public surface unchanged: `resolveProvider`, `ProviderSelection`,
`ProviderConfig`, `buildModel(sel): AgentModel` (cline shape — required until P3).
- `buildModel` constructs a pi `Model` (`api: "openai-completions"`, `baseUrl:
  sel.baseUrl`, `id: sel.modelId`) and wraps `streamSimple(model, context, options)`
  in a cline `AgentModel` adapter: convert cline messages/tools → pi
  `Context`/`Tool[]`, map pi events → cline events (table above), pass
  `{ apiKey: sel.apiKey, signal }` with the `TUTOR_REQUEST_TIMEOUT_MS` deadline
  preserved.
- Delete the hand-rolled `sse`, `parseChunk`, `SseChunk`/`SseToolCallDelta` types,
  and the `firstIdByIndex` kilo workaround (pi assembles by index+id).
- `resolveProvider` untouched; port tests as-is (env chain unchanged).
- Dependencies: add `@earendil-works/pi-ai` to `packages/llms/package.json`. Keep
  `@cline/*` in all package.jsons (unused) until P0–P4 merged — rollback stays a
  `git revert`.

## P2 — Tool layer ✅ (`baefe76`)

Rewrite `packages/core/src/tools.ts` and `interactive.ts` tool-by-tool
(`run_tests`, `read_file`, `write_file`, `grep`, `web_search`, `ask_user`) as pi
`Tool<TParameters>` + execute callbacks, TypeBox schemas. Sandboxing logic
(`withinRoot`/symlink hardening, spoiler-gate redaction) carries over unchanged.
With validation live: make `ask_user.question` genuinely `required` and **delete the
whole fallback path** — `FALLBACK_QUESTION`, topic-aware variant, manual
`typeof`/empty-string guards — dead code masking the exact failure validation now
surfaces. Keep only `MAX_ASK_USER_CALLS` (business logic).

## P3 — Agent runtime layer ✅ (`8736f33`)

Replace `createAgentRuntime` call sites (`session.ts`, `clarify.ts`, `researcher.ts`,
`planner.ts`, `course-builder.ts`, `polish.ts`) with pi `Agent`. 6 files, mechanical
once P1–P2 prove the shape; each site already isolates construction behind a small
function. File-by-file, tests green after each, not big-bang.
- No `maxIterations` in pi: enforce via `turn_end` counter + `abort()`.
- `AgentState{systemPrompt, model, thinkingLevel, tools, messages}`;
  `AgentEvent` subscription replaces `AgentRuntimeEvent` — `progress.ts`/`App.ts`
  event mapping is part of this step.
- SSE-mock tests (`kilo-chunking.test.ts`, `clarify.test.ts`, `researcher.test.ts`)
  get re-pointed at the pi construction (same wire format, light edits — budget for
  re-harnessing every one, not zero).

## P4 — TUI layer (LAST, own branch, own soak — not a rename)

`Transcript` (extends `ScrollView`) and `SymbolTheme`-typed `symbols` have no
upstream equivalent. Scope: read upstream's component list, find the viewport
replacement or build windowing/scroll-offset behavior by hand; reimplement
`Transcript` + `symbols` against what's actually there. Land on its own branch with
its own soak period. No code dependency on P1–P3, but a real port — don't treat as
low-risk or do-whenever.

## P5 — Transport-reliability fix (after P0–P3 green)

Revisit file-based/hybrid-fallback handoffs (`.draft/course-builder-redesign.md`
P0) on the new SDK: validator errors give the retry loop precise structured reasons
(a) instead of hand-rolled `reportErrors`/`outlineErrors`; per-tool `AbortSignal`
(b) gives a real per-call timeout for failure #7 (health beacon / configurable
timeout).

## Sequencing & rollback

SDK swap first (P0–P3), transport redesign second, on a known-good baseline — if
`lyceum new` still breaks, it's the architecture, not a package-swap side effect.
Every P lands as its own branch/PR with `bun test` + `bunx tsc --noEmit` +
`bunx eslint packages` green. Keep `@cline/*` in package.json (unused, not
imported) until P0–P4 merged and soak-tested.

Note: current suite is 80 tests / 13 files (not 78). Stash `stash@{0}` holds
SDK-neutral UX work (course-name semantics, beacons, readline default) — land it on
`main` independently; the readline default is the real fix for failure #7's
invisible-prompt hang regardless of SDK.
