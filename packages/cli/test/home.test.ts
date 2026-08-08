// Home command surface tests: slash dispatch + transcript output.
import { describe, expect, test } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { HomeView, runHomeCommand } from "../src/tui/App";
import type { ModuleDesc } from "@tutor/shared";
import type { ProviderSelection } from "@tutor/llms";

const tui = { requestRender() {} } as unknown as TUI;

const modules = [
  { id: "m1", title: "One", dir: "one", moduleDir: "one", layout: "exercise" },
  { id: "m2", title: "Two", dir: "two", moduleDir: "two", layout: "lecture" },
] as ModuleDesc[];

const provider = {
  provider: "openai",
  modelId: "gpt-x",
  baseUrl: "https://api.test/v1",
  label: "openai",
} as ProviderSelection;

function makeHome(onQuit = () => {}): HomeView {
  return new HomeView(tui, { modules, provider, courseRoot: "/tmp/lyceum-home-test", onQuit });
}

describe("runHomeCommand", () => {
  test("/list prints every module", () => {
    const notes = runHomeCommand("/list", { modules, provider }).join("\n");
    expect(notes).toContain("m1");
    expect(notes).toContain("m2");
    expect(notes).toContain("exercise · one");
  });

  test("/list with no modules explains how to point at a course", () => {
    const notes = runHomeCommand("/list", { modules: [], provider }).join("\n");
    expect(notes).toContain("no modules found");
  });

  test("/provider prints label, model and baseUrl but never the key", () => {
    const withKey = { ...provider, apiKey: "sk-secret" };
    const notes = runHomeCommand("/provider", { modules, provider: withKey }).join("\n");
    expect(notes).toContain("openai · gpt-x · https://api.test/v1");
    expect(notes).not.toContain("sk-secret");
  });

  test("/provider without a configured LLM says none configured", () => {
    const notes = runHomeCommand("/provider", { modules, provider: null }).join("\n");
    expect(notes).toContain("none configured");
    expect(notes).toContain("OPENAI_API_KEY");
  });

  test("/help lists the commands", () => {
    const notes = runHomeCommand("/help", { modules, provider }).join("\n");
    expect(notes).toContain("/list");
    expect(notes).toContain("/provider");
    expect(notes).toContain("/new");
    expect(notes).toContain("/help");
  });

  test("unknown slash gets a hint, not silence", () => {
    const notes = runHomeCommand("/bogus", { modules, provider }).join("\n");
    expect(notes).toContain("unknown command: /bogus");
    expect(notes).toContain("/help");
  });
});

describe("HomeView", () => {
  test("submit /list appends module rows to the transcript", () => {
    const home = makeHome();
    home.focusable.onSubmit?.("/list");
    const rows = home.transcript.render(80).join("\n");
    expect(rows).toContain("you » /list");
    expect(rows).toContain("m1 — One");
    expect(rows).toContain("m2 — Two");
  });

  test("plain text gets the no-chat hint", () => {
    const home = makeHome();
    home.focusable.onSubmit?.("hello");
    const rows = home.transcript.render(80).join("\n");
    expect(rows).toContain("you » hello");
    expect(rows).toContain("home has no chat");
  });

  test("Escape quits the app", () => {
    let quit = 0;
    const home = makeHome(() => (quit += 1));
    home.focusable.onEscape?.();
    expect(quit).toBe(1);
  });

  test("empty submit is ignored (no new rows)", () => {
    const home = makeHome();
    const before = home.transcript.render(80);
    home.focusable.onSubmit?.("   ");
    expect(home.transcript.render(80)).toBe(before);
  });

  test("transcript stays unbounded: settled rows are byte-stable", () => {
    const home = makeHome();
    home.focusable.onSubmit?.("/list");
    const first = home.transcript.render(80);
    const again = home.transcript.render(80);
    expect(again).toBe(first);
  });
});
