// Regression test for kilo.ai-style tool-call streaming: `id` + `name` arrive
// in the FIRST delta of a tool call, `index` + `arguments` fragments follow.
// The provider must remember the id per index so every fragment lands in one
// record; otherwise the runtime splits the call (name record with no args runs
// with {}, args record with no name is dropped as missing_name) and the query
// never reaches search().
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runResearch } from "../src/researcher";
import { buildAuthorTools } from "@tutor/core";
import { resolveProvider, type ProviderSelection } from "@tutor/llms";

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
          } else {
            // submit_findings: same chunking.
            enc(nameOnlyDelta(0, "call_sf", "submit_findings"));
            enc(
              argsOnlyDelta(
                0,
                JSON.stringify({
                  findings: [{ claim: "Docker secrets belong in Swarm secrets, not env vars.", source_url: "https://docs.docker.com" }],
                  caveats: "kilo chunked",
                }),
              ),
            );
            enc(finishToolCalls());
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
  test("query from split fragments reaches search() and the report parses", async () => {
    callCount = 0;
    const seen: string[] = [];
    const webSearchTool = buildAuthorTools(
      { courseRoot: "/tmp/lyceum-kilo", modules: [] },
      {
        search: async (query: string) => {
          seen.push(query);
          return [{ title: "Docker docs", url: "https://docs.docker.com", snippet: "secrets" }];
        },
      },
    ).web_search;

    const report = await runResearch({ provider, prompt: "docker secrets", webSearchTool });

    expect(seen).toEqual(["Docker secrets best practices"]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].claim).toContain("Docker secrets");
  });
});
