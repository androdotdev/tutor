// Course-Builder stage: the per-module authoring loop. Pre-creates every
// module's directory skeleton, then runs the author session per module in
// outline order, resuming a checkpointed plan (skip "drafted", record
// "failed" and continue). Never aborts the whole build on one bad module.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { slugify } from "@tutor/core";
import { resolveCourse } from "@tutor/shared";
import type { ProviderSelection } from "@tutor/llms";
import { createPolishTool } from "./polish";
import { createAuthorSession } from "./author";
import { stageSink } from "./progress";
import { loadCoursePlan, newCoursePlan, markModule } from "./plan-file";
import type { CoursePlanFile, CourseOutline } from "./pipeline-types";

export interface BuildCourseOptions {
  provider: ProviderSelection;
  courseRoot: string;
  outline: CourseOutline;
  prompt: string;
  /** Stream each module session's reasoning/text and log tool calls to stdout. */
  progress?: boolean;
  /** Append the full stream to this file (lyceum new --log). */
  logFile?: string;
}

export interface BuildCourseResult {
  drafted: number;
  failed: Array<{ id: string; title: string; error: string }>;
}

const MODULE_SUBDIRS = ["exercise", "tests", "solutions"] as const;

/** Files a successful author run MUST land under modules/<dir>/; the grader
 * only ever runs these. A run missing any of them is failed, not drafted. */
const AUTHORED_FILES = ["tests/index.test.js", "exercise/index.js", "README.md"] as const;

/** The module directory name an outline module maps to. */
function moduleDir(m: { id: string; title: string }): string {
  return m.id + "-" + slugify(m.title);
}

/** True when the loaded plan's module ids match the outline's (set-wise). */
function planMatchesOutline(plan: CoursePlanFile, outline: CourseOutline): boolean {
  const planIds = new Set(plan.modules.map((m) => m.id));
  const outlineIds = new Set(outline.modules.map((m) => m.id));
  if (planIds.size !== outlineIds.size) return false;
  for (const id of outlineIds) {
    if (!planIds.has(id)) return false;
  }
  return true;
}

export async function buildCourse(opts: BuildCourseOptions): Promise<BuildCourseResult> {
  const { courseRoot, outline, prompt, provider } = opts;

  // Resumable checkpoint; discard a stale plan whose outline no longer matches.
  let plan: CoursePlanFile =
    loadCoursePlan(courseRoot) ?? newCoursePlan(courseRoot, prompt, outline);
  if (!planMatchesOutline(plan, outline)) {
    plan = newCoursePlan(courseRoot, prompt, outline);
  }

  // Pre-create ALL module dirs first so resolveCourse sees every module and
  // the author sessions can write into their skeletons.
  const dirs = new Map<string, string>();  for (const m of outline.modules) {
    const dir = moduleDir(m);
    dirs.set(m.id, dir);
    for (const sub of MODULE_SUBDIRS) {
      await mkdir(join(courseRoot, "modules", dir, sub), { recursive: true });
    }
  }

  const modules = await resolveCourse(courseRoot);
  // One polish tool per build; it is stateless per call so reuse is safe.
  const polishTool = createPolishTool(provider);

  for (const m of outline.modules) {
    const dir = dirs.get(m.id) ?? moduleDir(m);
    const entry = plan.modules.find((p) => p.id === m.id);
    if (entry?.status === "drafted") continue; // resume: already built

    const desc = modules.find((d) => d.id === m.id);
    if (!desc) {
      console.log(`drafting ${dir}... FAILED: module dir not resolvable`);
      markModule(plan, m.id, { status: "failed", error: "module dir not resolvable", dir });
      continue;
    }

    console.log(`drafting ${dir}...`);
    try {
      const session = createAuthorSession({
        courseRoot,
        modules,
        module: desc,
        provider,
        extraTools: [polishTool],
      });
      const sink = stageSink("build", { progress: opts.progress, logFile: opts.logFile });
      if (sink) session.subscribe(sink);
      const task =
        `Author the module "${m.title}". Concepts to cover: ${m.concepts.join("; ")}. ` +
        `Sources to cite: ${(m.sources ?? []).join(", ")}`;
      await session.run(task);
      // The grader only sees modules/<dir>/tests/, exercise/, README.md — a
      // run that finished without landing those files (e.g. wrote to a bare
      // path at the course root) is NOT drafted: fail loudly so the resume
      // loop retries instead of leaving a silently broken module behind.
      const missingFiles = AUTHORED_FILES.filter(
        (f) => !existsSync(join(courseRoot, "modules", dir, f)),
      );
      if (missingFiles.length) {
        console.log(`drafting ${dir}... FAILED: missing ${missingFiles.join(", ")}`);
        markModule(plan, m.id, { status: "failed", error: `authored files missing: ${missingFiles.join(", ")}`, dir });
        continue;
      }
      markModule(plan, m.id, { status: "drafted", dir });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`drafting ${dir}... FAILED: ${message}`);
      markModule(plan, m.id, { status: "failed", error: message, dir });
    }
  }

  const drafted = plan.modules.filter((p) => p.status === "drafted").length;
  const failed = plan.modules
    .filter((p) => p.status === "failed")
    .map((p) => ({ id: p.id, title: p.title, error: p.error ?? "failed" }));

  return { drafted, failed };
}
