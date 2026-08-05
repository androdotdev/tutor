// Planner stage tests: mock-SSE outline handoff (the model writes
// .lyceum/outline.json via write_file; the stage reads + validates it on real
// disk), covering round-trip, retry, hard failure, and module cap, plus
// course-plan checkpoint file round-trips.
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
let lastBody: unknown;
let server: ReturnType<typeof Bun.serve>;
let port = 0;
let courseRoot: string;

beforeAll(async () => {
  courseRoot = mkdtempSync(join(tmpdir(), "lyceum-plan-stage-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("nf", { status: 404 });
      lastBody = await req.json();
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
  try {
    rmSync(courseRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** The model's delivery channel: a write_file turn carrying the outline JSON. */
function writeOutline(args: unknown): ScriptTurn {
  return {
    tool: {
      name: "write_file",
      args: { path: ".lyceum/outline.json", content: JSON.stringify(args) },
    },
  };
}

/** Fresh slate: a stale outline file from a previous test must not leak in. */
function resetOutline(): void {
  rmSync(join(courseRoot, ".lyceum"), { recursive: true, force: true });
}

const provider = () => ({
  provider: "openai" as const,
  apiKey: "mock",
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model: "mock-model",
  label: "mock",
});

describe("planCourse", () => {
  test("returns the written outline exactly, sources included", async () => {
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
    script = [writeOutline(outline), { content: "done" }];
    callCount = 0;
    resetOutline();

    const result = await planCourse({ provider: provider(), prompt: "learn the bun runtime end to end", courseRoot });

    expect(result).toEqual(outline);
    expect(result.modules[2].sources).toEqual(["https://bun.sh/docs/http/server", "https://bun.sh/docs/test"]);
  });

  test("keeps research findings and topic in the user turn, not the system prompt", async () => {
    const outline: CourseOutline = {
      name: "Docker",
      topic: "docker",
      modules: [
        { id: "01", title: "Images", concepts: ["build", "layers"], difficulty: "intro" },
        { id: "02", title: "Compose", concepts: ["services", "volumes"], difficulty: "core" },
      ],
    };
    script = [writeOutline(outline), { content: "done" }];
    callCount = 0;
    resetOutline();

    const result = await planCourse({
      provider: provider(),
      prompt: "docker",
      courseRoot,
      research: {
        findings: [{ claim: "Dockerfile layers are cached", source_url: "https://docs.docker.com/build/cache/" }],
        caveats: "thin",
      },
    });

    expect(result).toEqual(outline);
    const body = lastBody as { messages: Array<{ role: string; content: unknown }> };
    const text = (m: { content: unknown }): string =>
      Array.isArray(m.content)
        ? m.content
            .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
            .join("")
        : String(m.content);
    const system = text(body.messages.find((m) => m.role === "system") ?? { content: "" });
    const user = text(body.messages.find((m) => m.role === "user") ?? { content: "" });
    expect(system).toContain("curriculum designer");
    expect(system).not.toContain("Research findings");
    expect(system).not.toContain("Dockerfile layers are cached");
    expect(user).toContain("Topic: docker");
    expect(user).toContain("Dockerfile layers are cached");
    expect(user).toContain("https://docs.docker.com/build/cache/");
  });

  test("retries once when the first reply writes no outline file", async () => {
    const outline: CourseOutline = {
      name: "Git Essentials",
      topic: "version control with git",
      modules: [
        { id: "01", title: "Local Repos", concepts: ["init", "commit", "status"], difficulty: "intro" },
        { id: "02", title: "Branches and Merges", concepts: ["branch", "merge", "conflicts"], difficulty: "core" },
      ],
    };
    script = [{ content: "Let me think about the structure first." }, writeOutline(outline), { content: "done" }];
    callCount = 0;
    resetOutline();

    const result = await planCourse({ provider: provider(), prompt: "version control with git", courseRoot });

    expect(result).toEqual(outline);
  });

  test("throws when the model never writes a valid outline", async () => {
    script = [
      { content: "No tools here, just text." },
      { content: "Still refusing to call write_file." },
    ];
    callCount = 0;
    resetOutline();

    await expect(planCourse({ provider: provider(), prompt: "anything", courseRoot })).rejects.toThrow(/Plan stage failed: the model finished without writing \.lyceum\/outline\.json/);
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
    script = [writeOutline(short), writeOutline(exact)];
    callCount = 0;
    resetOutline();

    const result = await planCourse({ provider: provider(), prompt: "http fundamentals", courseRoot, moduleCountOverride: 4 });

    expect(result.modules).toHaveLength(4);
  });
});

describe("course plan checkpoint file", () => {
  let root: string;
  let planRoot: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lyceum-plan-"));
    planRoot = join(root, "course");
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
    const plan = newCoursePlan(planRoot, "typed javascript", outline);
    expect(plan.version).toBe(1);
    expect(plan.createdAt).toBeGreaterThan(0);
    expect(plan.modules).toEqual([
      { id: "01", title: "Types", status: "pending" },
      { id: "02", title: "Generics", status: "pending" },
      { id: "03", title: "Builds", status: "pending" },
    ]);

    saveCoursePlan(plan);
    const loaded = loadCoursePlan(planRoot);
    expect(loaded).not.toBeNull();
    if (!loaded) throw new Error("expected a plan file after save");
    expect(loaded).toMatchObject({ version: 1, courseRoot: planRoot, prompt: "typed javascript", outline });
    expect(loaded.modules).toEqual(plan.modules);
  });

  test("markModule updates a module and persists the change", () => {
    const plan = newCoursePlan(planRoot, "typed javascript", outline);
    saveCoursePlan(plan);

    markModule(plan, "01", { status: "drafted", dir: "modules/01" });
    markModule(plan, "02", { status: "failed", error: "authoring crashed" });
    expect(plan.modules[0]).toMatchObject({ id: "01", status: "drafted", dir: "modules/01" });
    expect(plan.modules[1]).toMatchObject({ id: "02", status: "failed", error: "authoring crashed" });

    const loaded = loadCoursePlan(planRoot);
    if (!loaded) throw new Error("expected a plan file after markModule");
    expect(loaded.modules[0]).toMatchObject({ id: "01", status: "drafted", dir: "modules/01" });
    expect(loaded.modules[1]).toMatchObject({ id: "02", status: "failed", error: "authoring crashed" });

    // Unknown ids are a no-op: nothing is persisted.
    markModule(plan, "99", { status: "failed" });
    expect(loadCoursePlan(planRoot)?.modules[0].status).toBe("drafted");
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
