// Spoiler-gate regression tests: the mechanical invariant that the model can
// NEVER read (or, in author mode, write) solutions/ or project solution stubs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { REDACTED_MESSAGE } from "@tutor/shared";
import { resolveCourse } from "@tutor/shared";
import { buildAuthorTools, buildTools } from "../src/tools";

const SECRET = "TOP_SECRET_TEACHER_COPY";

let root: string;
let sibling: string;
let ctx: { courseRoot: string; modules: Awaited<ReturnType<typeof resolveCourse>> };
// Assigned in beforeAll (describe bodies run before beforeAll in bun:test).
type TutorTools = ReturnType<typeof buildTools>;
type AuthorTools = ReturnType<typeof buildAuthorTools>;
let read_file: TutorTools["read_file"];
let write_file: AuthorTools["write_file"];
let grep: TutorTools["grep"];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lyceum-gate-"));
  const legacy = join(root, "modules", "01-legacy");
  const modern = join(root, "modules", "02-modern");
  for (const [dir, layout] of [[legacy, "legacy"], [modern, "modern"]] as const) {
    if (layout === "legacy") {
      mkdirSync(join(dir, "exercises"), { recursive: true });
      mkdirSync(join(dir, "solutions"), { recursive: true });
      mkdirSync(join(dir, "project"), { recursive: true });
      writeFileSync(join(dir, "exercises", "student.js"), "student code");
      writeFileSync(join(dir, "solutions", "01-all.js"), SECRET);
      writeFileSync(join(dir, "project", "solution.js"), SECRET);
    } else {
      mkdirSync(join(dir, "exercise"), { recursive: true });
      mkdirSync(join(dir, "tests"), { recursive: true });
      mkdirSync(join(dir, "solutions"), { recursive: true });
      mkdirSync(join(dir, "project"), { recursive: true });
      writeFileSync(join(dir, "exercise", "index.js"), "student code");
      writeFileSync(join(dir, "tests", "index.test.js"), "import { test } from 'bun:test'; test('x', () => {});");
      writeFileSync(join(dir, "solutions", "01-all.js"), SECRET);
      writeFileSync(join(dir, "project", "solution.js"), SECRET);
    }
  }
  // Symlink inside the course pointing at the solution (lexical path is innocent).
  symlinkSync(join(legacy, "solutions", "01-all.js"), join(legacy, "exercises", "peek.js"));
  // Sibling dir whose basename EXTENDS the course basename: `startsWith(root)`
  // without a trailing separator treats it as inside the course (prefix collision).
  sibling = root + "2";
  mkdirSync(join(sibling, "modules", "01-x", "exercises"), { recursive: true });
  writeFileSync(join(sibling, "modules", "01-x", "exercises", "student.js"), "SIBLING_STUDENT");

  ctx = { courseRoot: root, modules: await resolveCourse(root) };
  const tools = buildTools(ctx);
  read_file = tools.read_file;
  grep = tools.grep;
  write_file = buildAuthorTools(ctx).write_file;
});

