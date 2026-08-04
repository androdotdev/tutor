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

/** Hard ceiling on ask_user invocations; matches the prompt's "0-3 total". */
export const MAX_ASK_USER_CALLS = 3;

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
 *
 * Bounds: at most `MAX_ASK_USER_CALLS` invocations (the 4th+ throws, which
 * the runtime feeds back to the model as a tool error, forcing a recap).
 * Missing/empty `question` args fall back to a contextual prompt so a model
 * that sends `{}` can never hang the terminal on a blank line.
 */
export function createAskUserTool(promptLine: AskUserFn) {
  const qa: AskUserQA[] = [];
  let calls = 0;
  const tool = createTool({
    name: "ask_user",
    description:
      "Ask the human ONE clarifying question about the course they want. Use sparingly (0-3 total); always pass the question text in the question argument, never empty.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
    execute: async (input: { question?: string }) => {
      if (calls >= MAX_ASK_USER_CALLS) {
        throw new Error(
          `You already asked the maximum of ${MAX_ASK_USER_CALLS} clarifying questions. Do not call ask_user again; reply with your recap paragraph now.`,
        );
      }
      calls++;
      const asked = input?.question;
      const question =
        typeof asked === "string" && asked.trim() !== ""
          ? asked
          : qa.length === 0
            ? FALLBACK_QUESTION
            : `I've recorded ${qa.length} answer${qa.length === 1 ? "" : "s"}. What else should I know?`;
      const answer = await promptLine(question);
      qa.push({ question, answer });
      return { ok: true, answer };
    },
  });
  return { tool, getQA: () => qa.slice() };
}
