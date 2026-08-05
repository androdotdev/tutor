// Tool type boundary for @tutor/core. Tools are authored once in the pi
// shape (mirroring @earendil-works/pi-agent-core's `AgentTool`, structurally,
// so core never needs the runtime package as a dependency) and consumed
// directly by the pi agent loop once the runtime swap lands (P3). Until then
// `toClineTool` bridges into the @cline runtime; the adapter is deleted in P3.
import { createTool, type AgentTool as ClineAgentTool } from "@cline/shared";
import type { Static, TSchema, Tool, TextContent, ImageContent, Usage } from "@earendil-works/pi-ai";

export interface PiToolResult<TDetails = unknown> {
  /** Text or image content returned to the model. */
  content: (TextContent | ImageContent)[];
  /** Arbitrary structured details for logs or UI rendering. */
  details: TDetails;
  usage?: Usage;
  /** Names of tools introduced by this result and available from this transcript point onward. */
  addedToolNames?: string[];
  /** Hint that the agent should stop after the current tool batch. */
  terminate?: boolean;
}

export interface PiAgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> extends Tool<TParameters> {
  /** Human-readable label for UI display. */
  label: string;
  /** Execute the tool call. Throw on failure instead of encoding errors in `content`. */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: (partial: PiToolResult<TDetails>) => void,
  ) => Promise<PiToolResult<TDetails>>;
}

/** Single-text tool result; `details` carries the structured payload for logs. */
export function textResult(text: string, details: unknown): PiToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

/** Tool result whose model-visible text is the JSON of `details` (wire parity with the old JSON tool outputs). */
export function jsonResult(details: unknown): PiToolResult<unknown> {
  return textResult(JSON.stringify(details), details);
}

/** Cline-runtime bridge: pi-shaped tool -> @cline createTool. Deleted in P3. */
export function toClineTool(tool: PiAgentTool): ClineAgentTool {
  return createTool({
    name: tool.name,
    description: tool.description,
    inputSchema: JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>,
    execute: async (input: Parameters<typeof tool.execute>[1]) => {
      const result = await tool.execute("", input);
      return { output: result.content.map((c) => (c.type === "text" ? c.text : "")).join("") };
    },
  });
}
