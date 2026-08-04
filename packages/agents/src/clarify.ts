import { createAgentRuntime, type AgentRuntimeConfig } from "@cline/agents";
import { buildModel, type ProviderSelection } from "@tutor/llms";
import {
  createAskUserTool,
  defaultPromptLine,
  type AskUserFn,
  type AskUserQA,
} from "@tutor/core";
import { progressLogger } from "./progress";

export interface ClarifyOptions {
  provider: ProviderSelection;
  prompt: string;
  askUser?: AskUserFn;
  /** Stream the model's reasoning/text and log tool calls to stdout. */
  progress?: boolean;
}

export interface ClarifyResult {
  recap: string;
  qa: AskUserQA[];
}

const MAX_CLARIFY_ITERATIONS = 10;

function buildClarifyPrompt(): string {
  return [
    "You are planning an interactive self-learning course from the task you are given. Ask up to 3 clarifying questions ONE AT A TIME using the ask_user tool: learner level, scope, format (interactive exercises vs reading vs both), and any module-count preference. ALWAYS pass the question text in the ask_user \"question\" argument — never call it empty. After each answer you may ask another question or finish. When you have enough, reply with a single short recap paragraph naming the topic, target level, and planned module count. Stop calling tools once you recap.",
  ].join("\n");
}

/** Runs the clarify stage: ask the human a few questions, then get a recap. */
export async function runClarify(opts: ClarifyOptions): Promise<ClarifyResult> {
  const { tool, getQA } = createAskUserTool(opts.askUser ?? defaultPromptLine(), opts.prompt);
  const runtime = createAgentRuntime({
    model: buildModel(opts.provider),
    systemPrompt: buildClarifyPrompt(),
    tools: [tool],
    maxIterations: MAX_CLARIFY_ITERATIONS,
    hooks: opts.progress ? { onEvent: progressLogger("clarify") } : undefined,
  } satisfies AgentRuntimeConfig);

  const result = await runtime.run(opts.prompt);
  if (result.status === "failed") {
    throw new Error(result.error?.message ?? "clarify run failed");
  }
  const recap = result.outputText;
  if (recap.trim() === "") {
    throw new Error("clarify produced no recap");
  }
  return { recap, qa: getQA() };
}
