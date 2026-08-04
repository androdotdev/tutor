// Live progress for CLI pipeline runs: streams the model's text and reasoning
// deltas and logs each tool call, so a multi-stage course build never looks
// hung. Opt-in (bin.ts passes `progress: true`); stage tests stay silent.
import type { AgentRuntimeEvent } from "@cline/shared";

/** Compact, single-line rendering of a tool-call argument. */
function summarizeInput(input: unknown): string {
  if (typeof input === "string") return input.length > 72 ? `${input.slice(0, 72)}…` : input;
  try {
    const s = JSON.stringify(input);
    return s.length > 72 ? `${s.slice(0, 72)}…` : s;
  } catch {
    return String(input);
  }
}

/**
 * An AgentRuntimeEvent listener that echoes a live run to stdout: reasoning
 * and answer text stream as-is, tool calls appear as `[stage] → name args`
 * lines with an ok/failed follow-up.
 */
export function progressLogger(label: string): (event: AgentRuntimeEvent) => void {
  return (event) => {
    switch (event.type) {
      case "assistant-reasoning-delta":
      case "assistant-text-delta":
        process.stdout.write(event.text);
        break;
      case "tool-started": {
        const tc = event.toolCall;
        let line = `\n[${label}] → ${tc.toolName} ${summarizeInput(tc.input)}`;
        const parseError = (tc.metadata as { inputParseError?: unknown } | undefined)?.inputParseError;
        const rawInput = (tc.metadata as { rawInputText?: unknown } | undefined)?.rawInputText;
        if (parseError) {
          const raw = typeof rawInput === "string" ? rawInput : "";
          const detail = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
          line += ` (unparseable args${detail ? `: ${JSON.stringify(detail)}` : ""})`;
        }
        process.stdout.write(`${line}\n`);
        break;
      }
      case "tool-finished": {
        const failed = event.message.content.some((p) => p.type === "tool-result" && p.isError);
        process.stdout.write(`[${label}] ${failed ? "failed" : "ok"} ${event.toolCall.toolName}\n`);
        break;
      }
      case "assistant-message":
        if (event.finishReason === "stop") process.stdout.write("\n");
        break;
      default:
        break;
    }
  };
}
