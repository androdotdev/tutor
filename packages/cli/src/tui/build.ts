// In-TUI course build runner: `/new <course name>` runs the same headless
// pipeline as `lyceum new` (clarify → research → plan → author, checkpointed
// in .lyceum/plan.json) inside the home view. Live logs stream into the home
// transcript, clarifying questions are answered in the input line, and Esc
// interrupts the current stage without killing the TUI.
//
// Target is the dir the TUI was launched in, with the CLI's dispatch:
// a matching plan.json resumes (draft the pending/failed modules), an existing
// modules/ dir appends ONE module with that title, otherwise the full pipeline
// runs from scratch (the fresh course-building folder case).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addModule, buildAuthorTools } from "@tutor/core";
import {
  buildCourse,
  createAuthorSession,
  loadCoursePlan,
  newCoursePlan,
  planCourse,
  runClarify,
  runResearch,
  saveCoursePlan,
  summarizeInput,
  wireAbort,
  type BuildModuleEvent,
  type CourseOutline,
  type CoursePlanFile,
  type ResearchReport,
  type TutorRuntimeEvent,
} from "@tutor/agents";
import { findModule, resolveCourse } from "@tutor/shared";
import type { ProviderSelection } from "@tutor/llms";
import type { Transcript } from "./App";
import { style } from "./theme";

export interface BuildRunnerOptions {
  courseRoot: string;
  provider: ProviderSelection;
  transcript: Transcript;
  /** Status-line updates while the build runs (busy text, interrupt, idle). */
  onStatus: (text: string) => void;
  /** The idle status text, restored when the build finishes. */
  idleStatus: string;
}

/**
 * One `/new` run. Owns the abort signal and the in-chat clarifying-question
 * channel; the HomeView routes input submissions here while `running`.
 */
export class BuildRunner {
  readonly abort = new AbortController();
  running = false;
  private stage = "starting";
  private question: { resolve: (value: string) => void; reject: (error: Error) => void } | null = null;
  /** Model text accumulated during the current stage (committed at run end). */
  private stageText = "";
  /** Paths written by write_file during an append-mode author run. */
  private written: string[] = [];

  constructor(private readonly ctx: BuildRunnerOptions) {}

  /** The clarify stage's ask_user channel: question → home transcript → next input line. */
  readonly askUser = (question: string): Promise<string> => {
    const q = question.replace(/\s+/g, " ").trim();
    this.note(`coach asks: ${q}`);
    this.onStatus(style.yellow("answering — type your answer, Enter; Esc interrupts"));
    return new Promise((resolve, reject) => {
      this.question = { resolve, reject };
    });
  };

  /** Route an input submission while the build is running. True = consumed. */
  submit(value: string): boolean {
    const q = this.question;
    if (q) {
      this.question = null;
      q.resolve(value.trim());
      this.onStatus(this.busyStatus());
      return true;
    }
    if (!this.running) return false;
    this.note("no clarifying question pending — the build answers questions as they arrive (Esc interrupts)");
    return true;
  }

  /** Esc while running: reject a pending question and abort the current stage. */
  interrupt(): void {
    const q = this.question;
    this.question = null;
    q?.reject(new Error("interrupted"));
    if (!this.running) return;
    this.abort.abort();
    this.onStatus(style.yellow("interrupting…"));
  }

