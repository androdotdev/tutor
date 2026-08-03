import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, basename, relative, sep } from "node:path";
import type { ModuleDesc } from "./types";

const MODULE_RE = /^\d{2}/;

function titleOf(dir: string): string {
  return dir
    .replace(/^\d{2}-/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const exists = (p: string) => existsSync(p);

async function listFiles(absDir: string): Promise<string[]> {
  return (await readdir(absDir, { withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(absDir, e.name))
    .sort();
}

async function firstSourceFile(absDir: string): Promise<string | null> {
  if (!exists(absDir)) return null;
  const files = await listFiles(absDir);
  return (
    files.find(
      (f) =>
        !/\.test\./i.test(basename(f)) && /\.(js|jsx|ts|tsx|py|go|rs|c|cpp)$/.test(f),
    ) ?? files[0] ??
    null
  );
}

/**
 * Hard spoiler gate: anything under a `solutions` path segment (any casing), or a
 * solution-named file inside a `project` dir (`project/solution.js`), is off-limits.
 * Mirrors the resolver's own /solution/i classification of project files below.
 */
export function isSpoiler(courseRoot: string, absPath: string): boolean {
  const rel = relative(courseRoot, absPath).split(sep);
  if (rel.some((seg) => /^solutions/i.test(seg))) return true;
  for (let i = 0; i + 1 < rel.length; i++) {
    if (/^project$/i.test(rel[i]) && /solution/i.test(rel[i + 1])) return true;
  }
  return false;
}

async function probeModule(moduleDir: string, dir: string): Promise<ModuleDesc> {
  const modernTests = join(moduleDir, "tests");
  const modernExercise = join(moduleDir, "exercise");
  const modernSolutions = join(moduleDir, "solutions");
  const projectDir = join(moduleDir, "project");

  if (exists(modernTests) && exists(modernExercise)) {
    const solutionPaths: string[] = [];
    if (exists(modernSolutions)) solutionPaths.push(...(await listFiles(modernSolutions)));
    if (exists(projectDir)) {
      solutionPaths.push(
        ...(await listFiles(projectDir)).filter((p) => /solution/i.test(basename(p))),
      );
    }
    return {
      dir,
      id: dir.slice(0, 2),
      title: titleOf(dir),
      layout: "modern",
      moduleDir,
      readme: exists(join(moduleDir, "README.md")) ? join(moduleDir, "README.md") : null,
      student: await firstSourceFile(modernExercise),
      testTargets: [modernTests],
      solutionPaths,
      projectDir: exists(projectDir) ? projectDir : null,
    };
  }

  // legacy layout (this repo): exercises/ + project/solution.js + solutions/*-all.js
  const exercisesDir = join(moduleDir, "exercises");
  const solutionsDir = join(moduleDir, "solutions");
  const solutionPaths: string[] = [];
  if (exists(solutionsDir)) solutionPaths.push(...(await listFiles(solutionsDir)));
  if (exists(projectDir)) {
    solutionPaths.push(
      ...(await listFiles(projectDir)).filter((p) => /solution/i.test(basename(p))),
    );
  }
  const studentPath = exists(join(exercisesDir, "student.js"))
    ? join(exercisesDir, "student.js")
    : exists(join(exercisesDir, "student.ts"))
      ? join(exercisesDir, "student.ts")
      : null;

  return {
    dir,
    id: dir.slice(0, 2),
    title: titleOf(dir),
    layout: "legacy",
    moduleDir,
    readme: exists(join(moduleDir, "README.md")) ? join(moduleDir, "README.md") : null,
    student: studentPath,
    testTargets: exists(exercisesDir) ? [exercisesDir] : [],
    solutionPaths,
    projectDir: exists(projectDir) ? projectDir : null,
  };
}

/** Resolve a course directory into its modules. Pure, deterministic. */
export async function resolveCourse(root: string): Promise<ModuleDesc[]> {
  const modulesDir = join(root, "modules");
  if (!exists(modulesDir)) return [];
  const entries = (await readdir(modulesDir, { withFileTypes: true })).filter(
    (e) => e.isDirectory() && MODULE_RE.test(e.name),
  );
  const modules: ModuleDesc[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    modules.push(await probeModule(join(modulesDir, e.name), e.name));
  }
  return modules;
}

export async function findModule(modules: ModuleDesc[], target: string): Promise<ModuleDesc | null> {
  const want = target.replace(/^modules\//, "").toLowerCase();
  return (
    modules.find(
      (m) =>
        m.dir === target ||
        m.dir.replace(/^\d{2}-/, "") === want ||
        m.id === target ||
        m.title.toLowerCase() === want,
    ) ?? null
  );
}