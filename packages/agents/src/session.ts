import { createAgentRuntime, type AgentRuntimeConfig } from "@cline/agents";
import type { AgentRuntimeEvent } from "@cline/shared";
import type { ModuleDesc } from "@tutor/shared";
import { buildModel, type ProviderSelection } from "@tutor/llms";
import { buildTools } from "@tutor/core";
import { buildSystemPrompt } from "./policy";

export interface TutorSessionOptions {
  courseRoot: string;
  modules: ModuleDesc[];
  module: ModuleDesc;
  provider: ProviderSelection;
  /** max agent iterations per turn (default 8) */
  maxIterations?: number;
}

export interface TutorSession {
  /** Send the student's turn, await the assistant's final text. */
  ask(input: string): Promise<string>;
  /** Cancel any in-flight run. */
  abort(reason?: unknown): void;
  /** Subscribe to runtime events (assistant-text-delta, tool-finished, ...). */
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
}

export function createTutorSession(opts: TutorSessionOptions): TutorSession {
  const baseTools = buildTools({ courseRoot: opts.courseRoot, modules: opts.modules });
  const runtime = createAgentRuntime({
    model: buildModel(opts.provider),
    systemPrompt: buildSystemPrompt(opts.module),
    tools: [baseTools.run_tests, baseTools.read_file],
    maxIterations: opts.maxIterations ?? 8,
  } satisfies AgentRuntimeConfig);

  let started = false;

  return {
    async ask(input: string): Promise<string> {
      const result = started ? await runtime.continue(input) : await runtime.run(input);
      started = true;
      // @cline/agents resolves with status "failed" instead of rejecting for most
      // loop errors; surface them so callers (TUI, CLI) can show a real message.
      if (result.status === "failed") {
        throw new Error(result.error?.message ?? "coach run failed");
      }
      return result.outputText;
    },
    abort(reason?: unknown) {
      runtime.abort(reason);
    },
    subscribe(listener) {
      return runtime.subscribe(listener);
    },
  };
}