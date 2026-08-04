// Checkpoint load/save helpers for the `lyceum new "<prompt>"` pipeline.
// The resumable plan lives at <courseRoot>/.lyceum/plan.json so an
// interrupted build can resume (see pipeline-types.ts for the shape).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CourseOutline, CoursePlanFile, ModuleBuildStatus } from "./pipeline-types.ts";

/** Checkpoint path relative to the course root. */
export const PLAN_REL = ".lyceum/plan.json";

export function planFilePath(courseRoot: string): string {
  return join(courseRoot, PLAN_REL);
}

/** Load the checkpoint; missing or corrupt files yield null (best-effort). */
export function loadCoursePlan(courseRoot: string): CoursePlanFile | null {
  try {
    const raw = readFileSync(planFilePath(courseRoot), "utf8");
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return null;
    const plan = data as Record<string, unknown>;
    if (plan.version !== 1) return null;
    if (typeof plan.courseRoot !== "string" || typeof plan.prompt !== "string") return null;
    if (typeof plan.createdAt !== "number") return null;
    if (typeof plan.outline !== "object" || plan.outline === null) return null;
    if (!Array.isArray(plan.modules)) return null;
    for (const entry of plan.modules) {
      if (typeof entry !== "object" || entry === null) return null;
      const mod = entry as Record<string, unknown>;
      if (typeof mod.id !== "string" || typeof mod.title !== "string") return null;
      if (mod.status !== "pending" && mod.status !== "drafted" && mod.status !== "failed") return null;
    }
    return data as CoursePlanFile;
  } catch {
    return null;
  }
}

/** Build a fresh checkpoint from an outline; every module starts "pending". */
export function newCoursePlan(courseRoot: string, prompt: string, outline: CourseOutline): CoursePlanFile {
  return {
    version: 1,
    courseRoot,
    prompt,
    createdAt: Date.now(),
    outline,
    modules: outline.modules.map((m) => ({ id: m.id, title: m.title, status: "pending" })),
  };
}

/** Persist the checkpoint, creating parent dirs; best-effort silent catch. */
export function saveCoursePlan(plan: CoursePlanFile): void {
  try {
    const file = planFilePath(plan.courseRoot);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(plan, null, 2), "utf8");
  } catch {
    // Checkpointing is best-effort: a read-only course dir must not crash the pipeline.
  }
}

/** Mutate one module's build status (no-op when id is unknown) and persist. */
export function markModule(
  plan: CoursePlanFile,
  id: string,
  patch: { status?: ModuleBuildStatus; error?: string; dir?: string },
): void {
  const module = plan.modules.find((m) => m.id === id);
  if (!module) return;
  if (patch.status !== undefined) module.status = patch.status;
  if (patch.error !== undefined) module.error = patch.error;
  if (patch.dir !== undefined) module.dir = patch.dir;
  saveCoursePlan(plan);
}
