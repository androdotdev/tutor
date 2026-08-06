// Live progress for CLI pipeline runs: streams the model's text and reasoning
// deltas and logs each tool call, so a multi-stage course build never looks
// hung. Opt-in (bin.ts passes `progress: true`); stage tests stay silent.
// `fileLogger` captures the same full stream to a file (lyceum new --log) —
// raw reasoning + text deltas + tool lifecycle — for dev and testing.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

/**
 * Append the full stream to a log file: reasoning and text deltas verbatim
 * (the accumulated "thinking"), each tool call with its args and outcome, and
 * the run's finish reason / failure. Sync writes so the log is complete even
 * when the process exits right after the run.
 *
 * Appends are best-effort: a log write failing (disk full, permissions) must
 * not abort the pipeline run — the log is dev tooling, the build is the
 * deliverable. The directory itself is created eagerly (mkdirSync throws), so
 * an unwritable .lyceum fails fast at first use instead of silently.
 */
export function fileLogger(path: string): (event: TutorRuntimeEvent) => void {
  mkdirSync(dirname(path), { recursive: true });
  return (event) => {
    const append = (text: string): void => {
      try {
        appendFileSync(path, text);
      } catch {
        /* best-effort: keep the run alive even if logging fails */
      }
    };
    switch (event.type) {
      case "assistant-reasoning-delta":
        append(event.text);
        break;
      case "assistant-text-delta":
        append(event.text);
        break;
      case "tool-started":
        append(`\n[tool-started] ${event.toolName} ${summarizeInput(event.args)}\n`);
        break;
      case "tool-finished":
        append(`[tool-finished] ${event.isError ? "failed" : "ok"} ${event.toolName}\n`);
        break;
      case "assistant-message":
        append(`\n[assistant-message] finish=${event.finishReason}\n`);
        break;
      case "run-finished":
        append("[run-finished]\n");
        break;
      case "run-failed":
        append(`[run-failed] ${event.error.message}\n`);
        break;
    }
  };
}

/** Combine the stdout progress logger with an optional file log; undefined when neither is set. */
export function stageSink(
  label: string,
  opts: { progress?: boolean; logFile?: string },
): ((event: TutorRuntimeEvent) => void) | undefined {
  const stdout = opts.progress ? progressLogger(label) : undefined;
  const file = opts.logFile ? fileLogger(opts.logFile) : undefined;
  if (!stdout && !file) return undefined;
  return (event) => {
    stdout?.(event);
    file?.(event);
  };
}
