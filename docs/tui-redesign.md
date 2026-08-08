# Lyceum TUI redesign — plan

Status: Phases 0–3 **done** (verified); Phase 4 proposed.

Release process: feature commits land per phase, **no version bump or tag until
the final push** — one `release(cli): bump to <version>` commit + tag at the end
(matches the repo's tag-driven release convention).

## Goal

Turn `lyceum` into a single persistent TUI where everything is a `/`-command,
with the transcript living in **terminal scrollback** (tmux scroll, exactly like
omp) instead of an in-app scroll view, and the course-generation pipeline
(`lyceum new`) running **inside** the TUI where it can be steered.

## Key discovery: the engine already does this

`@oh-my-pi/pi-tui` 17.2.5 (the fork lyceum already depends on) ships a complete
**native-scrollback commit engine** — the same machinery omp's own chat runs on.
Evidence (`packages/cli/node_modules/@oh-my-pi/pi-tui/src/tui.ts`):

- "Append-only render contract: rows committed to native scrollback are
  immutable — the tape is the terminal's visual record. Whatever scrolls above
  the window enters history exactly once, in order" (L3–7).
- `NativeScrollbackLiveRegion` seam: a component declares the line index where
  its mutable suffix begins; rows above are FINAL and commit to terminal
  scrollback as exact bytes; rows at/after repaint in place in the window
  (L190–217).
- The engine tracks `#committedRows` / `#committedPrefix` and always windows the
  frame to its tail: `windowTop = max(committedRows, frameLength - height)`
  (L3133). Tail-following is free; overflow commits; resize/ConPTY/multiplexer
  cases are already handled.
- Overlay fullscreen (alt-screen borrow, vim/less idiom) exists for interactive
  selectors: `OverlayOptions.fullscreen` (L455–461).

**Why scroll is broken today:** lyceum's `Transcript` is a fixed-height
`ScrollView` that windows rows and repaints the same N rows in place. Its render
output is always exactly viewport-height, so nothing ever overflows the frame,
nothing commits to native scrollback, and tmux history stays empty. The in-app
scroll state (`scrollOffset`, `followTail`, `SCROLL_KEYS`, the `requestRender`
gap in `main.ts`) exists only to paper over that.

**The fix is not a library switch and not "no scroll" — it is an unbounded
transcript** that participates in the scrollback engine. That is the "same as
omp" behavior the user wants.

## Architecture

```
TUI root (main buffer)
├── transcript (unbounded, append-only)
│     settled lines  ── FINAL → commit to terminal scrollback (tmux-scrollable)
│     live line      ── mutable suffix, repaints in place (streaming)
└── status line (1 row, in-place)
└── input line (1 row, in-place)
    ├── plain text        → session chat / pipeline steer answer
    └── /command          → global dispatch (built-in first, like omp)

overlays (alt screen, transient)
└── session tree navigator (SelectList)          — /tree

Note: the module picker stays inside `lyceum run` (unchanged chat entry); there
is no `/tute` command in scope.
```

Rules that fall out of the model:

- **Anything above the status line is append-only.** Once a line scrolls into
  scrollback it is immutable. No in-place edits to history (the engine audits
  and rejects them).
- **The tail is always in view.** No `scrollToBottom`, no followTail, no offset.
- **The input line never loses focus** — this is what makes steering possible:
  the pipeline runs as a background task while the input stays live.

## Phases

### Phase 0 — Unbounded transcript ✅ done

Files: `packages/cli/src/tui/App.ts`, `main.ts`, `test/transcript.test.ts`.

Built:

1. `Transcript extends ScrollView` → unbounded `Component`. `render(width)`
   returns the FULL line array, cached per width — the same reference comes
   back while content is unchanged, which is the engine's byte-identity proof
   for the settled prefix. No windowing, no `setHeight`, no `setContentWidth`.
2. Seams implemented on the transcript and **forwarded up the view chain** —
   the engine reads seams/reports only from TUI **root children**, and
   `LyceumApp`/`SessionView` are Containers, so each forwards:
   - `NativeScrollbackLiveRegion`:
     `getNativeScrollbackLiveRegionStart()` → settled-rows count (live line is
     the mutable suffix).
   - `RenderStablePrefix`: `getRenderStablePrefixRows()` → settled count (0
     right after a settled change, consume-on-read). A streamed delta re-ingests
     only the live line, never history.
   `Container` already propagates `NativeScrollbackCommittedRows` +
   `NativeScrollbackReplay`; the transcript's `invalidate()` clears caches for
   replay.
3. Deliberately **not** implemented (documented simplification):
   - `NativeScrollbackCommittedRows` trimming: settled renderers are kept, not
     dropped (sessions are capped at 500 turns — memory is bounded; replay is a
     cache clear).
   - `ViewportTailProvider`: the stability report already keeps deltas to the
     live suffix, so the extra seam is unnecessary.
   - 33ms delta-coalescing timer: the engine's frame throttle coalesces (render
     uses the latest `liveText`).
