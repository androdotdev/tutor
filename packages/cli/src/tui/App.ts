// Lyceum TUI on @oh-my-pi/pi-tui: home command surface -> module picker -> Socratic chat session.
import {
  Container,
  Input,
  Markdown,
  SelectList,
  TUI,
  Text,
  type Component,
  type SelectItem,
} from "@oh-my-pi/pi-tui";
import type { ModuleDesc } from "@tutor/shared";
import type { TutorSession, TutorRuntimeEvent } from "@tutor/agents";
import type { ProviderSelection } from "@tutor/llms";
import { join } from "node:path";
import { markdownTheme, selectTheme, style } from "./theme";
import { BuildRunner } from "./build";
import { openTreeOverlay, rewindHistoryFile } from "./tree";

export interface LyceumAppOptions {
  courseRoot: string;
  modules: ModuleDesc[];
  /** Null when home opens without a configured LLM (fresh folder, no key). */
  provider: ProviderSelection | null;
  makeSession: (module: ModuleDesc) => TutorSession;
  /** Open a session immediately instead of the module picker. */
  initialModule?: ModuleDesc;
  /** Bare `lyceum` opens the home command surface; `lyceum run` keeps the picker. */
  initialView?: "home" | "picker";
  onQuit: () => void;
}

type ChatLine = { who: "user" | "assistant" | "note"; text: string };

const userPrefix = "you » ";
const notePrefix = "· ";

/**
 * Unbounded, append-only transcript. Every line is emitted once and commits to
 * native terminal scrollback as it scrolls off — tmux/terminal scroll is the
 * only scroll, so there is no in-app scroll state at all. Settled lines are
 * FINAL and byte-stable; the streaming reply is a single mutable suffix line
 * that repaints in place until commit.
 *
 * Engine integration (pi-tui native-scrollback contract):
 * - render(): the FULL line array, cached per width — the same reference is
 *   returned while content is unchanged, which is the engine's byte-identity
 *   proof for the settled prefix (containers memoize on it).
 * - getNativeScrollbackLiveRegionStart(): the settled row count — rows above
 *   it are final and commit as exact bytes; the live line below it repaints
 *   in place inside the window.
 * - getRenderStablePrefixRows(): the settled count (0 right after a settled
 *   change) so a streamed delta re-ingests only the live line, never history.
 */
export class Transcript implements Component {
  private renderers: Array<{ who: ChatLine["who"]; renderer: Text | Markdown }> = [];
  private live: Markdown | null = null;
  private liveText: string | null = null;
  /** Settled rows cached per render width; cleared when content changes. */
  private settledCache = new Map<number, string[]>();
  /** Settled content changed since the last render (report must be 0). */
  private settledDirty = true;
  /** Settled row count at the width of the last render (the live seam). */
  private lastSettledCount = 0;
  /** Full-frame cache: the same reference is returned while (width, content) is unchanged. */
  private frameCache: { width: number; rows: readonly string[] } | null = null;

  add(line: ChatLine): void {
    if (line.who === "assistant") {
      this.renderers.push({ who: "assistant", renderer: new Markdown(line.text, 0, 0, markdownTheme) });
    } else {
      const prefix = line.who === "user" ? userPrefix : notePrefix;
      this.renderers.push({
        who: line.who,
        renderer: new Text(line.who === "note" ? style.dim(prefix + line.text) : prefix + line.text, 0, 0),
      });
    }
    this.settledCache.clear();
    this.settledDirty = true;
    this.frameCache = null;
  }

  /** Update the in-flight assistant stream (accumulatedText per delta). */
  setLive(text: string): void {
    this.liveText = text;
    if (this.live) {
      this.live.setText(text);
    } else {
      this.live = new Markdown(text, 0, 0, markdownTheme);
    }
    this.frameCache = null;
  }

  /** Promote the streaming reply to a settled assistant message. */
  commitLive(): void {
    if (this.liveText === null || !this.live) return;
    this.renderers.push({ who: "assistant", renderer: this.live });
    this.live = null;
    this.liveText = null;
    this.settledCache.clear();
    this.settledDirty = true;
    this.frameCache = null;
  }

  /** Discard the partial stream (e.g. run failed mid-generation). */
  dropLive(): void {
    this.live = null;
    this.liveText = null;
    this.frameCache = null;
  }

  render(width: number): readonly string[] {
    const cached = this.frameCache;
    if (cached && cached.width === width) return cached.rows;
    const settled = this.settledRows(width);
    this.lastSettledCount = settled.length;
    const rows = this.live ? [...settled, ...this.live.render(width)] : settled;
    this.frameCache = { width, rows };
    return rows;
  }

