// App-facing runtime events for the pi agent loop. The pi `Agent` emits its
// own `AgentEvent` vocabulary; stages subscribe through `attachPiBridge`,
// which maps those onto this smaller surface (text deltas, tool lifecycle,
// run outcome) and enforces the cline-era `maxIterations` cap via abort().
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

export type TutorRuntimeEvent =
  | { type: "assistant-text-delta"; text: string; accumulatedText: string }
  | { type: "assistant-reasoning-delta"; text: string }
  | { type: "tool-started"; toolName: string; args: unknown }
  | { type: "tool-finished"; toolName: string; isError: boolean; result: unknown }
  | { type: "assistant-message"; finishReason: string }
  | { type: "run-finished" }
  | { type: "run-failed"; error: Error };

export interface PiBridgeHooks {
  /** Cap on turns (one model call + its tool executions) per run. */
  maxIterations?: number;
  /** App-facing listener; also receives run-finished/run-failed at agent_end. */
  onEvent?: (event: TutorRuntimeEvent) => void;
}

export interface PiBridge {
  /** True when the run ended because the maxIterations cap aborted it. */
  capped: () => boolean;
  /** Detach the bridge's subscriber from the agent. */
  detach: () => void;
}

/**
 * Subscribe to a pi Agent and map its events onto `TutorRuntimeEvent`.
 *
 * maxIterations: pi has no iteration cap, so the bridge counts `turn_end`s
 * and aborts once the cap is reached. Aborting after the capped turn's
 * `turn_end` fires only bites if the model would have started ANOTHER turn
 * (the loop then fails that stream and appends a synthetic empty failure
 * message); a model that finished in exactly `maxIterations` turns ends
 * cleanly. `lastAssistantText` skips that synthetic message.
 *
 * run-failed vs run-finished: a genuinely failed run leaves
 * `agent.state.errorMessage` set (stream error, abort, provider failure).
 * A capped run also aborts, so the bridge prefers the cap: capped runs
 * report run-finished (their last real answer is the deliverable).
 */
export function attachPiBridge(agent: Agent, hooks: PiBridgeHooks = {}): PiBridge {
  let turns = 0;
  let capped = false;
  let errorMessage: string | undefined;

  const detach = agent.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        // The cap is per run (prompt/continue), not cumulative.
        turns = 0;
        capped = false;
        errorMessage = undefined;
        break;
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") {
          hooks.onEvent?.({
            type: "assistant-text-delta",
            text: e.delta,
            accumulatedText: assistantText(event.message),
          });
        } else if (e.type === "thinking_delta") {
          hooks.onEvent?.({ type: "assistant-reasoning-delta", text: e.delta });
        }
        break;
      }
      case "tool_execution_start":
        hooks.onEvent?.({ type: "tool-started", toolName: event.toolName, args: event.args });
        break;
      case "tool_execution_end":
        hooks.onEvent?.({ type: "tool-finished", toolName: event.toolName, isError: event.isError, result: event.result });
        break;
      case "turn_end":
        turns++;
        if (hooks.maxIterations !== undefined && turns >= hooks.maxIterations) {
          capped = true;
          agent.abort();
        }
        if (event.message.role === "assistant") {
          hooks.onEvent?.({ type: "assistant-message", finishReason: event.message.stopReason });
          if (event.message.errorMessage) errorMessage = event.message.errorMessage;
        }
        break;
      case "agent_end":
        hooks.onEvent?.(
          capped || !errorMessage ? { type: "run-finished" } : { type: "run-failed", error: new Error(errorMessage) },
        );
        break;
      default:
        break;
    }
  });

  return { capped: () => capped, detach };
}

/** Concatenated plain-text content of a message (tool calls excluded). */
export function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("");
}

/**
 * Final assistant text after a run. Skips assistant messages carrying an
 * `errorMessage` (the synthetic failure appended when the maxIterations cap
 * aborts an ongoing loop), so a capped run still yields its last real answer.
 */
export function lastAssistantText(agent: Agent): string {
  const messages = agent.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && !message.errorMessage) {
      return assistantText(message);
    }
  }
  return "";
}
