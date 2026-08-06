import { Agent } from "@earendil-works/pi-agent-core";
import { buildModel, buildStreamFn, type ProviderSelection } from "@tutor/llms";
import {
  createAskUserTool,
  defaultPromptLine,
  type AskUserFn,
  type AskUserQA,
} from "@tutor/core";
import { attachPiBridge, lastAssistantText } from "./pi-events";
import { stageSink } from "./progress";

export interface ClarifyOptions {
  provider: ProviderSelection;
  prompt: string;
  askUser?: AskUserFn;
  /** Stream the model's reasoning/text and log tool calls to stdout. */
  progress?: boolean;
  /** Append the full stream to this file (lyceum new --log). */
  logFile?: string;
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
  const { tool, getQA } = createAskUserTool(opts.askUser ?? defaultPromptLine());
  const agent = new Agent({
    streamFn: buildStreamFn(opts.provider),
    initialState: {
      systemPrompt: buildClarifyPrompt(),
      model: buildModel(opts.provider),
      thinkingLevel: "off",
      tools: [tool],
    },
  });
  const bridge = attachPiBridge(agent, {
    maxIterations: MAX_CLARIFY_ITERATIONS,
    onEvent: stageSink("clarify", { progress: opts.progress, logFile: opts.logFile }),
  });

  await agent.prompt(opts.prompt);
  if (!bridge.capped()) {
    const error = agent.state.errorMessage;
    if (error) throw new Error(error ?? "clarify run failed");
  }
  const recap = lastAssistantText(agent);
  if (recap.trim() === "") {
    throw new Error("clarify produced no recap");
  }
  return { recap, qa: getQA() };
}