  /** Live-region seam: settled rows are final; the live line is the mutable suffix. */
  getNativeScrollbackLiveRegionStart(): number {
    return this.lastSettledCount;
  }

  /** Stability report: settled rows are byte-stable; 0 right after a settled change. */
  getRenderStablePrefixRows(): number {
    if (this.settledDirty) {
      this.settledDirty = false;
      return 0;
    }
    return this.lastSettledCount;
  }

  invalidate(): void {
    this.settledCache.clear();
    this.settledDirty = true;
    this.frameCache = null;
  }

  private settledRows(width: number): readonly string[] {
    const cached = this.settledCache.get(width);
    if (cached) return cached;
    const rows: string[] = [];
    for (const { renderer } of this.renderers) rows.push(...renderer.render(width));
    this.settledCache.set(width, rows);
    this.settledDirty = true; // width miss: rows were re-wrapped, not byte-stable
    return rows;
  }
}

/** Chat view: transcript + status line + single-line input. */
export class SessionView extends Container {
  readonly transcript = new Transcript();
  private readonly tui: TUI;
  private readonly status = new Text("", 0, 0);
  private readonly input = new Input();
  private readonly session: TutorSession;
  private readonly module: ModuleDesc;
  private readonly onBack: () => void;
  private readonly onRewind: (index: number) => void;
  private busy = false;

  constructor(
    tui: TUI,
    opts: {
      session: TutorSession;
      module: ModuleDesc;
      onBack: () => void;
      /** /tree pick: rewind the session history to this turn index (inclusive). */
      onRewind: (index: number) => void;
      /** Optional note appended after history replay (e.g. "rewound"). */
      note?: string;
    },
  ) {
    super();
    this.tui = tui;
    this.session = opts.session;
    this.module = opts.module;
    this.onBack = opts.onBack;
    this.onRewind = opts.onRewind;

    this.input.prompt = style.bold(userPrefix.trimEnd() + " ");
    this.input.onSubmit = (value) => void this.submit(value);
    this.input.onEscape = () => {
      if (this.busy) {
        this.session.abort("student stopped");
      } else {
        this.onBack();
      }
    };

    this.addChild(this.transcript);
    this.addChild(this.status);
    this.addChild(this.input);
    this.setIdleStatus();

    this.transcript.add({
      who: "note",
      text: `Module ${this.module.id} — ${this.module.title}. Describe what you're stuck on, or ask the coach to read the exercise or run the tests.`,
    });
    // Resumed session: replay the stored conversation so the transcript (and
    // the learner) pick up where they left off.
    for (const turn of this.session.historyTurns) {
      this.transcript.add({ who: turn.who, text: turn.text });
    }
    if (opts.note) this.transcript.add({ who: "note", text: opts.note });
    this.session.subscribe((event) => this.onEvent(event));
  }

  /** The component that owns keyboard input while this view is active. */
  get focusable(): Input {
    return this.input;
  }

  /** Native-scrollback seam: the transcript is the first child (offset 0), so its seam is the view's. */
  getNativeScrollbackLiveRegionStart(): number {
    return this.transcript.getNativeScrollbackLiveRegionStart();
  }

  /** Stability report: settled rows are byte-stable; forwarded from the transcript. */
  getRenderStablePrefixRows(): number {
    return this.transcript.getRenderStablePrefixRows();
  }

  private setIdleStatus(): void {
    this.status.setText(
      style.dim("Ask the coach — Enter sends · /tree rewinds · Esc stops (or back) · Ctrl+C quits"),
    );
  }

  private setBusyStatus(): void {
    this.status.setText(style.yellow("coach is thinking — run_tests may execute… (Esc to stop)"));
  }
  private onEvent(event: TutorRuntimeEvent): void {
    switch (event.type) {
      case "assistant-text-delta":
        this.transcript.setLive(event.accumulatedText);
        break;
      case "run-finished":
        this.transcript.commitLive();
        break;
      case "run-failed":
        this.transcript.dropLive();
        this.status.setText(style.red(`coach run failed — press Enter to retry (${event.error.message})`));
        break;
      case "tool-started":
        if (event.toolName === "run_tests") {
          this.status.setText(style.blue("running the module's tests…"));
        }
        break;
      case "tool-finished":
        if (event.toolName === "run_tests") {
          this.status.setText(style.dim("tests finished — output relayed above"));
        }
        break;
      default:
        return;
    }
    this.tui.requestRender();
  }