afterAll(() => {
  // Best-effort cleanup of the temp course.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { rmSync } = require("node:fs");
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("read_file spoiler gate", () => {
  test("blocks solutions/01-all.js", async () => {
    const r = await read_file.execute({ path: "modules/01-legacy/solutions/01-all.js" });
    expect(r.blocked).toBe(true);
    expect(r.message).toContain("REDACTED");
  });

  test("blocks modern solutions/01-all.js", async () => {
    const r = await read_file.execute({ path: "modules/02-modern/solutions/01-all.js" });
    expect(r.blocked).toBe(true);
    expect(r.message).toBe(REDACTED_MESSAGE);
  });

  test("blocks legacy project/solution.js", async () => {
    const r = await read_file.execute({ path: "modules/01-legacy/project/solution.js" });
    expect(r.blocked).toBe(true);
    expect(r.message).toBe(REDACTED_MESSAGE);
  });

  test("blocks modern project/solution.js", async () => {
    const r = await read_file.execute({ path: "modules/02-modern/project/solution.js" });
    expect(r.blocked).toBe(true);
    expect(r.message).toBe(REDACTED_MESSAGE);
  });

  test("blocks a symlink pointing at a solution", async () => {
    const r = await read_file.execute({ path: "modules/01-legacy/exercises/peek.js" });
    expect(r.blocked).toBe(true);
    expect(r.message).toBe(REDACTED_MESSAGE);
  });

  test("blocks traversal into a sibling dir sharing the course basename", async () => {
    const escape = join("..", sibling.split(sep)[sibling.split(sep).length - 1], "modules", "01-x", "exercises", "student.js");
    // Sanity: the escape target exists and the lexical path passes the OLD bare
    // startsWith check (that is the exact regression this test guards).
    const abs = join(root, escape);
    expect(abs.startsWith(root)).toBe(true);
    const r = await read_file.execute({ path: escape });
    expect(r.blocked).toBe(true);
  });

  test("blocks absolute-path escapes", async () => {
    const r = await read_file.execute({ path: "../../../../../../etc/hostname" });
    expect(r.blocked).toBe(true);
  });

  test("returns normal student files", async () => {
    const r = await read_file.execute({ path: "modules/01-legacy/exercises/student.js" });
    expect(r.blocked).toBeFalsy();
    expect(r.content).toBe("student code");
  });
});

describe("write_file spoiler gate (author mode)", () => {
  test("blocks overwriting project/solution.js", async () => {
    const r = await write_file.execute({
      path: "modules/01-legacy/project/solution.js",
      content: "clobbered",
    });
    expect(r.blocked).toBe(true);
    expect(readFileSync(join(root, "modules", "01-legacy", "project", "solution.js"), "utf8")).toBe(SECRET);
  });

  test("blocks writing into solutions/", async () => {
    const r = await write_file.execute({
      path: "modules/01-legacy/solutions/new-file.js",
      content: "clobbered",
    });
    expect(r.blocked).toBe(true);
  });

  test("blocks writing through a symlink", async () => {
    const r = await write_file.execute({
      path: "modules/01-legacy/exercises/peek.js",
      content: "clobbered",
    });
    expect(r.blocked).toBe(true);
    expect(readFileSync(join(root, "modules", "01-legacy", "solutions", "01-all.js"), "utf8")).toBe(SECRET);
  });

  test("blocks traversal writes outside the course", async () => {
    const r = await write_file.execute({
      path: join("..", sibling.split(sep)[sibling.split(sep).length - 1], "modules", "01-x", "tests", "index.test.js"),
      content: "clobbered",
    });
    expect(r.blocked).toBe(true);
  });

  test("writes normal course files, creating parent dirs", async () => {
    const r = await write_file.execute({
      path: "modules/01-legacy/exercises/new/deep/student2.js",
      content: "fresh",
    });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(root, "modules", "01-legacy", "exercises", "new", "deep", "student2.js"), "utf8")).toBe("fresh");
  });
});

describe("grep spoiler gate", () => {
  test("finds matches in normal course files", async () => {
    const r = await grep.execute({ pattern: "student code" });
    expect(r.ok).toBe(true);
    expect(r.matches.some((m) => m.includes("modules/01-legacy/exercises/student.js:1"))).toBe(true);
    expect(r.matches.some((m) => m.includes("modules/02-modern/exercise/index.js:1"))).toBe(true);
  });

  test("never searches solutions/ or project solution stubs", async () => {
    // SECRET lives ONLY in solutions/ and project/solution.js files — including
    // through the innocent-looking symlink exercises/peek.js.
    const r = await grep.execute({ pattern: SECRET });
    expect(r.ok).toBe(true);
    expect(r.matches[0]).toBe("no matches (solutions/ is never searched)");
  });

  test("never reports matches outside the course root", async () => {
    const r = await grep.execute({ pattern: "SIBLING_STUDENT" });
    expect(r.ok).toBe(true);
    expect(r.matches[0]).toBe("no matches (solutions/ is never searched)");
  });

  test("reports invalid regex instead of crashing", async () => {
    const r = await grep.execute({ pattern: "(" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("invalid regex");
  });
});
