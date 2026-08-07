# Lyceum TUI redesign — plan

Status: Phase 0 **done** (verified); Phases 1–4 proposed.

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

### Phase 1 — Slash commands + home view

Files: `packages/cli/src/tui/App.ts` (new `HomeView`), `main.ts` (dispatch),
`packages/cli/README.md`.

1. `LyceumApp` gains a **home view**: transcript area + the single shared input
   line. Home transcript holds app notes (module list, provider, build logs).
   Bare `lyceum` opens home; `lyceum run` is unchanged (module picker + chat).
2. Slash parser in the input handler, before chat routing (omp ordering:
   built-ins first, then session/chat). Commands in scope:
   - `/list` — print the course modules to the home transcript.
   - `/provider` — print resolved provider to the transcript.
   - `/help` — command list.
   - `/tree`, `/new` — Phases 2 and 3 (registered in Phase 1 as stubs that
     print "coming" is NOT allowed — see Non-goals; they land with their
     phases).
   - No `/tute`: `lyceum run` remains the chat entry (module picker + session
     views as they are today). A `/tute` command can be added later if the
     all-in-one surface ever replaces `lyceum run`.
3. In a session view (`lyceum run`), non-`/` text goes to the coach; no global
   `/`-dispatch inside the chat for now (that keeps `lyceum run` untouched).
4. CLI subcommands in `bin.ts` stay untouched (scripting/CI path).

Acceptance: bare `lyceum` opens home; `/list`, `/provider`, `/help` work;
`lyceum run` behaves exactly as today from a shell.

### Phase 2 — `/tree`: session-tree navigator (v1: jump/rewind)

Files: `packages/agents/src/session.ts` (small addition), new
`packages/cli/src/tui/tree.ts`, `App.ts`.

1. omp semantics, v1: **in-file leaf move** — pick an earlier turn, continue
   from there. Sessions are flat today (`HistoryTurn[]`, no parent pointers), so
   v1 is: overlay SelectList of turns (who + truncated text, newest last),
   select → truncate the history file at that turn → rebuild the session
   (re-seed the coach from the truncated history, replay the transcript).
   That's omp's "re-run from an earlier point without losing the ability to
   continue" minus branching.
2. Session addition: `TutorSession` already loads/seeds from `historyFile` at
   construction — rewinding = truncate file + recreate session via the existing
   `openSession` path. No agent-loop changes needed.
3. Deferred: real branching (keep the abandoned branch, `/branch` to a new
   session file) — requires a tree-capable history format
   (`{ id, parentId }` entries). Record as a follow-up; do not half-build it.

Acceptance: in a module session, `/tree` lists turns; selecting an older user
turn rewinds the session (coach forgets later turns; transcript truncates).

### Phase 3 — `/new` in-TUI: steerable course pipeline

Files: `packages/cli/src/tui/build.ts` (new runner), `App.ts`, small touches in
`packages/agents` (`progress.ts` / stage signatures only if needed).

1. Runner: a background task that runs the existing stages in order —
   `runClarify` → `runResearch` → `planCourse` → `buildCourse` — exactly the
   `bin.ts` flow, checkpointed via the existing `.lyceum/plan.json`. Live
   events feed the home transcript via the existing `stageSink`/event shape
   (log lines = appended notes; the append-only model makes this free).
2. Steering:
   - **Clarify in-chat**: replace `defaultPromptLine()` with a TUI `AskUserFn`
     that appends the model's question as a note and resolves the next input
     line submission as the answer. The input never goes away — that's the
     whole point.
   - **Interrupt**: Esc during a stage aborts it (abort the in-flight agent
     run; checkpoint file makes a later `/new <same prompt>` resume safe —
     existing resume path). Esc does not kill the TUI.
   - **Failed modules**: build summary printed to the transcript; re-run
     `/new <same prompt>` resumes the failed/pending modules (already
     implemented in `bin.ts`'s resume branch — reuse it).
3. `--yes` / `--no-research` / `--modules` / `--stub` options: accept flags on
   the command line of `/new` (`/new --yes make a docker course`); parse with a
   tiny hand-rolled parser, mirroring the CLI flags.

Acceptance: `/new make a docker course` inside the TUI runs the full pipeline
with live logs; clarifying questions are answered in the input line; Esc
interrupts a stage; failures resume on re-run; the terminal stays interactive
the whole time.

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
