// Researcher-stage tests: a scripted mock SSE server (Bun.serve on port 0)
// drives the research agent through web_search and write_file (the report
// lands in .lyceum/research.json on real disk), covering the happy path, the
// one-retry path, the invalid-file path, and the hard-fail path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildAuthorTools } from "@tutor/core";
import { resolveProvider, type ProviderSelection } from "@tutor/llms";
import { runResearch } from "../src/researcher";

const COURSE_ROOT = "/tmp/lyceum-research-test";

// "happy": search, then write the report, then "done".
// "retry": plain text first (no report), then write the report, then "done".
// "bad": write_file always missing source_url — invalid content both attempts.
// "fail": plain text both attempts — no report ever.
let mode: "happy" | "retry" | "bad" | "fail" = "happy";
let callCount = 0;
let lastBody: unknown;
let server: ReturnType<typeof Bun.serve>;
let provider: ProviderSelection;

beforeAll(() => {
  mkdirSync(COURSE_ROOT, { recursive: true });
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions") {
        return new Response("nf", { status: 404 });
      }
      lastBody = await req.json();
      const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      const call = callCount++;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          const enc = (s: string) => c.enqueue(new TextEncoder().encode(s));
          const tool = (name: string, args: unknown) => [
            {
              index: 0,
              id: `c${call}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ];

          if (mode === "happy") {
            if (call === 0) {
              enc(chunk({ choices: [{ delta: { tool_calls: tool("web_search", { query: "topic" }) } }] }));
              enc(chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
            } else if (call === 1) {
              enc(
                chunk({
                  choices: [
                    {
                      delta: {
                        tool_calls: tool("write_file", {
                          path: ".lyceum/research.json",
                          content: JSON.stringify({
                            findings: [{ claim: "X is current", source_url: "https://example.com/docs" }],
                            caveats: "thin",
                          }),
                        }),
                      },
                    },
                  ],
                }),
              );
              enc(chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
            } else {
              enc(chunk({ choices: [{ delta: { content: "done" } }] }));
              enc(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
            }
          } else if (mode === "retry") {
            if (call === 0) {
              enc(chunk({ choices: [{ delta: { content: "no tools" } }] }));
              enc(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
            } else if (call === 1) {
              enc(
                chunk({
                  choices: [
                    {
                      delta: {
                        tool_calls: tool("write_file", {
                          path: ".lyceum/research.json",
                          content: JSON.stringify({
                            findings: [{ claim: "Y is documented", source_url: "https://example.com/y" }],
                          }),
                        }),
                      },
                    },
                  ],
                }),
              );
              enc(chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
            } else {
              enc(chunk({ choices: [{ delta: { content: "done" } }] }));
              enc(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
            }
          } else if (mode === "bad") {
            // write_file always missing source_url in the content; the stage
            // validation rejects it, so both attempts fail with a structured
            // reason naming the exact field.
            enc(
              chunk({
                choices: [
                  {
                    delta: {
                      tool_calls: tool("write_file", {
                        path: ".lyceum/research.json",
                        content: JSON.stringify({ findings: [{ claim: "no source attached" }] }),
                      }),
                    },
                  },
                ],
              }),
            );
            enc(chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
          } else {
            enc(chunk({ choices: [{ delta: { content: "nothing here" } }] }));
            enc(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
          }
          enc("data: [DONE]\n\n");
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });

  const port = (server as unknown as { port: number }).port;
  process.env.OPENAI_API_KEY = "mock";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.TUTOR_MODEL = "mock-model";
  const resolved = resolveProvider();
  if (!resolved) throw new Error("resolveProvider returned null");
  provider = resolved;
});

afterAll(() => {
  server.stop(true);
});

/** Fresh slate: a stale report file from a previous mode must not leak in. */
function resetReport(): void {
  rmSync(join(COURSE_ROOT, ".lyceum"), { recursive: true, force: true });
}

function webSearchTool() {
  return buildAuthorTools(
    { courseRoot: COURSE_ROOT, modules: [] },
    { search: async () => [{ title: "Docs", url: "https://example.com/docs", snippet: "s" }] },
  ).web_search;
}

describe("runResearch", () => {
  test("searches, writes the report file, and returns the parsed report", async () => {
    mode = "happy";
    callCount = 0;
    resetReport();
    const report = await runResearch({
      provider,
      prompt: "topic",
      courseRoot: COURSE_ROOT,
      webSearchTool: webSearchTool(),
    });
    expect(report).toEqual({
      findings: [{ claim: "X is current", source_url: "https://example.com/docs" }],
      caveats: "thin",
    });
  });

  test("keeps the topic in the user turn, not the system prompt", async () => {
    mode = "happy";
    callCount = 0;
    resetReport();
    await runResearch({
      provider,
      prompt: "docker networking",
      courseRoot: COURSE_ROOT,
      webSearchTool: webSearchTool(),
    });
    const body = lastBody as { messages: Array<{ role: string; content: unknown }> };
    const text = (m: { content: unknown }): string =>
      Array.isArray(m.content)
        ? m.content
            .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
            .join("")
        : String(m.content);
    const system = text(body.messages.find((m) => m.role === "system") ?? { content: "" });
    const user = text(body.messages.find((m) => m.role === "user") ?? { content: "" });
    expect(system).toContain("research assistant for course authoring");
    expect(system).not.toContain("docker networking");
    expect(user).toContain("docker networking");
  });

  test("retries once when the first reply writes no report file", async () => {
    mode = "retry";
    callCount = 0;
    resetReport();
    const report = await runResearch({
      provider,
      prompt: "topic",
      courseRoot: COURSE_ROOT,
      webSearchTool: webSearchTool(),
    });
    expect(report).toEqual({
      findings: [{ claim: "Y is documented", source_url: "https://example.com/y" }],
    });
  });

  test("throws when neither attempt produces a valid report", async () => {
    mode = "fail";
    callCount = 0;
    resetReport();
    await expect(
      runResearch({ provider, prompt: "topic", courseRoot: COURSE_ROOT, webSearchTool: webSearchTool() }),
    ).rejects.toThrow(/Research stage failed: the model finished without writing \.lyceum\/research\.json/);
  });

  test("names the exact validation problem when the report file is malformed", async () => {
    mode = "bad";
    callCount = 0;
    resetReport();
    await expect(
      runResearch({ provider, prompt: "topic", courseRoot: COURSE_ROOT, webSearchTool: webSearchTool() }),
    ).rejects.toThrow(/Research stage failed: research\.json is still invalid: findings\[0\]\.source_url is missing or not a string/);
  });
});
