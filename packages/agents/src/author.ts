import { createAgentRuntime, type AgentRuntimeConfig } from "@cline/agents";
import type { AgentRuntimeEvent } from "@cline/shared";
import type { ModuleDesc } from "@tutor/shared";
import { buildModel, type ProviderSelection } from "@tutor/llms";
import { buildAuthorTools, toClineTool } from "@tutor/core";

/** Author-mode policy: how the agent writes a module the way an engineer would. */
export function buildAuthorPrompt(module: ModuleDesc, opts?: { hasPolish?: boolean }): string {
  const lines = [
    `You are the course author for the module "${module.title}" (${module.dir}).`,
    `Your job: write a complete, self-learning module using the tools available, in this order:`,
    ``,
    `1. DESIGN the exercises first (test-first). Pick 3-5 concrete, graded exercises that`,
    `   ramp in difficulty. For each you will write exactly one test.`,
    `2. Write module/tests/index.test.js using bun:test (describe/test/expect).`,
    `   Import the student symbols from "../exercise/index.js". The grader is the ONLY referee —`,
    `   each test asserts a small, unambiguous behavior.`,
    `3. Write module/exercise/index.js: a stub that exports every graded function with an empty`,
    `   body and a // TODO comment — the learner fills these in.`,
    `4. Write module/README.md: the teaching — the concept, how to run the grader ("bun test"),`,
    `   a setup/ then concept/ then task structure, and a Feynman self-check section.`,
    `5. Run the grader (run_tests). Expected: the tests FAIL because the stub is empty — that is`,
    `   GOOD. But fix any import/syntax error the output reveals; the grader must execute to the`,
    `   failure assertions, not crash on load.`,
    ``,
    `Research freely with web_search (official docs, best practices) to get the topic right —`,
    `but write ORIGINAL exercises and explanations. Never paste search results or external code.`,
    `6. NEVER write to solutions/ (it is redacted). Do not paste worked answers into README.`,
    `7. Close with a short summary: the graded function names and what the learner must implement.`,
    ``,
    `Absolute paths are safe; keep every write inside this module.`,
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
  /** Extra tools appended to the author runtime's toolset (e.g. polish). */
  /** extra tools appended to the author session (e.g. polish); never write-only bypasses */
  extraTools?: NonNullable<AgentRuntimeConfig["tools"]>;
}

export interface AuthorSession {
  /** Run the authoring task to completion; resolve to the final assistant text. */
  run(input: string): Promise<string>;
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
}

export function createAuthorSession(opts: AuthorSessionOptions): AuthorSession {
  const baseTools = buildAuthorTools({ courseRoot: opts.courseRoot, modules: opts.modules });
  const runtime = createAgentRuntime({
    model: buildModel(opts.provider),
    systemPrompt: buildAuthorPrompt(opts.module, { hasPolish: !!opts.extraTools?.length }),
    tools: [
      toClineTool(baseTools.run_tests),
      toClineTool(baseTools.read_file),
      toClineTool(baseTools.write_file),
      toClineTool(baseTools.web_search),
      ...(opts.extraTools ?? []),
    ],
    maxIterations: opts.maxIterations ?? 16,
  } satisfies AgentRuntimeConfig);

  return {
    async run(input: string): Promise<string> {
      const result = await runtime.run(input);
      if (result.status === "failed") {
        throw new Error(result.error?.message ?? "authoring run failed");
      }
      return result.outputText;
    },
    subscribe(listener) {
      return runtime.subscribe(listener);
    },
  };
}