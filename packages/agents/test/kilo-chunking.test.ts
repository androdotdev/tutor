// Regression test for kilo.ai-style tool-call streaming: `id` + `name` arrive
// in the FIRST delta of a tool call, `index` + `arguments` fragments follow.
// The provider must remember the id per index so every fragment lands in one
// record; otherwise the runtime splits the call (name record with no args runs
// with {}, args record with no name is dropped as missing_name) and the query
// never reaches search() / the report never reaches the file.
//
// P5: the report channel is now write_file — the CONTENT is a tool argument,
// so this replays the chunking on the new channel and asserts the outline
// lands on disk and validates.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runResearch } from "../src/researcher";
import { buildAuthorTools } from "@tutor/core";
import { resolveProvider, type ProviderSelection } from "@tutor/llms";

const COURSE_ROOT = "/tmp/lyceum-kilo";
const REPORT_FILE = join(COURSE_ROOT, ".lyceum", "research.json");

let server: ReturnType<typeof Bun.serve>;
let provider: ProviderSelection;
let callCount = 0;

function chunk(o: unknown) {
  return `data: ${JSON.stringify(o)}\n\n`;
}

/** A tool-call delta carrying only `id` + `name` (kilo.ai's first fragment). */
function nameOnlyDelta(index: number, id: string, name: string) {
  return chunk({
    choices: [{ delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] } }],
  });
}

/** A tool-call delta carrying only `index` + `arguments` (later fragments). */
function argsOnlyDelta(index: number, args: string) {
  return chunk({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args } }] } }] });
}

function finishToolCalls() {
  return chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
}

beforeAll(() => {
  mkdirSync(COURSE_ROOT, { recursive: true });
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("nf", { status: 404 });
      const call = callCount++;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          const enc = (s: string) => c.enqueue(new TextEncoder().encode(s));
          if (call === 0) {
            // web_search: id+name first, then the query in fragments.
            enc(nameOnlyDelta(0, "call_ws", "web_search"));
            enc(argsOnlyDelta(0, JSON.stringify({ query: "Docker secrets best practices" })));
            enc(finishToolCalls());
          } else if (call === 1) {
            // write_file: id+name first, then the content split across TWO
            // argument fragments (kilo.ai splits long payloads mid-JSON).
            const args = JSON.stringify({
              path: ".lyceum/research.json",
              content: JSON.stringify({
                findings: [{ claim: "Docker secrets belong in Swarm secrets, not env vars.", source_url: "https://docs.docker.com" }],
                caveats: "kilo chunked",
              }),
            });
            const mid = Math.floor(args.length / 2);
            enc(nameOnlyDelta(0, "call_wf", "write_file"));
            enc(argsOnlyDelta(0, args.slice(0, mid)));
            enc(argsOnlyDelta(0, args.slice(mid)));
            enc(finishToolCalls());
          } else {
            enc(chunk({ choices: [{ delta: { content: "done" } }] }));
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

describe("kilo.ai chunked tool-call streaming", () => {
  test("split fragments reach search() and the chunked report lands on disk", async () => {
    callCount = 0;
    rmSync(join(COURSE_ROOT, ".lyceum"), { recursive: true, force: true });
    const seen: string[] = [];
    const webSearchTool = buildAuthorTools(
      { courseRoot: COURSE_ROOT, modules: [] },
      {
        search: async (query: string) => {
          seen.push(query);
          return [{ title: "Docker docs", url: "https://docs.docker.com", snippet: "secrets" }];
        },
      },
    ).web_search;

    const report = await runResearch({ provider, prompt: "docker secrets", courseRoot: COURSE_ROOT, webSearchTool });

    expect(seen).toEqual(["Docker secrets best practices"]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].claim).toContain("Docker secrets");
    // The chunked write_file call must have produced the real artifact.
    expect(existsSync(REPORT_FILE)).toBe(true);
    expect(JSON.parse(readFileSync(REPORT_FILE, "utf8"))).toEqual(report);
  });
});
