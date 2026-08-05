// Course-Builder tests: mock-SSE authoring loop with per-test scripted call
// sequences. Test 1: module 01 drafts successfully (writes all three files,
// runs the grader, then finishes), module 02 hits an empty stream (runtime
// fails, author session throws) and the loop must continue and record it as
// failed — proves continue-on-error + plan resume. Test 2: a model that
// "finishes" without landing the files under modules/<dir>/ (wrote to a bare
// path at the course root) is marked FAILED, not drafted — the placement
// verification catches it, and the resume loop can retry.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCourse } from "../src/course-builder.ts";
import type { CourseOutline } from "../src/pipeline-types.ts";

let server: ReturnType<typeof Bun.serve>;
let port = 0;

// Each test installs its own scripted call sequence; the fetch handler just
// increments the shared counter and delegates.
let callCount = 0;
let lastBodies: unknown[] = [];
type Push = (o: unknown) => void;
type Enc = (s: string) => void;
let script: (call: number, push: Push, enc: Enc) => void = () => {};

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("nf", { status: 404 });
      lastBodies.push(await req.json());
      callCount += 1;

      const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = (s: string) => controller.enqueue(new TextEncoder().encode(s));
          const push = (o: unknown) => enc(chunk(o));
          script(callCount, push, enc);
          enc("data: [DONE]\n\n");
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  port = (server as unknown as { port: number }).port;
});

afterAll(() => {
  server.stop(true);
});

const provider = () => ({
  provider: "openai" as const,
  apiKey: "mock",
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model: "mock-model",
  label: "mock",
});

