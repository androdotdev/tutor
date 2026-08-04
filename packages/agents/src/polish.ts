// Polish stage: a Writer-as-tool. The authoring agent can ask a dedicated
// editor model to rewrite a draft passage for tone/clarity/reading level.
// Deliberately a tool (not a stage) so the author loop decides when to use it.
import { createAgentRuntime, type AgentRuntimeConfig } from "@cline/agents";
import { createTool } from "@cline/shared";
import { buildModel, type ProviderSelection } from "@tutor/llms";

/** Editor system prompt: rewrite only, never add content or commentary. */
const EDITOR_PROMPT =
  "You are a careful editor. Rewrite the given text per the instruction. Keep the meaning; improve clarity, tone, and reading level. Reply with ONLY the rewritten text.";

/**
 * Create the `polish` tool backed by a fresh one-shot editor runtime.
 * Stateless per call: each invocation spins its own nested runtime, so the
 * tool is safe to share across modules within one build.
 */
export function createPolishTool(provider: ProviderSelection) {
  return createTool({
    name: "polish",
    description:
      "Rewrite a draft passage for tone/clarity/reading level. Does not touch the filesystem. Pass the passage and an instruction.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, instruction: { type: "string" } },
      required: ["text"],
    },
    execute: async (input: { text: string; instruction?: string }) => {
      const runtime = createAgentRuntime({
        model: buildModel(provider),
        systemPrompt: EDITOR_PROMPT,
        tools: [],
        maxIterations: 1,
      } satisfies AgentRuntimeConfig);

      const result = await runtime.run(
        "Instruction: " + (input.instruction ?? "") + "\n\nText:\n" + input.text,
      );
      if (result.status === "failed") {
        return { ok: false, message: result.error?.message ?? "polish failed" };
      }
      return { ok: true, polished: result.outputText };
    },
  });
}
