// Full-stream file logging (lyceum new --log): every event type lands in the
// file verbatim — reasoning/text deltas, tool lifecycle, finish reasons, and
// run outcomes — and stageSink stays silent unless progress or a log file is
// requested.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLogger, stageSink } from "../src/progress";

function tempLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "lyceum-log-"));
  return join(dir, "new.log");
}

describe("fileLogger", () => {
  test("captures the full stream: deltas, tool lifecycle, finish reason, run outcome", () => {
    const path = tempLog();
    const log = fileLogger(path);
    log({ type: "assistant-reasoning-delta", text: "r1" });
    log({ type: "assistant-text-delta", text: "t1" });
    log({ type: "tool-started", toolName: "ask_user", args: { question: "What level?" } });
    log({ type: "tool-finished", toolName: "ask_user", isError: true, result: "boom" });
    log({ type: "assistant-message", finishReason: "length" });
    log({ type: "run-failed", error: new Error("stream ended") });

    const content = readFileSync(path, "utf8");
    expect(content).toContain("r1");
    expect(content).toContain("t1");
    expect(content).toContain("[tool-started] ask_user {\"question\":\"What level?\"}");
    expect(content).toContain("[tool-finished] failed ask_user");
    expect(content).toContain("[assistant-message] finish=length");
    expect(content).toContain("[run-failed] stream ended");
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("stageSink returns undefined when neither progress nor logFile is set", () => {
    expect(stageSink("plan", {})).toBeUndefined();
    expect(stageSink("plan", { progress: false })).toBeUndefined();
  });

  test("stageSink writes the file when only logFile is set (no stdout)", () => {
    const path = tempLog();
    const sink = stageSink("plan", { logFile: path });
    expect(sink).toBeDefined();
    sink?.({ type: "assistant-text-delta", text: "hello" });
    expect(readFileSync(path, "utf8")).toBe("hello");
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("a failing append is swallowed: logging never aborts the run", () => {
    // A directory path makes appendFileSync throw EISDIR on every write; the
    // logger must keep going (best-effort) instead of throwing.
    const dir = mkdtempSync(join(tmpdir(), "lyceum-log-"));
    const log = fileLogger(join(dir, "sub", "new.log")); // mkdir succeeds
    log({ type: "assistant-text-delta", text: "x" });
    expect(() => fileLogger(dir) /* EISDIR on append */).not.toThrow();
    const doomed = fileLogger(dir);
    expect(() => doomed({ type: "assistant-text-delta", text: "y" })).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
