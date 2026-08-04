import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ScaffoldOptions {
  /** course name -> module 0 slug & title */
  name: string;
  /** optional guiding topic for the READMEs */
  topic?: string;
  /** number of modules (default 3) */
  moduleCount?: number;
}

export interface ScaffoldedModule {
  id: string;
  dir: string;
  title: string;
}
export interface ScaffoldResult {
  root: string;
  modules: ScaffoldedModule[];
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const pad2 = (n: number) => String(n).padStart(2, "0");

function moduleTitle(name: string, topic: string | undefined, i: number, total: number): string {
  if (i === 0) return name;
  if (topic) {
    const t = slugify(topic.charAt(0).toUpperCase() + topic.slice(1));
    return i === total - 1 ? `${t}: capstone` : `${t} — part ${i + 1}`;
  }
  return `Module ${i + 1}`;
}

function moduleReadme(title: string, topic: string | undefined): string {
  const topicLine = topic ? `Topic: **${topic}**` : "Topic: _fill me in_";
  return `# ${title}

${topicLine}

## How to work this module

1. Read this README carefully.
2. Open \`exercise/index.js\` and implement the missing parts.
3. Run the grader: \`bun test\`.
4. Iterate until it's green. The test output is the referee — not a hint.

## Self-check (Feynman)

- Explain, in your own words, what this module is really about.
- What single thing is most likely to be misunderstood here?
- Write the one-sentence summary you'd tell a classmate.
`;
}

function courseReadme(name: string, topic: string | undefined, count: number): string {
  const t = topic ? ` on **${topic}**` : "";
  return `# ${name}

A self-learning course${t} with **${count} modules**, scaffolded by lyceum.

Every module = README.md (teaching) + exercise/ (your stub) + tests/ (the grader).

Workflow: README → try it → run tests → Feynman. A final capstone lives in project/.

Run: \`lyceum\` (set LYCEUM_COURSE to this directory) to tutor yourself through it.
`;
}

const EXERCISE_STUB = `// Implement this file so the grader (tests/index.test.js) turns green.
// Do NOT edit tests/ — edit only this file.

export function hello() {
  // TODO: return a greeting containing the word "Hello"
  return "";
}
`;

const TEST_STUB = `import { describe, expect, test } from "bun:test";
import { hello } from "../exercise/index.js";

describe("module 00", () => {
  test("hello returns a greeting containing Hello", () => {
    expect(hello()).toContain("Hello");
  });
});
`;

/** Course companion: the AI-assisted-learning policy (from SKILL.md) that tutors this course. */
const COURSE_AGENTS_MD = `# Course AGENTS.md — AI-assisted learning policy

These rules guide any AI tool used on this course, including lyceum.

## Teaching style (Socratic)
- Never reveal a solution. Hint, ask, correct — don't hand out answers.
- Never rewrite the learner's files. Read + reason only.
- Ask what the learner tried before helping; one nudge at a time.
- Use Feynman: have the learner explain back; fix the misunderstanding, not the wording.

## Referee
- The tests/ grader is the ONLY referee. Run it and quote output verbatim.
- Never guess test results.

## Redact
- solutions/ and project solution files are PERMANENTLY redacted. Do not bypass.
`;

async function writeModuleFiles(
  modulesDir: string,
  id: string,
  title: string,
  topic: string | undefined,
): Promise<{ id: string; dir: string }> {
  let candidate = Number(id);
  let dir = `${pad2(candidate)}-${slugify(title)}`;
  // Never clobber: if the target module dir already exists (re-run, id
  // collision, resume after a partial failure), bump to the next free id.
  while (existsSync(join(modulesDir, dir))) {
    candidate += 1;
    dir = `${pad2(candidate)}-${slugify(title)}`;
  }
  const finalId = pad2(candidate);
  const modDir = join(modulesDir, dir);
  await mkdir(join(modDir, "exercise"), { recursive: true });
  await mkdir(join(modDir, "tests"), { recursive: true });
  await mkdir(join(modDir, "solutions"), { recursive: true });
  await writeFile(join(modDir, "README.md"), moduleReadme(title, topic));
  await writeFile(join(modDir, "exercise", "index.js"), EXERCISE_STUB);
  await writeFile(join(modDir, "tests", "index.test.js"), TEST_STUB);
  await writeFile(join(modDir, "solutions", ".gitkeep"), "");
  return { id: finalId, dir };
}

/** Create a fresh course tree per the SKILL.md spec. Deterministic — no LLM.
 * Re-running against a dir that already has modules/ switches to append mode:
 * root docs are left untouched, modules continue from the next free id. */
export async function scaffoldCourse(input: ScaffoldOptions, outDir: string): Promise<ScaffoldResult> {
  const count = Math.max(1, Math.min(12, input.moduleCount ?? 3));
  const modulesDir = join(outDir, "modules");
  let existing = false;
  try {
    existing = (await readdir(outDir)).includes("modules");
  } catch {
    // outDir does not exist yet — fresh scaffold below.
  }
  if (!existing) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "README.md"), courseReadme(input.name, input.topic, count));
    await writeFile(join(outDir, "AGENTS.md"), COURSE_AGENTS_MD);
  }
  await mkdir(modulesDir, { recursive: true });

  const startId = existing ? Number(await nextModuleId(outDir)) : 0;
  const modules: ScaffoldedModule[] = [];
  for (let i = 0; i < count; i++) {
    const id = pad2(startId + i);
    const title = moduleTitle(input.name, input.topic, i, count);
    const { id: finalId, dir } = await writeModuleFiles(modulesDir, id, title, input.topic);
    modules.push({ id: finalId, dir, title });
  }
  return { root: outDir, modules };
}

/** Append one module to an existing course (resolves the next 2-digit id). */
export async function nextModuleId(courseRoot: string): Promise<string> {
  const dirs = await readdir(join(courseRoot, "modules"), { withFileTypes: true });
  const max = dirs
    .filter((e) => e.isDirectory() && /^\d{2}/.test(e.name))
    .map((e) => Number(e.name.slice(0, 2)))
    .reduce((a, b) => Math.max(a, b), -1);
  return pad2(max + 1);
}

export async function addModule(
  courseRoot: string,
  opts: { title: string; topic?: string; id?: string },
): Promise<ScaffoldedModule> {
  const id = opts.id ?? (await nextModuleId(courseRoot));
  const title = opts.title;
  const { id: finalId, dir } = await writeModuleFiles(join(courseRoot, "modules"), id, title, opts.topic);
  return { id: finalId, dir, title };
}