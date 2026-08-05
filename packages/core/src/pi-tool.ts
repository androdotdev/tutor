// Tool type boundary for @tutor/core. Tools are authored in the pi shape and
// consumed directly by the pi agent loop (P3+): PiAgentTool IS pi-agent-core's
// AgentTool (type-only import — no runtime dependency), so tools pass into the
// Agent constructor without any adapter.
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";

export type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

/** Pi-shaped tool authored by @tutor/core; assignable straight into an Agent. */
export type PiAgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> = AgentTool<TParameters, TDetails>;

/** Result of a tool execution, as seen by the loop and the app. */
export type PiToolResult<TDetails = unknown> = AgentToolResult<TDetails>;

/** Single-text tool result; `details` carries the structured payload for logs. */
export function textResult(text: string, details: unknown): PiToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

/** Tool result whose model-visible text is the JSON of `details` (wire parity with the old JSON tool outputs). */
export function jsonResult(details: unknown): PiToolResult<unknown> {
  return textResult(JSON.stringify(details), details);
}
