import { input } from "@inquirer/prompts";
import { Type, type Static } from "@earendil-works/pi-ai";
import { createInterface } from "node:readline/promises";
import { jsonResult, type PiAgentTool } from "./pi-tool";

/** Prompts the human for one line of input and returns their answer. */
export type AskUserFn = (question: string) => Promise<string>;

/** One recorded clarification exchange. */
export interface AskUserQA {
  question: string;
  answer: string;
}

/** Hard ceiling on ask_user invocations; matches the prompt's "0-3 total". */
export const MAX_ASK_USER_CALLS = 3;

/**
 * Reads answers from the terminal. On a real interactive terminal (TTY on
 * BOTH stdin and stdout, TERM not dumb) this uses the @inquirer/prompts
 * prompt; otherwise it falls back to plain readline so nothing blocks or
 * throws. The stdout check matters: inquirer renders to stdout, so a
 * piped/redirected stdout would leave the process waiting at an invisible
 * prompt that reads exactly like a hang.
 */
export function defaultPromptLine(): AskUserFn {
  return async (question: string): Promise<string> => {
    if (process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb") {
      return await input({ message: question });
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

const askUserParams = Type.Object({ question: Type.String() });

/**
 * The clarify stage's only tool: asks the human ONE clarifying question.
 * Every invocation stashes the question/answer pair in a closure; `getQA()`
 * returns the full exchange list once the run is over.
 *
 * Bounds: at most `MAX_ASK_USER_CALLS` invocations (the 4th+ throws, which
 * the loop feeds back to the model as a tool error, forcing a recap).
 * `question` is required by the schema; the pi loop validates arguments
 * before `execute` runs, so a missing/empty `{}` call never reaches the
 * terminal.
 */
export function createAskUserTool(
  promptLine: AskUserFn,
): { tool: PiAgentTool<typeof askUserParams>; getQA: () => AskUserQA[] } {
  const qa: AskUserQA[] = [];
  let calls = 0;
  const tool: PiAgentTool<typeof askUserParams> = {
    name: "ask_user",
    label: "Ask the human a clarifying question",
    description:
      "Ask the human ONE clarifying question about the course they want. Use sparingly (0-3 total); always pass the question text in the question argument, never empty.",
    parameters: askUserParams,
    execute: async (_toolCallId, input: Static<typeof askUserParams>) => {
      if (calls >= MAX_ASK_USER_CALLS) {
        throw new Error(
          `You already asked the maximum of ${MAX_ASK_USER_CALLS} clarifying questions. Do not call ask_user again; reply with your recap paragraph now.`,
        );
      }
      calls++;
      const answer = await promptLine(input.question);
      qa.push({ question: input.question, answer });
      return jsonResult({ ok: true, answer });
    },
  };
  return { tool, getQA: () => qa.slice() };
}
