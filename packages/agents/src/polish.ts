// Polish stage: a Writer-as-tool. The authoring agent can ask a dedicated
// editor model to rewrite a draft passage for tone/clarity/reading level.
// Deliberately a tool (not a stage) so the author loop decides when to use it.
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { jsonResult, type PiAgentTool } from "@tutor/core";
import { buildModel, buildStreamFn, type ProviderSelection } from "@tutor/llms";
import { attachPiBridge, lastAssistantText } from "./pi-events";

/** Editor system prompt: rewrite only, never add content or commentary. */
const EDITOR_PROMPT =
  "You are a careful editor. Rewrite the given text per the instruction. Keep the meaning; improve clarity, tone, and reading level. Reply with ONLY the rewritten text.";

const polishParams = Type.Object({
  text: Type.String(),
  instruction: Type.Optional(Type.String()),
});

/**
 * Create the `polish` tool backed by a fresh one-shot editor agent.
 * Stateless per call: each invocation spins its own nested agent, so the
 * tool is safe to share across modules within one build.
 */
export function createPolishTool(provider: ProviderSelection): PiAgentTool<typeof polishParams> {
  return {
    name: "polish",
    label: "Rewrite a draft passage",
    description:
      "Rewrite a draft passage for tone/clarity/reading level. Does not touch the filesystem. Pass the passage and an instruction.",
    parameters: polishParams,
    execute: async (_toolCallId, input) => {
      const agent = new Agent({
        streamFn: buildStreamFn(provider),
        initialState: {
          systemPrompt: EDITOR_PROMPT,
          model: buildModel(provider),
          thinkingLevel: "off",
          tools: [],
        },
      });
      const bridge = attachPiBridge(agent, { maxIterations: 1 });

      await agent.prompt("Instruction: " + (input.instruction ?? "") + "\n\nText:\n" + input.text);
      if (!bridge.capped()) {
        const error = agent.state.errorMessage;
        if (error) return jsonResult({ ok: false, message: error });
      }
      return jsonResult({ ok: true, polished: lastAssistantText(agent) });
    },
  };
}
