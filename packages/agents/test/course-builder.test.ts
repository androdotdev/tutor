// Course-Builder tests: mock-SSE authoring loop with count-based scripting —
// module 01 drafts successfully (tool_calls then text), module 02 hits an
// empty stream (runtime fails, author session throws) and the loop must
// continue and record it as failed. Proves continue-on-error + plan resume.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCourse } from "../src/course-builder.ts";
import type { CourseOutline } from "../src/pipeline-types.ts";

let root: string;
let courseRoot: string;
let server: ReturnType<typeof Bun.serve>;
let port = 0;

// Count-based script (module-agnostic): call 1 = module 01 tool_calls,
// call 2 = module 01 text reply, call 3 = module 02 empty stream (failed).
let callCount = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lyceum-build-"));
  courseRoot = join(root, "course");

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("nf", { status: 404 });
      await req.json();
      callCount += 1;

      const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = (s: string) => controller.enqueue(new TextEncoder().encode(s));
          const push = (o: unknown) => enc(chunk(o));
          if (callCount === 1) {
            // Module 01: one tool call (run_tests), then the loop continues.
            push({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "c1",
                        type: "function",
                        function: { name: "run_tests", arguments: JSON.stringify({ module: "01" }) },
                      },
                    ],
                  },
                },
              ],
            });
            push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
          } else if (callCount === 2) {
            // Module 01: plain text finish.
            push({ choices: [{ delta: { content: "module 01 done" } }] });
            push({ choices: [{ delta: {}, finish_reason: "stop" }] });
          }
          // call 3 (module 02): nothing but [DONE] — the runtime treats that
          // as a failed run and createAuthorSession throws.
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
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const provider = () => ({
  provider: "openai" as const,
  apiKey: "mock",
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model: "mock-model",
  label: "mock",
});

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
    "drafts module 01, records module 02 as failed, and keeps going",
    async () => {
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
    },
    30_000,
  );
});
