// /new build runner mechanics: in-chat clarify channel, submit routing, Esc
// interrupt, and the HomeView /new surface. Deliberately no real pipeline
// runs here: the stage stream function leaks a 300s AbortSignal timeout timer
// per failed request, which would hang bun test at exit. Pipeline plumbing
// (full happy path, interrupt, resume) is verified by the pty smoke against a
// scripted fake LLM server.
import { describe, expect, test } from "bun:test";
import { Transcript, HomeView } from "../src/tui/App";
import { BuildRunner } from "../src/tui/build";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { ProviderSelection } from "@tutor/llms";

const tui = { requestRender() {} } as unknown as TUI;

const provider = {
  provider: "openai",
  modelId: "fake",
  baseUrl: "http://127.0.0.1:1/v1",
  label: "fake",
} as ProviderSelection;

function makeRunner(): { runner: BuildRunner; transcript: Transcript; statuses: string[] } {
  const transcript = new Transcript();
  const statuses: string[] = [];
  const runner = new BuildRunner({
    courseRoot: "/tmp/lyceum-build-test",
    provider,
    transcript,
    onStatus: (text) => statuses.push(text),
    idleStatus: "idle",
  });
  return { runner, transcript, statuses };
}

describe("BuildRunner in-chat clarify channel", () => {
  test("askUser appends the question and resolves via submit", async () => {
    const { runner, transcript } = makeRunner();
    const answer = runner.askUser("what  level   is it for?");
    expect(transcript.render(80).join("\n")).toContain("coach asks: what level is it for?");
    expect(runner.submit("beginner")).toBe(true);
    await expect(answer).resolves.toBe("beginner");
  });

  test("interrupt rejects a pending question; idle-safe (no abort when not running)", async () => {
    const { runner } = makeRunner();
    const answer = runner.askUser("question?");
    runner.interrupt();
    await expect(answer).rejects.toThrow("interrupted");
    expect(runner.abort.signal.aborted).toBe(false);
  });
});

describe("BuildRunner submit routing", () => {
  test("submit returns false when nothing is running", () => {
    const { runner } = makeRunner();
    expect(runner.submit("hello")).toBe(false);
  });

  test("a pending question is answered even before running flips (question wins)", async () => {
    const { runner } = makeRunner();
    const answer = runner.askUser("q?");
    expect(runner.submit("yes")).toBe(true);
    await expect(answer).resolves.toBe("yes");
  });
});

describe("HomeView /new surface", () => {
  test("bare /new prints usage without touching the runner", () => {
    const home = new HomeView(tui, {
      modules: [],
      provider,
      courseRoot: "/tmp/lyceum-home-test",
      onQuit: () => {},
    });
    home.focusable.onSubmit?.("/new");
    const rows = home.transcript.render(80).join("\n");
    expect(rows).toContain("you » /new");
    expect(rows).toContain("usage: /new <course name>");
  });

  test("Escape quits when idle (no build running)", () => {
    let quit = 0;
    const home = new HomeView(tui, {
      modules: [],
      provider,
      courseRoot: "/tmp/lyceum-home-test",
      onQuit: () => (quit += 1),
    });
    home.focusable.onEscape?.();
    expect(quit).toBe(1);
  });
});
