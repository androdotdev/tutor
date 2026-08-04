// Scaffold/append guards: re-runs must never overwrite root docs or clobber
// existing module dirs.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addModule, nextModuleId, scaffoldCourse } from "../src/author";

const makeDir = () => mkdtempSync(join(tmpdir(), "lyceum-author-"));
const cleanup = (root: string) => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

describe("scaffoldCourse", () => {
  test("fresh dir: writes root docs + N modules", async () => {
    const root = makeDir();
    const res = await scaffoldCourse({ name: "Express Basics", moduleCount: 3 }, root);
    expect(res.modules).toHaveLength(3);
    expect(res.modules.map((m) => m.id)).toEqual(["00", "01", "02"]);
    expect(existsSync(join(root, "README.md"))).toBe(true);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    cleanup(root);
  });

  test("re-run on existing course: root docs untouched, ids append", async () => {
    const root = makeDir();
    await scaffoldCourse({ name: "Express Basics", moduleCount: 2 }, root);
    const readmeBefore = readFileSync(join(root, "README.md"), "utf8");
    const agentsBefore = readFileSync(join(root, "AGENTS.md"), "utf8");

    const res = await scaffoldCourse({ name: "Express Basics", moduleCount: 2 }, root);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe(readmeBefore);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(agentsBefore);
    expect(res.modules.map((m) => m.id)).toEqual(["02", "03"]);

    const dirs = readdirSync(join(root, "modules"));
    expect(new Set(dirs).size).toBe(dirs.length); // no collisions
    cleanup(root);
  });
});

describe("addModule / writeModuleFiles", () => {
  test("appends at the next free id by default", async () => {
    const root = makeDir();
    await scaffoldCourse({ name: "X", moduleCount: 1 }, root);
    expect(await nextModuleId(root)).toBe("01");
    const m = await addModule(root, { title: "Routing" });
    expect(m.id).toBe("01");
    expect(existsSync(join(root, "modules", m.dir, "exercise", "index.js"))).toBe(true);
    cleanup(root);
  });

  test("never clobbers: same id + same title bumps to the next free id", async () => {
    const root = makeDir();
    await scaffoldCourse({ name: "X", moduleCount: 1 }, root);
    const a = await addModule(root, { title: "Routing", id: "05" });
    const aReadme = readFileSync(join(root, "modules", a.dir, "README.md"), "utf8");
    const b = await addModule(root, { title: "Routing", id: "05" }); // collides -> bump
    expect(b.id).toBe("06");
    expect(b.dir).not.toBe(a.dir);
    expect(readFileSync(join(root, "modules", a.dir, "README.md"), "utf8")).toBe(aReadme); // untouched
    expect(existsSync(join(root, "modules", b.dir))).toBe(true);
    cleanup(root);
  });
});
