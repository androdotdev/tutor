// Lazy-skills tests: list_skills returns names only; get_skill loads one file
// on demand with the same escape gates as read_file/grep.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCourse } from "@tutor/shared";
import { buildTools } from "../src/tools";
import type { PiAgentTool } from "../src/pi-tool";

/** Run a pi tool and return its structured payload (details). */
const call = async <T, R>(tool: PiAgentTool, params: T): Promise<R> =>
  (await tool.execute("test-call", params as never)).details as R;

type Tools = ReturnType<typeof buildTools>;
let list_skills: Tools["list_skills"];
let get_skill: Tools["get_skill"];

let root: string;
let skillsDir: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lyceum-skills-"));
  mkdirSync(join(root, "modules", "01-x", "exercises"), { recursive: true });
  writeFileSync(join(root, "modules", "01-x", "exercises", "student.js"), "student code");

  skillsDir = join(root, "skills");
  mkdirSync(skillsDir);
  writeFileSync(join(skillsDir, "feynman.md"), "Explain it back to a rubber duck.");
  writeFileSync(join(skillsDir, "learn-in-public.md"), "Publish what you learned.");
  writeFileSync(join(skillsDir, "NOT_A_SKILL.txt"), "ignored");
  // Symlinked skill pointing outside the skills dir: must be blocked.
  const outside = join(root, "outside-secret.md");
  writeFileSync(outside, "OUTSIDE_SECRET");
  symlinkSync(outside, join(skillsDir, "evil.md"));

  const modules = await resolveCourse(root);
  const tools = buildTools({ courseRoot: root, modules, skillsDir });
  list_skills = tools.list_skills;
  get_skill = tools.get_skill;
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("lazy skills", () => {
  test("list_skills returns names only (.txt excluded)", async () => {
    const r = await call(list_skills, {});
    expect(r.ok).toBe(true);
    // evil.md (a symlink) is listed by NAME — content stays gated behind get_skill.
    expect(r.skills).toEqual(["evil", "feynman", "learn-in-public"]);
  });

  test("get_skill loads the requested skill on demand", async () => {
    const r = await call(get_skill, { name: "feynman" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("rubber duck");
  });

  test("get_skill matches names case-insensitively", async () => {
    const r = await call(get_skill, { name: "Learn-In-Public" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Publish what you learned");
  });

  test("blocks a symlinked skill escaping the skills dir", async () => {
    const r = await call(get_skill, { name: "evil" });
    expect(r.blocked).toBe(true);
    expect(r.content).toBeUndefined();
  });

  test("rejects traversal names", async () => {
    const r = await call(get_skill, { name: "../outside-secret" });
    expect(r.ok).toBe(false);
  });

  test("unknown skill -> error, no crash", async () => {
    const r = await call(get_skill, { name: "nope" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('no skill named "nope"');
  });
});

describe("no skills dir", () => {
  test("list_skills is a no-op, get_skill errors politely", async () => {
    const modules = await resolveCourse(root);
    const bare = buildTools({ courseRoot: root, modules });
    const l = await call(bare.list_skills, {});
    expect(l.ok).toBe(true);
    expect(l.skills).toEqual([]);
    const g = await call(bare.get_skill, { name: "feynman" });
    expect(g.ok).toBe(false);
    expect(g.message).toContain("no skills directory configured");
  });
});
