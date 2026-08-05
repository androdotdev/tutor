import { Agent } from "@earendil-works/pi-agent-core";
import { normalize } from "node:path";
import type { ModuleDesc } from "@tutor/shared";
import { buildModel, buildStreamFn, type ProviderSelection } from "@tutor/llms";
import { buildAuthorTools, type PiAgentTool } from "@tutor/core";
import { attachPiBridge, lastAssistantText, type TutorRuntimeEvent } from "./pi-events";

/** Author-mode policy: how the agent writes a module the way an engineer would. */
export function buildAuthorPrompt(module: ModuleDesc, opts?: { hasPolish?: boolean }): string {
  const base = `modules/${module.dir}`;
  const lines = [
    `You are the course author for the module "${module.title}" (${module.dir}).`,
    `Your job: write a complete, self-learning module using the tools available, in this order.`,
    `Every path you pass to write_file/read_file/run_tests MUST start with "${base}/" — that is`,
    `the module's real directory under the course's modules/ folder. Concretely:`,
    ``,
    `1. DESIGN the exercises first (test-first). Pick 3-5 concrete, graded exercises that`,
    `   ramp in difficulty. For each you will write exactly one test.`,
    `2. Write ${base}/tests/index.test.js using bun:test (describe/test/expect).`,
    `   Import the student symbols from "../exercise/index.js". The grader is the ONLY referee —`,
    `   each test asserts a small, unambiguous behavior.`,
    `3. Write ${base}/exercise/index.js: a stub that exports every graded function with an empty`,
    `   body and a // TODO comment — the learner fills these in.`,
    `4. Write ${base}/README.md: the teaching — the concept, how to run the grader ("bun test"),`,
    `   a setup/ then concept/ then task structure, and a Feynman self-check section.`,
    `5. Run the grader: call run_tests with { module: "${module.dir}" } (its id "${module.id}" or`,
    `   title also work). Expected: the tests FAIL because the stub is empty — that is GOOD.`,
    `   But fix any import/syntax error the output reveals; the grader must execute to the`,
    `   failure assertions, not crash on load.`,
    `6. OPTIONAL: only after step 5 you MAY use web_search — at most 2 calls — to confirm a`,
    `   detail. The concepts and sources already given are usually enough; never research`,
    `   instead of writing. Never paste search results or external code — write ORIGINAL`,
    `   exercises and explanations.`,
    `7. NEVER write to ${base}/solutions/ (it is redacted). Do not paste worked answers into README.`,
    `8. Close with a short summary: the graded function names and what the learner must implement.`,
    ``,
    `Absolute paths are safe; keep every write inside "${base}/".`,
  ];
  if (opts?.hasPolish) {
    lines.push("You may call polish to rewrite a draft passage for tone/clarity (it never touches files).");
  }
  return lines.join("\n");
}

export interface AuthorSessionOptions {
  courseRoot: string;
  modules: ModuleDesc[];
  module: ModuleDesc;
  provider: ProviderSelection;
  maxIterations?: number;
  /** Extra tools appended to the author session (e.g. polish); never write-only bypasses. */
  extraTools?: PiAgentTool[];
}

export interface AuthorSession {
  /** Run the authoring task to completion; resolve to the final assistant text. */
  run(input: string): Promise<string>;
  subscribe(listener: (event: TutorRuntimeEvent) => void): () => void;
}

export function createAuthorSession(opts: AuthorSessionOptions): AuthorSession {
  const baseTools = buildAuthorTools({ courseRoot: opts.courseRoot, modules: opts.modules });
  const agent = new Agent({
    streamFn: buildStreamFn(opts.provider),
    initialState: {
      systemPrompt: buildAuthorPrompt(opts.module, { hasPolish: !!opts.extraTools?.length }),
      // A reasoning model can spend the whole 4k budget on thinking; authoring
      // needs room for thinking + the tool call that actually writes files.
      model: { ...buildModel(opts.provider), maxTokens: 8_192 },
      thinkingLevel: "off",
      tools: [
        baseTools.run_tests,
        baseTools.read_file,
        baseTools.write_file,
        baseTools.web_search,
        ...(opts.extraTools ?? []),
      ],
    },
  });

  const listeners = new Set<(event: TutorRuntimeEvent) => void>();

  // Write watchdog: pi's loop ends as soon as the model produces a text-only
  // turn (no tool calls) — a model that "answers" instead of acting ends the
  // run with zero files, which the build then fails. When the first such turn
  // arrives with no write_file call into this module yet, queue a follow-up
  // user message so the run continues and the model gets explicit chances to
  // write the files instead of stopping. Fires on "length" too: a reasoning
  // model (hy3) can burn the whole output budget on thinking and end with
  // finish_reason "length" — no tool call ever arrives — which was the silent
  // failure behind the consistently-empty modules. Up to MAX_RESCUES nudges;
  // a model that still won't act after that fails loudly via verification.
  const base = `modules/${opts.module.dir}`;
  const MAX_RESCUES = 3;
  let wroteInModule = false;
  let rescues = 0;

  const bridge = attachPiBridge(agent, {
    maxIterations: opts.maxIterations ?? 24,
    onEvent: (event) => {
      if (
        event.type === "assistant-message" &&
        (event.finishReason === "stop" || event.finishReason === "length")
      ) {
        if (!wroteInModule && rescues < MAX_RESCUES) {
          rescues += 1;
          console.log(
            `author watchdog: nudged the model to write files (finish=${event.finishReason}, rescue ${rescues}/${MAX_RESCUES})`,
          );
          agent.followUp({
            role: "user",
            content: [
              {
                type: "text",
                text: `You ended your reply without writing any files (your output may have hit the token limit ` +
                  `while thinking). STOP analyzing and call write_file NOW: write ${base}/tests/index.test.js ` +
                  `first, then ${base}/exercise/index.js, then ${base}/README.md. The task fails without them.`,
              },
            ],
          });
        }
      } else if (event.type === "tool-started" && event.toolName === "write_file") {
        const path = (event.args as { path?: unknown } | undefined)?.path;
        // Match canonical writes: normalize (collapses `//`, `.`, `..`) and
        // drop any leading separator so absolute paths compare like relative.
        const norm = normalize(typeof path === "string" ? path : "").replace(/^[/\\]+/, "");
        if (norm.startsWith(`${base}/`)) wroteInModule = true;
      }
      for (const listener of listeners) listener(event);
    },
  });

  return {
    async run(input: string): Promise<string> {
      await agent.prompt(input);
      if (bridge.capped()) return lastAssistantText(agent);
      const error = agent.state.errorMessage;
      if (error) throw new Error(error);
      return lastAssistantText(agent);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