4. `SessionView`: dropped the viewport re-fitting `render()` override entirely
   (inherit `Container.render`); status + input stay pinned by the engine's
   tail windowing. Deleted: `SCROLL_KEYS`, the scroll branch in `main.ts`'s
   input listener, `handleScrollKey`/`setFollowTail`/`scrollToBottom`, the `-4`
   viewport math. Esc semantics unchanged (stop/back), Ctrl+C unchanged.
5. Tests (`transcript.test.ts`) rewritten around the new contract: settled rows
   byte-stable (same references), add preserves older references, width re-wrap
   + cache restore, seam advance on commit/retreat on drop, stability report
   consume semantics (width-miss render ⇒ 0, clean render ⇒ settled count, live
   delta does NOT dirty the prefix).

Verified end-to-end in a pty (tmux 100×24, driver wired the real `LyceumApp`
with a fake streaming session): boot renders intro+status+input; a typed
message streams live (partial line repaints in place, busy status) and commits
on run-finished; after ~20 messages the viewport pins the tail (status+input
always visible) and `tmux capture-pane -S -40` shows the FULL conversation
committed to native scrollback; resize repaints and keeps scrollback; Ctrl+C
backs out of a session (list cancel quits). 95 tests pass, typecheck and lint
clean. Also fixed a pre-existing typecheck error in
`packages/agents/src/author.ts` (`followUp` missing `timestamp`).

Acceptance met: with a long session, tmux scrollback contains the transcript;
terminal scroll is the only scroll; no in-app scroll keys.

### Phase 1 — Slash commands + home view ✅ done

Files: `packages/cli/src/tui/App.ts` (new `HomeView`), `main.ts` (dispatch),
`bin.ts` (bare default), `test/home.test.ts`.

Built:

1. `HomeView`: Container with an unbounded transcript (app notes) + status +
   input — same scrollback seams as the chat view (transcript is the first
   child). Welcome note, "home — /list · /provider · /help · Esc quits" status,
   Esc quits the app.
2. Slash dispatch as a pure `runHomeCommand(value, ctx)` → note lines
   (testable without a TUI): `/list` (module rows), `/provider`
   (label · model · baseUrl — never the key), `/help`, unknown → hint. Plain
   text gets a "home has no chat — `lyceum run` opens a module session" hint.
3. Bare `lyceum` → home (`launchTui(undefined, { home: true })` →
   `initialView: "home"`); `lyceum run [module]` unchanged (picker/chat).
   Subcommands (`new`/`list`/`provider`/`setup`) untouched.
4. Tests (`test/home.test.ts`, 10 cases): command outputs, key redaction,
   unknown-command hint, submit → transcript rows, plain-text hint, Esc quit,
   empty submit, byte-stability.

Verified: 105 tests pass, typecheck + lint clean, pty smoke (tmux): home boots
with welcome + status; `/list`, `/provider`, `/help`, `/bogus` all render to
the transcript; plain text gets the no-chat hint only; Esc quits; picker path
(`lyceum run`) boots and quits unchanged.

Acceptance met: bare `lyceum` opens home; `/list`, `/provider`, `/help` work;
`lyceum run` behaves exactly as today from a shell.

### Phase 2 — `/tree`: session-tree navigator (v1: jump/rewind) ✅ done