const toolCall = (index: number, id: string, name: string, args: unknown) => ({
  index,
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

/** Content that must survive the write gate and actually run under bun. */
const TEST_SRC = `import { describe, expect, test } from "bun:test";\nimport { add } from "../exercise/index.js";\ndescribe("add", () => {\n  test("1 + 1 = 2", () => expect(add(1, 1)).toBe(2));\n});\n`;
const EXERCISE_SRC = `// TODO: implement\n\nexport function add(a, b) {\n  throw new Error("not implemented");\n}\n`;

const WRITE = (index: number, id: string, path: string, content: string) =>
  toolCall(index, id, "write_file", { path, content });

/** Writes all three module files under modules/<dir>/, then grades, then finishes. */
function installDraftScript(moduleDir: string) {
  script = (call, push) => {
    if (call === 1) {
      push({
        choices: [
          {
            delta: {
              tool_calls: [
                WRITE(0, "w1", `${moduleDir}/tests/index.test.js`, TEST_SRC),
                WRITE(1, "w2", `${moduleDir}/exercise/index.js`, EXERCISE_SRC),
                WRITE(2, "w3", `${moduleDir}/README.md`, "# First Module"),
              ],
            },
          },
        ],
      });
      push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else if (call === 2) {
      push({ choices: [{ delta: { tool_calls: [toolCall(0, "r1", "run_tests", { module: "01" })] } }] });
      push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else if (call === 3) {
      push({ choices: [{ delta: { content: "module 01 done" } }] });
      push({ choices: [{ delta: {}, finish_reason: "stop" }] });
    }
    // call >= 4: no tool calls, no content — the runtime treats the bare
    // [DONE] as a failed run and createAuthorSession throws.
  };
}

const outline: CourseOutline = {
  name: "Mock Course",
  topic: "mock topic",
  modules: [
    { id: "01", title: "First Module", concepts: ["alpha", "beta"], difficulty: "intro" },
    { id: "02", title: "Second Module", concepts: ["gamma"], difficulty: "core" },
  ],
};

describe("buildCourse", () => {
  test(
    "drafts module 01 (files land under modules/), records module 02 as failed, and keeps going",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lyceum-build-"));
      const courseRoot = join(root, "course");
      try {
        callCount = 0;
        installDraftScript("modules/01-first-module");

        const result = await buildCourse({
          provider: provider(),
          courseRoot,
          outline,
          prompt: "build a mock course",
        });

        expect(result.drafted).toBe(1);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]).toMatchObject({ id: "02", title: "Second Module" });
        expect(result.failed[0].error.length).toBeGreaterThan(0);

        // The three authored files actually landed under modules/01-first-module/.
        for (const f of ["tests/index.test.js", "exercise/index.js", "README.md"]) {
          expect(existsSync(join(courseRoot, "modules", "01-first-module", f))).toBe(true);
        }

        // Checkpoint: module statuses persisted for both modules.
        const plan = JSON.parse(readFileSync(join(courseRoot, ".lyceum", "plan.json"), "utf8")) as {
          modules: Array<{ id: string; status: string; dir?: string }>;
        };
        const byId = new Map(plan.modules.map((m) => [m.id, m]));
        expect(byId.get("01")).toMatchObject({ status: "drafted", dir: "01-first-module" });
        expect(byId.get("02")).toMatchObject({ status: "failed", dir: "02-second-module" });

        // Skeleton dirs pre-created for both modules (exercise/ + tests/).
        for (const dir of ["01-first-module", "02-second-module"]) {
          expect(existsSync(join(courseRoot, "modules", dir, "exercise"))).toBe(true);
          expect(existsSync(join(courseRoot, "modules", dir, "tests"))).toBe(true);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "a run that writes to a bare course-root path is FAILED, not drafted",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lyceum-misplaced-"));
      const courseRoot = join(root, "course");
      try {
        callCount = 0;
        // The old bug: the prompt said "Write module/tests/index.test.js", so
        // the model wrote to course/module/... — outside modules/<dir>/. The
        // writes succeed (they're inside the course root); placement is wrong.
        installDraftScript("module");
        // The watchdog continues the run after the text-only summary; give it
        // one more text-only reply so the run ends cleanly and the placement
        // verification (not a stream error) decides the outcome.
        const baseScript = script;
        script = (call, push, enc) => {
          if (call === 4) {
            push({ choices: [{ delta: { content: "I am done." } }] });
            push({ choices: [{ delta: {}, finish_reason: "stop" }] });
          } else {
            baseScript(call, push, enc);
          }
        };

        const result = await buildCourse({
          provider: provider(),
          courseRoot,
          outline: { ...outline, modules: [outline.modules[0]] },
          prompt: "build a mock course",
        });

        expect(result.drafted).toBe(0);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].error).toContain("authored files missing");
        expect(result.failed[0].error).toContain("tests/index.test.js");

        // The misplaced files DID land — proves the write path executed and
        // the failure is purely about placement.
        expect(existsSync(join(courseRoot, "module", "tests", "index.test.js"))).toBe(true);
        expect(existsSync(join(courseRoot, "modules", "01-first-module", "tests", "index.test.js"))).toBe(false);

        // Checkpoint records the failure so a re-run resumes this module.
        const plan = JSON.parse(readFileSync(join(courseRoot, ".lyceum", "plan.json"), "utf8")) as {
          modules: Array<{ id: string; status: string }>;
        };
        expect(plan.modules.find((m) => m.id === "01")?.status).toBe("failed");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "a text-only first reply is rescued: the run continues with a nudge and drafts the module",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lyceum-rescue-"));
      const courseRoot = join(root, "course");
      try {
        callCount = 0;
        lastBodies = [];
        const moduleDir = "modules/01-first-module";
        script = (call, push) => {
          if (call === 1) {
            // The hy3 failure mode: analyze in prose, no tool calls. Without
            // the watchdog this text-only turn ENDS the run with zero files.
            push({ choices: [{ delta: { content: "Let me design this module first." } }] });
            push({ choices: [{ delta: {}, finish_reason: "stop" }] });
          } else if (call === 2) {
            push({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      WRITE(0, "w1", `${moduleDir}/tests/index.test.js`, TEST_SRC),
                      WRITE(1, "w2", `${moduleDir}/exercise/index.js`, EXERCISE_SRC),
                      WRITE(2, "w3", `${moduleDir}/README.md`, "# First Module"),
                    ],
                  },
                },
              ],
            });
            push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
          } else if (call === 3) {
            push({ choices: [{ delta: { tool_calls: [toolCall(0, "r1", "run_tests", { module: "01" })] } }] });
            push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
          } else if (call === 4) {
            push({ choices: [{ delta: { content: "module 01 done" } }] });
            push({ choices: [{ delta: {}, finish_reason: "stop" }] });
          }
        };

        const result = await buildCourse({
          provider: provider(),
          courseRoot,
          outline: { ...outline, modules: [outline.modules[0]] },
          prompt: "build a mock course",
        });

        expect(result.drafted).toBe(1);
        expect(result.failed).toHaveLength(0);

        // The rescue nudge rode into the model's second request as a user message.
        const secondBody = lastBodies[1] as { messages: Array<{ role: string; content: unknown }> };
        const text = (m: { content: unknown }): string =>
          Array.isArray(m.content)
            ? m.content
                .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
                .join("")
            : String(m.content);
        expect((secondBody.messages ?? []).map(text).join("\n")).toContain(
          "You ended your reply without writing any files",
        );

        for (const f of ["tests/index.test.js", "exercise/index.js", "README.md"]) {
          expect(existsSync(join(courseRoot, "modules", "01-first-module", f))).toBe(true);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
