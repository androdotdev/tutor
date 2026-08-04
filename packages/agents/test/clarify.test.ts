// Clarify-stage tests: a scripted mock SSE server (Bun.serve on port 0) drives
// the clarify agent through an ask_user tool call and through a plain recap,
// exercising the injected askUser seam and the recorded QA list.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runClarify } from "../src/clarify";
import { resolveProvider, type ProviderSelection } from "@tutor/llms";

// "ask": first request emits an ask_user tool call, second emits the recap.
// "plain": every request emits text directly.
let mode: "ask" | "plain" = "ask";
let callCount = 0;
let server: ReturnType<typeof Bun.serve>;
let provider: ProviderSelection;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions") {
        return new Response("nf", { status: 404 });
      }
      const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      const call = callCount++;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          const enc = (s: string) => c.enqueue(new TextEncoder().encode(s));
          if (mode === "ask" && call === 0) {
            enc(
              chunk({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "c1",
                          type: "function",
                          function: {
                            name: "ask_user",
                            arguments: JSON.stringify({ question: "What level?" }),
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
            );
            enc(chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
          } else if (mode === "ask") {
            enc(chunk({ choices: [{ delta: { content: "recap text" } }] }));
            enc(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
          } else {
            enc(chunk({ choices: [{ delta: { content: "no questions needed" } }] }));
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

describe("runClarify", () => {
  test("asks one clarifying question, records the answer, then recaps", async () => {
    mode = "ask";
    callCount = 0;
    const asked: string[] = [];
    const askUser = async (q: string): Promise<string> => {
      asked.push(q);
      return "beginner";
    };

    const result = await runClarify({ provider, prompt: "learn Go", askUser });

    expect(result.recap).toBe("recap text");
    expect(result.qa).toEqual([{ question: "What level?", answer: "beginner" }]);
    expect(asked).toEqual(["What level?"]);
  });

  test("recaps without asking when the model goes straight to text", async () => {
    mode = "plain";
    callCount = 0;

    const result = await runClarify({
      provider,
      prompt: "learn Go",
      askUser: async () => {
        throw new Error("ask_user should not be called");
      },
    });

    expect(result.recap).toBe("no questions needed");
    expect(result.qa).toEqual([]);
  });
});