Files: `packages/cli/src/tui/tree.ts` (new), `App.ts` (SessionView /tree,
LyceumApp rewind), `test/tree.test.ts`.

Built:

1. `openTreeOverlay`: fullscreen (alt-screen) `SelectList` of turns — "you: …" /
   "coach: …" labels with truncated text + timestamp descriptions, newest last.
   Select → `onPick(index)`; Esc/cancel hides and leaves the session untouched.
   Overlays freeze commits, so the picker never pollutes scrollback.
2. `rewindHistoryFile(file, index)`: truncate the session file at the picked
   turn (inclusive), returns `{ original, kept }` — the rewind primitive.
3. SessionView: `/tree` in the chat input (the only chat slash — everything
   else still goes to the coach). Busy → hint note; <2 turns → note; else the
   overlay. `onRewind(index)` → LyceumApp truncates the history file and
   reopens the session (existing `openSession` path: fresh TutorSession loads
   the truncated file, re-seeds the coach, replays the transcript), appending
   a "↩ rewound to N of M turns" note.
4. Tests (`test/tree.test.ts`, 8 cases): rewind math (inclusive cut, first
   turn, missing file no-op), overlay wiring (fullscreen, pick index, cancel),
   SessionView notes (no history, busy), non-tree messages reach the coach,
   LyceumApp end-to-end (pick truncates file + rebuilds session).

Verified: 113 tests pass, typecheck + lint clean, pty smoke (tmux, real
session + history file): resumed session shows 5 turns; `/tree` opens the
fullscreen picker; picking turn 3 truncates the file to 3 turns, rebuilds the
session, replays the truncated transcript + rewind note; cancel restores the
screen with the file untouched.

Acceptance met: in a module session, `/tree` lists turns; selecting an older
turn rewinds the session (coach forgets later turns; transcript truncates).
Branching remains deferred (tree-capable history format).

### Phase 3 — `/new` in-TUI: steerable course pipeline ✅ done

Files: `packages/cli/src/tui/build.ts` (new `BuildRunner`), `App.ts` (HomeView
`/new` + Esc routing), `main.ts` (relaxed bare-launch), `packages/agents`
(`progress.ts`, `clarify.ts`, `researcher.ts`, `planner.ts`,
`course-builder.ts`, `author.ts` — abort + event plumbing),
`test/build.test.ts` (new), `test/home.test.ts`.

1. **Agents plumbing** (no behavior change outside the TUI): `stageSink` gains
   an app-facing `onEvent` listener; new `wireAbort(agent, signal)` one-shot
   helper; `runClarify`/`runResearch`/`runPlanStage`/`buildCourse` accept
   `abort?: AbortSignal` + `onEvent?`; `buildCourse` additionally reports per-
   module progress via `onModule` (`BuildModuleEvent`: started/drafted/failed)
   and continues on module failure (CLI semantics preserved); `AuthorSession`
   gains `abort()`.
