// Regression test for the "content landed at the course root instead of
// modules/<dir>/" bug: the author system prompt used to say "Write
// module/tests/index.test.js" — a bare template with no plural "modules/"
// segment and no module.dir substituted in — so a model reasonably resolved
// it to "<dir>/tests/index.test.js" (sibling of modules/, not inside it).
// This pins the prompt to the literal path template it must contain.
import { describe, expect, test } from "bun:test";
import { buildAuthorPrompt } from "../src/author.ts";
import type { ModuleDesc } from "@tutor/shared";

const module: ModuleDesc = {
  dir: "01-containerizing-applications",
  id: "01",
  title: "Containerizing Applications",
  layout: "standard",
  moduleDir: "/course/modules/01-containerizing-applications",
  readme: null,
  student: null,
  testTargets: [],
  solutionPaths: [],
  projectDir: null,
};

describe("buildAuthorPrompt", () => {
  test("every write target is prefixed with modules/<dir>/, not a bare 'module/' template", () => {
    const prompt = buildAuthorPrompt(module);
    const base = `modules/${module.dir}`;

    expect(prompt).toContain(`${base}/tests/index.test.js`);
    expect(prompt).toContain(`${base}/exercise/index.js`);
    expect(prompt).toContain(`${base}/README.md`);
    expect(prompt).toContain(`${base}/solutions/`);

    // The literal bare-template phrasing that caused the bug must not reappear.
    expect(prompt).not.toContain("Write module/tests/index.test.js");
    expect(prompt).not.toContain("Write module/exercise/index.js");
    expect(prompt).not.toContain("Write module/README.md");
  });
});
