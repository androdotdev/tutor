import { createAgentRuntime, type AgentRuntimeConfig } from "@cline/agents";
import type { AgentRuntimeEvent } from "@cline/shared";
import { readFileSync } from "node:fs";
import { isSpoiler, type ModuleDesc } from "@tutor/shared";
import { buildModel, type ProviderSelection } from "@tutor/llms";
import { buildTools } from "@tutor/core";
import { buildSystemPrompt, type ModuleContext } from "./policy";

/** Per-file cap for context injected into the prompt. */
const CONTEXT_FILE_LIMIT = 8_000;

function readContextFile(courseRoot: string, file: string | null): string | undefined {
  if (!file) return undefined;
  // Defense in depth: never load anything the resolver would classify as a
  // spoiler (solutions/ or project solution stubs), even though ModuleDesc
  // paths are resolver-derived and should already be safe.
  if (isSpoiler(courseRoot, file)) return undefined;
  try {
    const text = readFileSync(file, "utf8");
    return text.length > CONTEXT_FILE_LIMIT
      ? `${text.slice(0, CONTEXT_FILE_LIMIT)}\n…(truncated)`
      : text;
  } catch {
    // Missing or unreadable file: contribute nothing rather than crash the session.
    return undefined;
  }
}

function buildModuleContext(courseRoot: string, module: ModuleDesc): ModuleContext {
  return {
    readme: readContextFile(courseRoot, module.readme),
    exercise: readContextFile(courseRoot, module.student),
  };
}

export interface TutorSessionOptions {
  courseRoot: string;
  modules: ModuleDesc[];
  module: ModuleDesc;
  provider: ProviderSelection;
  /** max agent iterations per turn (default 8) */
  maxIterations?: number;
  /** learner's coaching instructions from XDG config, appended to the policy */
  userPrompt?: string;
  /** user skills dir (XDG config skills/): enables list_skills/get_skill */
  skillsDir?: string;
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
  const baseTools = buildTools({ courseRoot: opts.courseRoot, modules: opts.modules, skillsDir: opts.skillsDir });
  const runtime = createAgentRuntime({
    model: buildModel(opts.provider),
    systemPrompt: buildSystemPrompt(opts.module, buildModuleContext(opts.courseRoot, opts.module), opts.userPrompt),
    tools: [baseTools.run_tests, baseTools.read_file, baseTools.grep],
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