  private async submit(value: string): Promise<void> {
    const text = value.trim();
    if (!text) return;
    this.input.setValue("");
    this.transcript.add({ who: "user", text });
    if (text === "/tree") {
      this.openTree();
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.setBusyStatus();
    this.tui.requestRender();
    try {
      // Events (run-finished) commit the streamed reply; ask() only throws on
      // genuinely failed runs, which surface as an error note below.
      await this.session.ask(text);
    } catch (err) {
      this.transcript.add({ who: "note", text: `coach error: ${(err as Error).message}` });
    } finally {
      this.busy = false;
      this.setIdleStatus();
      this.tui.requestRender();
    }
  }

  /** /tree: fullscreen turn picker; a pick rewinds the session to that turn. */
  private openTree(): void {
    if (this.busy) {
      this.transcript.add({
        who: "note",
        text: "coach is thinking — press Esc to stop, then /tree to rewind",
      });
      this.tui.requestRender();
      return;
    }
    const turns = this.session.historyTurns;
    if (turns.length < 2) {
      this.transcript.add({ who: "note", text: "no earlier turns to rewind to" });
      this.tui.requestRender();
      return;
    }
    openTreeOverlay(this.tui, turns, (index) => this.onRewind(index));
  }
}

/**
 * Slash-command dispatch for the home surface. Pure: returns the note lines to
 * append to the transcript, so the commands are testable without a TUI.
 */
export function runHomeCommand(
  value: string,
  ctx: { modules: ModuleDesc[]; provider: ProviderSelection | null },
): string[] {
  const name = value.trim().split(/\s+/)[0];
  switch (name) {
    case "/list":
      if (!ctx.modules.length) {
        return ["no modules found — cd into a course or set defaultCourse in config"];
      }
      return ["modules:", ...ctx.modules.map((m) => `  ${m.id} — ${m.title} (${m.layout} · ${m.moduleDir})`)];
    case "/provider": {
      const p = ctx.provider;
      return p ? [`provider: ${p.label} · ${p.modelId} · ${p.baseUrl}`] : ["provider: none configured — set OPENAI_API_KEY or OLLAMA_HOST"];
    }
    case "/help":
      return ["commands: /list — course modules · /provider — resolved LLM · /new — build a course · /help — this list"];
    default:
      return [`unknown command: ${name} — try /help`];
  }
}

/** Home command surface: app notes transcript + the shared input line. */
export class HomeView extends Container {
  readonly transcript = new Transcript();
  private readonly tui: TUI;
  private readonly status = new Text("", 0, 0);
  private readonly input = new Input();
  private readonly modules: ModuleDesc[];
  private readonly provider: ProviderSelection | null;
  private readonly onQuit: () => void;
  private readonly runner: BuildRunner;

  constructor(
    tui: TUI,
    opts: { modules: ModuleDesc[]; provider: ProviderSelection | null; courseRoot: string; onQuit: () => void },
  ) {
    super();
    this.tui = tui;
    this.modules = opts.modules;
    this.provider = opts.provider;
    this.onQuit = opts.onQuit;

    this.input.prompt = "» ";
    this.input.onSubmit = (value) => this.submit(value);
    this.input.onEscape = () => {
      if (this.runner.running) {
        this.runner.interrupt();
        this.tui.requestRender();
      } else {
        this.onQuit();
      }
    };
    this.runner = new BuildRunner({
      courseRoot: opts.courseRoot,
      provider: opts.provider,
      transcript: this.transcript,
      onStatus: (text) => {
        this.status.setText(text);
        this.tui.requestRender();
      },
      idleStatus: style.dim("home — /list · /provider · /new · /help · Esc quits"),
    });

    this.addChild(this.transcript);
    this.addChild(this.status);
    this.addChild(this.input);

    this.transcript.add({
      who: "note",
      text: "lyceum — Socratic self-learning coach. /new builds a course here · /list browses modules · /help lists commands · `lyceum run` opens a module session.",
    });
    this.status.setText(style.dim("home — /list · /provider · /new · /help · Esc quits"));
  }

  /** The component that owns keyboard input while this view is active. */
  get focusable(): Input {
    return this.input;
  }

  /** Native-scrollback seam: the transcript is the first child (offset 0). */
  getNativeScrollbackLiveRegionStart(): number {
    return this.transcript.getNativeScrollbackLiveRegionStart();
  }

  /** Stability report: settled rows are byte-stable; forwarded from the transcript. */
  getRenderStablePrefixRows(): number {
    return this.transcript.getRenderStablePrefixRows();
  }

