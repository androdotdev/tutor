// Lyceum TUI on @oh-my-pi/pi-tui: module picker -> Socratic chat session.
import {
  Container,
  Input,
  Markdown,
  ScrollView,
  SelectList,
  TUI,
  Text,
  type Component,
  type SelectItem,
} from "@oh-my-pi/pi-tui";
import type { AgentRuntimeEvent } from "@cline/shared";
import type { ModuleDesc } from "@tutor/shared";
import type { TutorSession } from "@tutor/agents";
import type { ProviderSelection } from "@tutor/llms";
import { markdownTheme, selectTheme, style } from "./theme";

export interface LyceumAppOptions {
  courseRoot: string;
  modules: ModuleDesc[];
  provider: ProviderSelection;
  makeSession: (module: ModuleDesc) => TutorSession;
  /** Open a session immediately instead of the module picker. */
  initialModule?: ModuleDesc;
  onQuit: () => void;
}

type ChatLine = { who: "user" | "assistant" | "note"; text: string };

const userPrefix = "you » ";
const notePrefix = "· ";

/**
 * Fixed-height, auto-following transcript. Assistant lines render as Markdown,
 * user/note lines as plain (ANSI-aware) text.
 */
export class Transcript extends ScrollView {
  private renderers: Array<{ who: ChatLine["who"]; renderer: Text | Markdown }> = [];
  private live: Markdown | null = null;
  private contentWidth = 80;
  private followTail = true;

  constructor() {
    super([], { height: 10, scrollbar: "auto" });
  }

  setContentWidth(width: number): void {
    this.contentWidth = Math.max(10, width);
  }

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
    this.rebuild();
  }

  /** Update the in-flight assistant stream (accumulatedText per delta). */
  setLive(text: string): void {
    if (!this.live) {
      this.live = new Markdown(text, 0, 0, markdownTheme);
    } else {
      this.live.setText(text);
    }
    this.rebuild();
  }

  /** Promote the streaming reply to a settled assistant message. */
  commitLive(): void {
    if (this.live) {
      this.renderers.push({ who: "assistant", renderer: this.live });
      this.live = null;
    }
    this.rebuild();
  }

  /** Discard the partial stream (e.g. run failed mid-generation). */
  dropLive(): void {
    this.live = null;
    this.rebuild();
  }

  setFollowTail(follow: boolean): void {
    this.followTail = follow;
    if (follow) this.scrollToBottom();
  }

  private rebuild(): void {
    const rows: string[] = [];
    const w = this.contentWidth;
    for (const { renderer } of this.renderers) rows.push(...renderer.render(w));
    if (this.live) rows.push(...this.live.render(w));
    this.setLines(rows);
    this.setTotalRows(rows.length);
    if (this.followTail) this.scrollToBottom();
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
  private busy = false;

  constructor(tui: TUI, opts: { session: TutorSession; module: ModuleDesc; onBack: () => void }) {
    super();
    this.tui = tui;
    this.session = opts.session;
    this.module = opts.module;
    this.onBack = opts.onBack;

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
    this.session.subscribe((event) => this.onEvent(event));
  }

  /** The component that owns keyboard input while this view is active. */
  get focusable(): Input {
    return this.input;
  }

  override render(width: number): readonly string[] {
    // Re-fit the viewport every frame: header(1) + status(1) + input(1) + margin(1).
    this.transcript.setHeight(Math.max(4, this.tui.terminal.rows - 4));
    this.transcript.setContentWidth(Math.max(10, width - 1));
    return super.render(width);
  }

  private setIdleStatus(): void {
    this.status.setText(
      style.dim("Ask the coach — Enter sends · Esc stops (or back) · Shift+↑/↓ scrolls · Ctrl+C quits"),
    );
  }

  private setBusyStatus(): void {
    this.status.setText(style.yellow("coach is thinking — run_tests may execute… (Esc to stop)"));
  }
  private onEvent(event: AgentRuntimeEvent): void {
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
        break;      case "tool-started":
        if (event.toolCall.toolName === "run_tests") {
          this.status.setText(style.blue("running the module's tests…"));
        }
        break;
      case "tool-finished":
        if (event.toolCall.toolName === "run_tests") {
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
    if (!text || this.busy) return;
    this.busy = true;
    this.input.setValue("");
    this.transcript.add({ who: "user", text });
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
  private view: ModuleListView | SessionView | null = null;
  private readonly tui: TUI;
  private readonly opts: LyceumAppOptions;

  constructor(tui: TUI, opts: LyceumAppOptions) {
    super();
    this.tui = tui;
    this.opts = opts;
    if (opts.initialModule) {
      this.openSession(opts.initialModule);
    } else {
      this.showList();
    }
  }

  /** The currently focused input surface (for setFocus). */
  get focusable(): Component | null {
    return this.view?.focusable ?? null;
  }

  /** The active chat view, if a session is open (for global scroll keys). */
  get sessionView(): SessionView | null {
    return this.view instanceof SessionView ? this.view : null;
  }

  showList(): void {
    this.swap(
      new ModuleListView(this.tui, this.opts.modules, (m) => this.openSession(m), this.opts.onQuit),
    );
  }

  openSession(module: ModuleDesc): void {
    this.swap(
      new SessionView(this.tui, {
        session: this.opts.makeSession(module),
        module,
        onBack: () => this.showList(),
      }),
    );
  }

  private swap(view: ModuleListView | SessionView): void {
    this.disposeChildren();
    this.view = view;
    this.addChild(view);
    const focusable = view.focusable;
    if (focusable) this.tui.setFocus(focusable);
    this.tui.requestRender();
  }
}