  async start(prompt: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.onStatus(this.busyStatus());
    const target = this.ctx.courseRoot;
    try {
      const existingPlan = loadCoursePlan(target);
      if (existingPlan && existingPlan.prompt === prompt) {
        await this.resume(target, prompt, existingPlan);
        return;
      }
      if (existsSync(join(target, "modules"))) {
        await this.appendModule(target, prompt);
        return;
      }
      await this.full(target, prompt);
    } catch (err) {
      if (this.abort.signal.aborted) {
        this.note("interrupted — re-run /new <same prompt> to resume");
      } else {
        this.note(`build failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.running = false;
      this.stage = "idle";
      this.onStatus(this.ctx.idleStatus);
    }
  }

  /** Fresh dir: clarify → research → plan → author every module. */
  private async full(target: string, prompt: string): Promise<void> {
    const { provider } = this.ctx;
    this.note(`building course: "${prompt}" — ${provider.label} (${provider.modelId})`);
    this.beginStage("clarifying", "course requirements");
    const { recap } = await runClarify({
      provider,
      prompt,
      askUser: this.askUser,
      abort: this.abort.signal,
      onEvent: (e) => this.onEvent("clarify", e),
    });
    this.ensureNotAborted();
    this.endStage();
    const context = `${prompt}\n\nClarified: ${recap}`;

    this.beginStage("researching", "the topic");
    const { web_search } = buildAuthorTools({ courseRoot: target, modules: [] });
    const research: ResearchReport | null = await runResearch({
      provider,
      prompt: context,
      courseRoot: target,
      webSearchTool: web_search,
      abort: this.abort.signal,
      onEvent: (e) => this.onEvent("research", e),
    });
    this.ensureNotAborted();
    this.endStage();

    this.beginStage("planning", "the curriculum");
    const outline = await planCourse({
      provider,
      prompt: context,
      courseRoot: target,
      research,
      abort: this.abort.signal,
      onEvent: (e) => this.onEvent("plan", e),
    });
    this.ensureNotAborted();
    saveCoursePlan(newCoursePlan(target, prompt, outline));
    this.endStage();
    this.note(`planned ${outline.modules.length} modules: ${outline.modules.map((m) => m.title).join(", ")}`);
    await this.build(target, prompt, outline);
  }

  /** Checkpoint match: draft the modules still pending/failed. */
  private async resume(target: string, prompt: string, plan: CoursePlanFile): Promise<void> {
    const left = plan.modules.filter((m) => m.status !== "drafted").length;
    if (left === 0) {
      this.note("all modules already drafted — nothing to resume");
      return;
    }
    this.note(`resuming ${target} (${left} module(s) left)`);
    await this.build(target, prompt, plan.outline);
  }

  /** Existing modules/ dir: author ONE new module with that title (append mode). */
  private async appendModule(target: string, title: string): Promise<void> {
    const modules = await resolveCourse(target);
    let module = (await findModule(modules, title)) ?? null;
    if (!module) {
      const mod = await addModule(target, { title });
      modules.push(...(await resolveCourse(target)));
      module = (await findModule(modules, mod.dir)) ?? null;
    }
    if (!module) throw new Error(`could not resolve module "${title}"`);
    this.beginStage("authoring", `module ${module.dir}`);
    this.written = [];
    const session = createAuthorSession({
      courseRoot: target,
      modules,
      module,
      provider: this.ctx.provider,
    });
    session.subscribe((e) => this.onEvent("build", e));
    const task =
      `Author the module now. Title: "${module.title}". Module dir: ${module.dir}.\n` +
      `Follow the order in the policy: tests first, then exercise stub, then README, then run_tests to verify the grader loads. ` +
      `Finish with a summary of what the learner must implement.`;
    const unwire = wireAbort(session, this.abort.signal);
    try {
      await session.run(task);
    } finally {
      unwire();
    }
    this.ensureNotAborted();
    this.endStage();
    this.note(`authored ${module.dir} — files written: ${this.written.length}`);
  }

  /** Author every module of an outline (continue-on-error, checkpointed). */
  private async build(target: string, prompt: string, outline: CourseOutline): Promise<void> {
    this.beginStage("authoring", `${outline.modules.length} modules`);
    const result = await buildCourse({
      provider: this.ctx.provider,
      courseRoot: target,
      outline,
      prompt,
      abort: this.abort.signal,
      onEvent: (e) => this.onEvent("build", e),
      onModule: (m) => this.onModule(m),
    });
    this.ensureNotAborted();
    this.endStage();
    this.note(`${result.drafted}/${outline.modules.length} modules drafted`);
    for (const f of result.failed) this.note(`failed: ${f.title} — ${f.error}`);
    if (result.failed.length) {
      this.note(`${result.failed.length} module(s) failed — re-run /new <same prompt> to resume`);
    } else {
      this.note(`course ready at ${target} — cd there and run lyceum`);
    }
  }

  private onModule(m: BuildModuleEvent): void {
    switch (m.status) {
      case "started":
        this.note(`drafting ${m.dir}…`);
        break;
      case "drafted":
        this.note(`drafted ${m.dir}`);
        break;
      case "failed":
        this.note(`failed ${m.dir}: ${m.error}`);
        break;
    }
  }

  /** Stage-level stream: model text accumulates, tool calls log as notes. */
  private onEvent(stage: string, event: TutorRuntimeEvent): void {
    switch (event.type) {
      case "assistant-text-delta":
        this.stageText += event.text;
        break;
      case "assistant-reasoning-delta":
        break; // too noisy for the transcript; tool notes + status carry the pace
      case "tool-started":
        this.note(`[${stage}] → ${event.toolName} ${summarizeInput(event.args)}`);
        break;
      case "tool-finished":
        this.note(`[${stage}] ${event.isError ? "failed" : "ok"} ${event.toolName}`);
        if (!event.isError && event.toolName === "write_file") {
          const result = event.result;
          if (typeof result === "object" && result !== null && "details" in result) {
            const details = result.details;
            if (typeof details === "object" && details !== null && "path" in details) {
              this.written.push(String(details.path));
            }
          }
        }
        break;
      case "run-finished":
        if (this.stageText.trim()) {
          this.ctx.transcript.add({ who: "assistant", text: this.stageText });
          this.stageText = "";
        }
        break;
      case "run-failed":
        this.note(`[${stage}] run failed: ${event.error.message}`);
        this.stageText = "";
        break;
      default:
        break;
    }
  }

  private beginStage(stage: string, what: string): void {
    this.stage = stage;
    this.note(`— ${stage}: ${what} —`);
    this.onStatus(this.busyStatus());
  }

  private endStage(): void {
    this.stageText = "";
    this.onStatus(this.busyStatus());
  }

  private busyStatus(): string {
    return style.yellow(`building — ${this.stage}… (Esc interrupts)`);
  }

  /** The stage settles cleanly even after an abort raced it — stop anyway. */
  private ensureNotAborted(): void {
    if (this.abort.signal.aborted) throw new Error("interrupted");
  }

  private note(text: string): void {
    this.ctx.transcript.add({ who: "note", text });
  }

  private onStatus(text: string): void {
    this.ctx.onStatus(text);
  }
}