2. **`BuildRunner`** (no-flag `/new <course name>`): dispatch on the dir the
   TUI was launched in, mirroring `bin.ts` — a matching `.lyceum/plan.json`
   resumes (drafts pending/failed modules; "all modules already drafted —
   nothing to resume" when complete), an existing `modules/` appends ONE module
   with that title, otherwise the full pipeline runs from scratch (the fresh
   course-building folder case). Live stage events stream into the home
   transcript: stage banners, model recap lines (committed on run-finished),
   `[stage] → tool` / `[stage] ok tool` notes, per-module drafting notes, and a
   final `N/M modules drafted` + `course ready` summary.
3. **Steering**:
   - **Clarify in-chat**: `askUser` appends the model's question ("coach asks:
     …"), the input line switches to "answering — type your answer, Enter; Esc
     interrupts", and the next submission resolves the question. The input
     never goes away.
   - **Interrupt**: Esc rejects a pending question and aborts the in-flight
     stage (idle-safe: when nothing is running, Esc quits, as the footer
     says). "interrupted — re-run /new <same prompt> to resume"; the
     checkpoint makes the re-run safe.
   - **Flags dropped**: `/new` takes NO flags — `/new <course name>` only
     (user decision: "do we even need the flag for / command?"). Clarify is
     in-chat by design and Esc is the interrupt; `--yes` / `--no-research` /
     `--modules` / `--stub` remain CLI-only (`lyceum new`).
4. Tests (`test/build.test.ts`, 6 cases; `home.test.ts` updated to the no-flag
   surface): askUser appends + resolves via submit, interrupt rejects a
   pending question (idle-safe), submit routing (false when idle, question
   wins), bare `/new` prints usage, Esc quits when idle.

Verified: **119 tests pass**, typecheck + lint clean, pty smoke (real
`LyceumApp` in a fresh dir against a scripted fake OpenAI-compatible LLM, all
stages driven over real tool calls): full pipeline boots in a module-less dir,
the clarify question is answered in the input line, research → plan → author
run with live logs, both modules drafted with `tests/` + `exercise/` +
`README.md`, `course ready`; `.lyceum/plan.json` checkpointed; same prompt
again → "nothing to resume"; a failed module in the checkpoint → "resuming …
(N left)" and re-drafts it; a different prompt in a course dir → append mode
authors a new module; Esc mid-build → "interrupted — re-run …" and the TUI
stays alive and interactive; Esc at idle quits (exit 0).

Acceptance met: `/new make a docker course` runs the full pipeline with live
logs; clarifying questions answered in the input line; Esc interrupts a stage;
failures resume on re-run; the terminal stays interactive the whole time.

### Phase 4 — Web landing page (`packages/web`)

Files: new `packages/web/` (index.html + server), root `package.json` (workspace
entry), `docs/tui-redesign.md` pointer.

1. New bun workspace package `packages/web`: a **static landing page only** —
   no app logic, no course browser, no backend, no framework/build step. Plain
   `index.html` + minimal CSS, plus a tiny `Bun.serve` static file server
   (`bun run dev` → localhost).
2. Content: what lyceum is (Socratic self-learning tutor, TUI over courses),
   how to run it (`lyceum run`, `lyceum new`), where docs live. Ties to the
   product the TUI ships.
3. Explicit non-goals: no signup/auth, no course hosting, no interactive
   playground, no tracking — landing page is the whole package.

Acceptance: `bun run dev` in `packages/web` serves the page; the landing page
renders with zero runtime dependencies.

## Non-goals (explicit)

- No library switch: stay on `@oh-my-pi/pi-tui`. The stale
  `@mariozechner/pi-tui` (0.73.1, 2026-05-07) lacks the WSL/ConPTY fixes this
  workstation needs and the scrollback engine this plan builds on.
- No `/tree` branching in v1 (needs a session-format change; deferred).
- No per-module "re-draft with feedback" (polish tool exists; wire it only if
  it falls out of Phase 3 cheaply).
- No `/setup` in-TUI (already interactive in its own flow; defer).
- No `/tute` command: `lyceum run` stays the chat entry for now. The chat TUI
  is not folded into the home view in this plan.
- No changes to `bin.ts` commands, session file format, or the agents pipeline
  contract beyond what Phase 3 needs.

## Verification

Each phase has its own acceptance (above). Cross-cutting: `bun test`,
`bun run typecheck`, `bun run lint`, plus a pty-driven TUI run per phase
(`hub` + PTY: send keys, observe). The transcript unit tests move from
"windowing" to "finality + seam" semantics.

## Open questions

1. Home-view transcript vs. session transcript: one shared transcript surface
   with views swapping content, or separate components? (Proposal: separate —
   session keeps its own; home holds app/build notes. Simpler rewind in Phase 2.)
2. ~~`NativeScrollbackReplay` re-render cost on huge sessions~~ **Resolved in Phase 0**:
   replay is `invalidate()` (cache clear), and the pty smoke confirmed it runs
   on gesture-driven full paints (resize) with scrollback intact. Committed-row
   trimming is unnecessary at the 500-turn session cap.
3. Bare `lyceum` flips from "same as `lyceum run`" (module picker) to the home
   command surface in Phase 1. Decision above assumes that's fine — it changes
   the muscle-memory default. If not, home is reachable some other way (e.g. a
   `/home` from the chat) and the chat stays the bare default.
