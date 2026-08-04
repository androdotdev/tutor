import { createTool } from "@cline/shared";
import { createInterface } from "node:readline/promises";

/** Prompts the human for one line of input and returns their answer. */
export type AskUserFn = (question: string) => Promise<string>;

/** One recorded clarification exchange. */
export interface AskUserQA {
  question: string;
  answer: string;
}

/**
 * Shown when a model calls ask_user without a question (some models send
 * `{}`). Never block on stdin with a blank prompt.
 */
export const FALLBACK_QUESTION = "What else should I know about the course you want?";

/** Reads answers from the terminal via node:readline/promises. */
export function defaultPromptLine(): AskUserFn {
  return async (question: string): Promise<string> => {
    const q = typeof question === "string" && question.trim() !== "" ? question : FALLBACK_QUESTION;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  };
}

/**
 * The clarify stage's only tool: asks the human ONE clarifying question.
 * Every invocation stashes the question/answer pair in a closure; `getQA()`
 * returns the full exchange list once the run is over.
 */
export function createAskUserTool(promptLine: AskUserFn) {
  const qa: AskUserQA[] = [];
  const tool = createTool({
    name: "ask_user",
    description:
      "Ask the human ONE clarifying question about the course they want. Use sparingly (0-3 total).",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
    execute: async (input: { question?: string }) => {
      const question =
        typeof input?.question === "string" && input.question.trim() !== "" ? input.question : FALLBACK_QUESTION;
      const answer = await promptLine(question);
      qa.push({ question, answer });
      return { ok: true, answer };
    },
  });
  return { tool, getQA: () => qa.slice() };
}
