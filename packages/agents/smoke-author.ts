// Verify the author harness: the agent calls write_file (file physically lands),
// then run_tests, then finishes. All against a mock OpenAI-compatible server.
import { readFile } from "node:fs/promises";
import { relative, join } from "node:path";
import { createAuthorSession } from "./src/author.ts";
import { resolveProvider } from "../llms/src/provider.ts";
import { scaffoldCourse } from "@tutor/core";
import { resolveCourse } from "@tutor/shared";

const WRITE_BODY = "export function hello() { return 'HELLO'; }\n";
let callCount = 0;

const courseRoot = "/tmp/lyceum-author-demo";
await scaffoldCourse({ name: "demo", moduleCount: 1 }, courseRoot);
const modules = await resolveCourse(courseRoot);
const module = modules[0];
const writeRel = relative(courseRoot, join(module.moduleDir, "exercise", "index.js"));

const mock = Bun.serve({
  port: 0,
  fetch() {
    callCount += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = (s: string) => controller.enqueue(new TextEncoder().encode(s));
        const push = (obj: unknown) => enc(`data: ${JSON.stringify(obj)}\n\n`);
        const tool = (name: string, args: string) => [
          { index: 0, id: `c${callCount}`, type: "function", function: { name, arguments: args } },
        ];

        if (callCount === 1) {
          push({ choices: [{ delta: { tool_calls: tool("write_file", JSON.stringify({ path: writeRel, content: WRITE_BODY })) } }] });
          push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
        } else if (callCount === 2) {
          push({ choices: [{ delta: { tool_calls: tool("run_tests", JSON.stringify({ module: "demo" })) } }] });
          push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
        } else {
          push({ choices: [{ delta: { content: "demo: implement hello() to fix." } }] });
          push({ choices: [{ delta: {}, finish_reason: "stop" }] });
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
process.env.TUTOR_MODEL = "mock-author";

const provider = resolveProvider();
if (!provider) throw new Error("no provider");
const session = createAuthorSession({ courseRoot, modules, module, provider });

const events: string[] = [];
session.subscribe((e) => {
  if (e.type === "tool-started") events.push(`tool:${e.toolCall.toolName}`);
});

const result = await session.run(`Author now. Title: "${module.title}"`);
const written = await readFile(join(module.moduleDir, "exercise", "index.js"), "utf8");
mock.stop();

console.log("final:", JSON.stringify(result));
console.log("events:", JSON.stringify(events));
console.log("fileOnDisk:", JSON.stringify(written));

const pass =
  events.includes("tool:write_file") &&
  events.includes("tool:run_tests") &&
  written === WRITE_BODY &&
  result.length > 0;
console.log(pass ? "AUTHOR_SMOKE_PASS" : "AUTHOR_SMOKE_FAIL");
process.exit(pass ? 0 : 1);