// Live progress for CLI pipeline runs: streams the model's text and reasoning
// deltas and logs each tool call, so a multi-stage course build never looks
// hung. Opt-in (bin.ts passes `progress: true`); stage tests stay silent.
import type { TutorRuntimeEvent } from "./pi-events";

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
 * A TutorRuntimeEvent listener that echoes a live run to stdout: reasoning
 * and answer text stream as-is, tool calls appear as `[stage] → name args`
 * lines with an ok/failed follow-up.
 */
export function progressLogger(label: string): (event: TutorRuntimeEvent) => void {
  return (event) => {
    switch (event.type) {
      case "assistant-reasoning-delta":
      case "assistant-text-delta":
        process.stdout.write(event.text);
        break;
      case "tool-started":
        process.stdout.write(`\n[${label}] → ${event.toolName} ${summarizeInput(event.args)}\n`);
        break;
      case "tool-finished":
        process.stdout.write(`[${label}] ${event.isError ? "failed" : "ok"} ${event.toolName}\n`);
        break;
      case "assistant-message":
        if (event.finishReason === "stop") process.stdout.write("\n");
        break;
      default:
        break;
    }
  };
}
