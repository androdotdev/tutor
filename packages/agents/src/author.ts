import { Agent } from "@earendil-works/pi-agent-core";
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
    `5. Run the grader (run_tests). Expected: the tests FAIL because the stub is empty — that is`,
    `   GOOD. But fix any import/syntax error the output reveals; the grader must execute to the`,
    `   failure assertions, not crash on load.`,
    ``,
    `Research freely with web_search (official docs, best practices) to get the topic right —`,
    `but write ORIGINAL exercises and explanations. Never paste search results or external code.`,
    `6. NEVER write to ${base}/solutions/ (it is redacted). Do not paste worked answers into README.`,
    `7. Close with a short summary: the graded function names and what the learner must implement.`,
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
      model: buildModel(opts.provider),
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
  const bridge = attachPiBridge(agent, {
    maxIterations: opts.maxIterations ?? 16,
    onEvent: (event) => {
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
