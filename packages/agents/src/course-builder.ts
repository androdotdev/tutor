// Course-Builder stage: the per-module authoring loop. Pre-creates every
// module's directory skeleton, then runs the author session per module in
// outline order, resuming a checkpointed plan (skip "drafted", record
// "failed" and continue). Never aborts the whole build on one bad module.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { slugify } from "@tutor/core";
import { resolveCourse } from "@tutor/shared";
import type { ProviderSelection } from "@tutor/llms";
import { createPolishTool } from "./polish";
import { createAuthorSession } from "./author";
import { loadCoursePlan, newCoursePlan, markModule } from "./plan-file";
import type { CoursePlanFile, CourseOutline } from "./pipeline-types";

export interface BuildCourseOptions {
  provider: ProviderSelection;
  courseRoot: string;
  outline: CourseOutline;
  prompt: string;
}

export interface BuildCourseResult {
  drafted: number;
  failed: Array<{ id: string; title: string; error: string }>;
}

const MODULE_SUBDIRS = ["exercise", "tests", "solutions"] as const;

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
  const dirs = new Map<string, string>();
  for (const m of outline.modules) {
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
      const task =
        `Author the module "${m.title}". Concepts to cover: ${m.concepts.join("; ")}. ` +
        `Sources to cite: ${(m.sources ?? []).join(", ")}`;
      await session.run(task);
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
