// End-to-end smoke of the Socratic agent loop against a local mock
// OpenAI-compatible /chat/completions server. No real API key needed.
// Model turn 1 -> tool_calls run_tests("01"); turn 2 (after tool result) -> final text.
import { createTutorSession } from "./src/session.ts";
import { resolveProvider } from "../llms/src/provider.ts";
import { resolveCourse } from "@tutor/shared";

let callCount = 0;

const mock = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    callCount += 1;

    const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = (s: string) => controller.enqueue(new TextEncoder().encode(s));
        const push = (obj: unknown) => enc(chunk(obj));

        if (callCount === 1) {
          push({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", type: "function", function: { name: "run_tests", arguments: '{"module":"01"}' } },
                  ],
                },
              },
            ],
          });
          push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
        } else {
          push({ choices: [{ delta: { content: "Good route-handler question — keep going, mock coach." } }] });
          push({ choices: [{ delta: {}, finish_reason: "stop" }] });
          push({ usage: { prompt_tokens: 10, completion_tokens: 9 } });
        }
        enc("data: [DONE]\n\n");
        controller.close();
      },
    });

    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});

const port = (mock as unknown as { port: number }).port;
process.env.OPENAI_API_KEY = "mock";
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TUTOR_MODEL = "mock-model";

const provider = resolveProvider();
if (!provider) throw new Error("provider not resolved");
console.log("provider:", provider.provider, provider.modelId, provider.baseUrl);

const modules = await resolveCourse("/home/andro/coding/express-course");
const module = modules.find((m) => m.id === "01");
if (!module) throw new Error("module 01 missing");

const session = createTutorSession({
  courseRoot: "/home/andro/coding/express-course",
  modules,
  module,
  provider,
});

const events: string[] = [];
session.subscribe((e) => {
  if (e.type === "tool-started") events.push(`tool-started:${e.toolCall.toolName}`);
  if (e.type === "tool-finished") events.push("tool-finished");
});

const answer = await session.ask("my route handler isn't matching, help?");
console.log("answer:", JSON.stringify(answer));
console.log("events:", JSON.stringify(events));
console.log("model calls:", callCount);

const pass = callCount === 2 && events.includes("tool-started:run_tests") && answer.length > 0;
mock.stop();
console.log(pass ? "SMOKE_PASS" : "SMOKE_FAIL");
process.exit(pass ? 0 : 1);