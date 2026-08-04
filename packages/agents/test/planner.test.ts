// Planner stage tests: mock-SSE outline capture (round-trip, retry, hard
// failure, module cap) plus course-plan checkpoint file round-trips.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCourse } from "../src/planner.ts";
import { loadCoursePlan, markModule, newCoursePlan, saveCoursePlan } from "../src/plan-file.ts";
import type { CourseOutline } from "../src/pipeline-types.ts";

/** One scripted model reply: either a tool_calls turn or a plain text turn. */
interface ScriptTurn {
  content?: string;
  tool?: { name: string; args: unknown };
}

let script: ScriptTurn[] = [];
let callCount = 0;
let server: ReturnType<typeof Bun.serve>;
let port = 0;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("nf", { status: 404 });
      await req.json();
      const turn = script[callCount];
      callCount += 1;

      const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = (s: string) => controller.enqueue(new TextEncoder().encode(s));
          const push = (o: unknown) => enc(chunk(o));
          if (turn?.tool) {
            push({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "c1",
                        type: "function",
                        function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) },
                      },
                    ],
                  },
                },
              ],
            });
            push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
          } else {
            push({ choices: [{ delta: { content: turn?.content ?? "" } }] });
            push({ choices: [{ delta: {}, finish_reason: "stop" }] });
          }
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

describe("planCourse", () => {
  test("returns the submitted outline exactly, sources included", async () => {
    const outline: CourseOutline = {
      name: "Bun Foundations",
      topic: "learn the bun runtime end to end",
      modules: [
        { id: "01", title: "Runtime Basics", concepts: ["bun init", "scripts", "watch mode"], difficulty: "intro" },
        {
          id: "02",
          title: "Bundling and Testing",
          concepts: ["bun build", "bun test", "assertions"],
          difficulty: "core",
        },
        {
          id: "03",
          title: "Servers and Deployment",
          concepts: ["Bun.serve", "HTTP lifecycle", "deploying"],
          difficulty: "capstone",
          sources: ["https://bun.sh/docs/http/server", "https://bun.sh/docs/test"],
        },
      ],
    };
    script = [{ tool: { name: "submit_outline", args: outline } }, { content: "done" }];
    callCount = 0;

    const result = await planCourse({ provider: provider(), prompt: "learn the bun runtime end to end" });

    expect(result).toEqual(outline);
    expect(result.modules[2].sources).toEqual(["https://bun.sh/docs/http/server", "https://bun.sh/docs/test"]);
  });

  test("retries once when the first reply has no submit_outline call", async () => {
    const outline: CourseOutline = {
      name: "Git Essentials",
      topic: "version control with git",
      modules: [
        { id: "01", title: "Local Repos", concepts: ["init", "commit", "status"], difficulty: "intro" },
        { id: "02", title: "Branches and Merges", concepts: ["branch", "merge", "conflicts"], difficulty: "core" },
      ],
    };
    script = [
      { content: "Let me think about the structure first." },
      { tool: { name: "submit_outline", args: outline } },
      { content: "done" },
    ];
    callCount = 0;

    const result = await planCourse({ provider: provider(), prompt: "version control with git" });

    expect(result).toEqual(outline);
  });

  test("throws when the model never submits a valid outline", async () => {
    script = [
      { content: "No tools here, just text." },
      { content: "Still refusing to call submit_outline." },
    ];
    callCount = 0;

    await expect(planCourse({ provider: provider(), prompt: "anything" })).rejects.toThrow(/valid course outline/);
  });

  test("moduleCountOverride requires an exact module count, retrying on mismatch", async () => {
    const short: CourseOutline = {
      name: "HTTP",
      topic: "http fundamentals",
      modules: [
        { id: "01", title: "Requests", concepts: ["methods", "headers"], difficulty: "intro" },
        { id: "02", title: "Responses", concepts: ["status codes", "bodies"], difficulty: "core" },
        { id: "03", title: "Servers", concepts: ["routing", "middleware"], difficulty: "capstone" },
      ],
    };
    const exact: CourseOutline = {
      name: "HTTP",
      topic: "http fundamentals",
      modules: [
        ...short.modules,
        { id: "04", title: "Caching", concepts: ["etags", "cache headers"], difficulty: "capstone" },
      ],
    };
    script = [
      { tool: { name: "submit_outline", args: short } },
      { content: "done" },
      { tool: { name: "submit_outline", args: exact } },
      { content: "done" },
    ];
    callCount = 0;

    const result = await planCourse({ provider: provider(), prompt: "http fundamentals", moduleCountOverride: 4 });

    expect(result.modules).toHaveLength(4);
  });
});

describe("course plan checkpoint file", () => {
  let root: string;
  let courseRoot: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lyceum-plan-"));
    courseRoot = join(root, "course");
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const outline: CourseOutline = {
    name: "TypeScript",
    topic: "typed javascript",
    modules: [
      { id: "01", title: "Types", concepts: ["annotations", "inference"], difficulty: "intro" },
      { id: "02", title: "Generics", concepts: ["constraints", "variance"], difficulty: "core" },
      { id: "03", title: "Builds", concepts: ["tsc", "module resolution"], difficulty: "capstone" },
    ],
  };

  test("newCoursePlan -> saveCoursePlan -> loadCoursePlan round-trips", () => {
    const plan = newCoursePlan(courseRoot, "typed javascript", outline);
    expect(plan.version).toBe(1);
    expect(plan.createdAt).toBeGreaterThan(0);
    expect(plan.modules).toEqual([
      { id: "01", title: "Types", status: "pending" },
      { id: "02", title: "Generics", status: "pending" },
      { id: "03", title: "Builds", status: "pending" },
    ]);

    saveCoursePlan(plan);
    const loaded = loadCoursePlan(courseRoot);
    expect(loaded).not.toBeNull();
    if (!loaded) throw new Error("expected a plan file after save");
    expect(loaded).toMatchObject({ version: 1, courseRoot, prompt: "typed javascript", outline });
    expect(loaded.modules).toEqual(plan.modules);
  });

  test("markModule updates a module and persists the change", () => {
    const plan = newCoursePlan(courseRoot, "typed javascript", outline);
    saveCoursePlan(plan);

    markModule(plan, "01", { status: "drafted", dir: "modules/01" });
    markModule(plan, "02", { status: "failed", error: "authoring crashed" });
    expect(plan.modules[0]).toMatchObject({ id: "01", status: "drafted", dir: "modules/01" });
    expect(plan.modules[1]).toMatchObject({ id: "02", status: "failed", error: "authoring crashed" });

    const loaded = loadCoursePlan(courseRoot);
    if (!loaded) throw new Error("expected a plan file after markModule");
    expect(loaded.modules[0]).toMatchObject({ id: "01", status: "drafted", dir: "modules/01" });
    expect(loaded.modules[1]).toMatchObject({ id: "02", status: "failed", error: "authoring crashed" });

    // Unknown ids are a no-op: nothing is persisted.
    markModule(plan, "99", { status: "failed" });
    expect(loadCoursePlan(courseRoot)?.modules[0].status).toBe("drafted");
  });

  test("loadCoursePlan on a missing directory returns null", () => {
    expect(loadCoursePlan(join(root, "does-not-exist"))).toBeNull();
  });

  test("loadCoursePlan on a corrupt file returns null", () => {
    const corrupt = join(root, "corrupt");
    mkdirSync(join(corrupt, ".lyceum"), { recursive: true });
    writeFileSync(join(corrupt, ".lyceum", "plan.json"), "{nope");
    expect(loadCoursePlan(corrupt)).toBeNull();
  });
});
