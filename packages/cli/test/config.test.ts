// XDG config loader tests: missing files are not errors, per-key env fallback
// lives in the provider resolver, system-prompt.md wins over the JSON key.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserConfig } from "../src/config";

let home: string;
let prev: string | undefined;

beforeAll(() => {
  prev = process.env.XDG_CONFIG_HOME;
  home = mkdtempSync(join(tmpdir(), "lyceum-cfg-"));
  process.env.XDG_CONFIG_HOME = home;
});

afterAll(() => {
  if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prev;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("no config dir -> empty config, never throws", () => {
  const c = loadUserConfig();
  expect(c.provider).toEqual({});
  expect(c.systemPrompt).toBeUndefined();
  expect(c.defaultCourse).toBeUndefined();
  expect(c.skillsDir).toBe(join(home, "lyceum", "skills"));
});

test("invalid config.json is ignored, not fatal", () => {
  mkdirSync(join(home, "lyceum"), { recursive: true });
  writeFileSync(join(home, "lyceum", "config.json"), "{nope");
  const c = loadUserConfig();
  expect(c.provider).toEqual({});
});

test("parses config.json provider + defaultCourse", () => {
  writeFileSync(
    join(home, "lyceum", "config.json"),
    JSON.stringify({
      provider: { apiKey: "k", baseUrl: "https://x/v1", model: "m" },
      defaultCourse: "/courses/express",
      extra: "ignored",
    }),
  );
  const c = loadUserConfig();
  expect(c.provider).toEqual({ apiKey: "k", baseUrl: "https://x/v1", model: "m" });
  expect(c.defaultCourse).toBe("/courses/express");
  expect(c.systemPrompt).toBeUndefined();
});

test("system-prompt.md wins over config.json systemPrompt", () => {
  writeFileSync(join(home, "lyceum", "config.json"), JSON.stringify({ systemPrompt: "json prompt" }));
  writeFileSync(join(home, "lyceum", "system-prompt.md"), "file prompt");
  const c = loadUserConfig();
  expect(c.systemPrompt).toBe("file prompt");
});

test("truncates an oversized system prompt", () => {
  rmSync(join(home, "lyceum", "system-prompt.md"), { force: true });
  writeFileSync(join(home, "lyceum", "system-prompt.md"), "x".repeat(9_000));
  const c = loadUserConfig();
  expect(c.systemPrompt?.endsWith("\n…(truncated)")).toBe(true);
  expect(c.systemPrompt!.length).toBe(8_000 + "\n…(truncated)".length);
});
