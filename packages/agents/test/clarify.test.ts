// Clarify-stage tests: a scripted mock SSE server (Bun.serve on port 0) drives
// the clarify agent through ask_user tool calls and recaps, exercising the
// injected askUser seam, the recorded QA list, the empty-args fallback, and
// the hard cap on ask_user invocations.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runClarify } from "../src/clarify";
import { resolveProvider, type ProviderSelection } from "@tutor/llms";

type Step =
  | { tool: "ask_user"; args: string }
  | { text: string };

// Scripted per-mode responses; the Nth model request gets script[N].
const SCRIPTS: Record<string, Step[]> = {
  ask: [
    { tool: "ask_user", args: JSON.stringify({ question: "What level?" }) },
    { text: "recap text" },
  ],
  empty: [
    { tool: "ask_user", args: "{}" },
    { text: "recap text" },
  ],
  empty2: [
    { tool: "ask_user", args: "{}" },
    { tool: "ask_user", args: "{}" },
    { text: "recap text" },
  ],
  cap: [
    { tool: "ask_user", args: JSON.stringify({ question: "Q1" }) },
    { tool: "ask_user", args: JSON.stringify({ question: "Q2" }) },
    { tool: "ask_user", args: JSON.stringify({ question: "Q3" }) },
    { tool: "ask_user", args: JSON.stringify({ question: "Q4" }) },
    { text: "recap text" },
  ],
  plain: [{ text: "no questions needed" }],
};

let mode = "ask";
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
      const step = SCRIPTS[mode][call];
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          const enc = (s: string) => c.enqueue(new TextEncoder().encode(s));
          if (step && "tool" in step) {
            enc(
              chunk({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: `c${call}`,
                          type: "function",
                          function: { name: "ask_user", arguments: step.args },
                        },
                      ],
                    },
                  },
                ],
              }),
            );
            enc(chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
          } else {
            enc(chunk({ choices: [{ delta: { content: step?.text ?? "" } }] }));
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

  test("rejects an empty ask_user payload before asking (pi validation), model recaps", async () => {
    mode = "empty";
    callCount = 0;
    const asked: string[] = [];
    const askUser = async (q: string): Promise<string> => {
      asked.push(q);
      return "beginner";
    };

    const result = await runClarify({ provider, prompt: "learn Go", askUser });

    expect(result.recap).toBe("recap text");
    expect(result.qa).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("empty ask_user payloads are rejected every time; the human is never prompted", async () => {
    mode = "empty2";
    callCount = 0;
    const asked: string[] = [];
    const askUser = async (q: string): Promise<string> => {
      asked.push(q);
      return "beginner";
    };

    const result = await runClarify({ provider, prompt: "learn Go", askUser });

    expect(result.recap).toBe("recap text");
    expect(result.qa).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("refuses a 4th ask_user call and forces the model to recap", async () => {
    mode = "cap";
    callCount = 0;
    const asked: string[] = [];
    const askUser = async (q: string): Promise<string> => {
      asked.push(q);
      return `answer to ${q}`;
    };

    const result = await runClarify({ provider, prompt: "learn Go", askUser });

    expect(result.recap).toBe("recap text");
    expect(asked).toEqual(["Q1", "Q2", "Q3"]);
    expect(result.qa).toEqual([
      { question: "Q1", answer: "answer to Q1" },
      { question: "Q2", answer: "answer to Q2" },
      { question: "Q3", answer: "answer to Q3" },
    ]);
  });
});
