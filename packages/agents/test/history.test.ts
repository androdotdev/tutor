// Session-history tests: per-course file persistence, model seeding on resume,
// failed-run handling, and the seed window cap.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCourse, type ModuleDesc } from "@tutor/shared";
import { createTutorSession, loadHistoryFile, saveHistoryFile } from "../src/session";

const PORT = 17896;
let root: string;
let courseRoot: string;
let modules: ModuleDesc[];
let module: ModuleDesc;
let historyFile: string;

// Scriptable mock: "echo" replies a fixed text; "empty" streams nothing
// (the runtime treats that as a failed run).
let mode: "echo" | "empty" = "echo";
const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lyceum-hist-"));
  courseRoot = join(root, "course");
  mkdirSync(join(courseRoot, "modules", "01-x", "exercises"), { recursive: true });
  writeFileSync(join(courseRoot, "modules", "01-x", "exercises", "student.js"), "student code");
  writeFileSync(join(courseRoot, "modules", "01-x", "README.md"), "# Module X");
  modules = await resolveCourse(courseRoot);
  module = modules[0];
  historyFile = join(courseRoot, "session", `${module.id}.json`);

  server = Bun.serve({
    port: PORT,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("nf", { status: 404 });
      const body = (await req.json()) as { messages: Array<{ role: string; content: unknown }> };
      requests.push(body);
      const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          const enc = (s: string) => c.enqueue(new TextEncoder().encode(s));
          if (mode === "echo") {
            enc(chunk({ choices: [{ delta: { content: "mock reply" } }] }));
            enc(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
          }
          enc("data: [DONE]\n\n");
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
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
  baseUrl: `http://127.0.0.1:${PORT}/v1`,
  model: "mock-model",
  label: "mock",
});

describe("loadHistoryFile", () => {
  test("missing file -> []", () => {
    expect(loadHistoryFile(join(root, "nope.json"))).toEqual([]);
  });

  test("corrupt file -> []", () => {
    const f = join(root, "bad.json");
    writeFileSync(f, "{nope");
    expect(loadHistoryFile(f)).toEqual([]);
  });

  test("filters junk entries, keeps valid turns", () => {
    const f = join(root, "mix.json");
    writeFileSync(
      f,
      JSON.stringify([
        { who: "user", text: "q", ts: 1 },
        { who: "assistant", text: "a", ts: 2 },
        { who: "system", text: "skip", ts: 3 },
        { who: "user", text: 42, ts: 4 },
        { nope: true },
      ]),
    );
    expect(loadHistoryFile(f)).toEqual([
      { who: "user", text: "q", ts: 1 },
      { who: "assistant", text: "a", ts: 2 },
    ]);
  });
});

describe("session history persistence", () => {
  test("ask() appends user + assistant turns to the file", async () => {
    mode = "echo";
    const s = createTutorSession({ courseRoot, modules, module, provider: provider(), historyFile });
    const reply = await s.ask("what is a route?");
    expect(reply).toBe("mock reply");
    const turns = loadHistoryFile(historyFile);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ who: "user", text: "what is a route?" });
    expect(turns[1]).toMatchObject({ who: "assistant", text: "mock reply" });
  });

  test("a resumed session seeds the model with prior turns", async () => {
    mode = "echo";
    const s2 = createTutorSession({ courseRoot, modules, module, provider: provider(), historyFile });
    await s2.ask("follow up");
    const last = requests[requests.length - 1];
    const roles = last.messages.map((m) => m.role);
    const text = (m: { content: unknown }): string =>
      Array.isArray(m.content)
        ? m.content
            .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
            .join("")
        : String(m.content);
    const texts = last.messages.map(text);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    expect(texts).toContain("what is a route?");
    expect(texts).toContain("mock reply");
    expect(texts[texts.length - 1]).toBe("follow up");
  });

  test("failed runs keep the question but not a phantom answer", async () => {
    mode = "empty";
    const s3 = createTutorSession({ courseRoot, modules, module, provider: provider(), historyFile });
    await expect(s3.ask("a question that fails")).rejects.toThrow();
    const turns = loadHistoryFile(historyFile);
    expect(turns[turns.length - 1]).toMatchObject({ who: "user", text: "a question that fails" });
    expect(turns[turns.length - 2].who).toBe("assistant"); // prior reply, not a new one
  });

  test("only the most recent 50 turns are seeded", async () => {
    mode = "echo";
    const turns: Array<{ who: "user" | "assistant"; text: string; ts: number }> = [];
    for (let i = 0; i < 60; i++) {
      turns.push({ who: "user", text: `q${i}`, ts: 1000 + i });
      turns.push({ who: "assistant", text: `a${i}`, ts: 2000 + i });
    }
    saveHistoryFile(historyFile, turns);
    const s4 = createTutorSession({ courseRoot, modules, module, provider: provider(), historyFile });
    await s4.ask("last");
    const last = requests[requests.length - 1];
    const nonSystem = last.messages.filter((m) => m.role !== "system");
    expect(nonSystem).toHaveLength(51); // 50 seeded + 1 fresh question
    const firstText = Array.isArray(nonSystem[0].content)
      ? (nonSystem[0].content[0] as { text?: string }).text
      : String(nonSystem[0].content);
    expect(firstText).toBe("q35"); // turns 0..69 rotated out
  });
});