  private submit(value: string): void {
    const text = value.trim();
    if (!text) return;
    this.input.setValue("");
    this.transcript.add({ who: "user", text });
    if (this.runner.running) {
      this.runner.submit(text);
      this.tui.requestRender();
      return;
    }
    if (text.startsWith("/")) {
      if (text === "/new" || text.startsWith("/new ")) {
        const prompt = text.slice(4).trim();
        if (!prompt) {
          this.transcript.add({
            who: "note",
            text: "usage: /new <course name> — e.g. /new make a docker course",
          });
        } else {
          void this.runner.start(prompt);
        }
      } else {
        for (const note of runHomeCommand(text, { modules: this.modules, provider: this.provider })) {
          this.transcript.add({ who: "note", text: note });
        }
      }
    } else {
      this.transcript.add({
        who: "note",
        text: "home has no chat — `lyceum run` opens a module session (type /help)",
      });
    }
    this.tui.requestRender();
  }
}

/** Module picker: SelectList with type-to-filter. */
export class ModuleListView extends Container {
  private readonly tui: TUI;
  private readonly list: SelectList;

  constructor(tui: TUI, modules: ModuleDesc[], onPick: (module: ModuleDesc) => void, onCancel: () => void) {
    super();
    this.tui = tui;
    const items: SelectItem[] = modules.map((m, i) => ({
      value: String(i),
      label: `${m.id}  ${m.title}`,
      description: `${m.layout} · ${m.moduleDir}`,
    }));
    this.list = new SelectList(items, Math.max(3, tui.terminal.rows - 3), selectTheme, {});
    this.list.onSelect = (item) => {
      const m = modules[Number(item.value)];
      if (m) onPick(m);
    };
    this.list.onCancel = onCancel;
    this.addChild(this.list);
  }

  get focusable(): SelectList {
    return this.list;
  }

  override render(width: number): readonly string[] {
    this.list.setMaxVisible(Math.max(3, this.tui.terminal.rows - 3));
    return super.render(width);
  }
}

/** Root view switcher: module list <-> session. */
export class LyceumApp extends Container {
  private view: HomeView | ModuleListView | SessionView | null = null;
  private readonly tui: TUI;
  private readonly opts: LyceumAppOptions;

  constructor(tui: TUI, opts: LyceumAppOptions) {
    super();
    this.tui = tui;
    this.opts = opts;
    if (opts.initialModule) {
      this.openSession(opts.initialModule);
    } else if (opts.initialView === "home") {
      this.showHome();
    } else {
      this.showList();
    }
  }

  /** The currently focused input surface (for setFocus). */
  get focusable(): Component | null {
    return this.view?.focusable ?? null;
  }

  /** Forward the active view's live-region seam (transcript = the mutable suffix). */
  getNativeScrollbackLiveRegionStart(): number | undefined {
    const view = this.view;
    if (view && "getNativeScrollbackLiveRegionStart" in view) {
      return view.getNativeScrollbackLiveRegionStart();
    }
    return undefined;
  }

  /** Forward the active view's stability report. */
  getRenderStablePrefixRows(): number | undefined {
    const view = this.view;
    if (view && "getRenderStablePrefixRows" in view) {
      return view.getRenderStablePrefixRows();
    }
    return undefined;
  }

  showHome(): void {
    this.swap(
      new HomeView(this.tui, {
        modules: this.opts.modules,
        provider: this.opts.provider,
        courseRoot: this.opts.courseRoot,
        onQuit: this.opts.onQuit,
      }),
    );
  }

  showList(): void {
    this.swap(
      new ModuleListView(this.tui, this.opts.modules, (m) => this.openSession(m), this.opts.onQuit),
    );
  }

  openSession(module: ModuleDesc, note?: string): void {
    this.swap(
      new SessionView(this.tui, {
        session: this.opts.makeSession(module),
        module,
        onBack: () => this.showList(),
        onRewind: (index) => this.rewindSession(module, index),
        note,
      }),
    );
  }

  /** /tree pick: truncate the history file at `index` and rebuild the session. */
  private rewindSession(module: ModuleDesc, index: number): void {
    const historyFile = join(this.opts.courseRoot, "session", `${module.id}.json`);
    const { original, kept } = rewindHistoryFile(historyFile, index);
    if (original === 0) return;
    // Recreates: loads the truncated file, replays the transcript, then notes
    // the cut.
    this.openSession(module, `↩ rewound to ${kept} of ${original} turns`);
  }

  private swap(view: HomeView | ModuleListView | SessionView): void {
    this.disposeChildren();
    this.view = view;
    this.addChild(view);
    const focusable = view.focusable;
    if (focusable) this.tui.setFocus(focusable);
    this.tui.requestRender();
  }
}
