// Provider resolution precedence: env vars win per key, XDG config fills gaps.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveProvider } from "../src/provider";

const KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "TUTOR_MODEL", "OLLAMA_HOST"] as const;

beforeAll(() => {
  for (const k of KEYS) delete process.env[k];
});
afterAll(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("resolveProvider config fallback", () => {
  test("nothing configured -> null", () => {
    expect(resolveProvider()).toBeNull();
    expect(resolveProvider({ model: "x" })).toBeNull(); // model alone is not an endpoint
  });

  test("config alone supplies an OpenAI provider", () => {
    const p = resolveProvider({ apiKey: "cfg-key", model: "cfg-model", baseUrl: "https://cfg.example.com/v1" });
    expect(p?.provider).toBe("openai");
    expect(p?.apiKey).toBe("cfg-key");
    expect(p?.modelId).toBe("cfg-model");
    expect(p?.baseUrl).toBe("https://cfg.example.com/v1");
  });

  test("env vars win over config, per key", () => {
    process.env.OPENAI_API_KEY = "env-key";
    process.env.TUTOR_MODEL = "env-model";
    const p = resolveProvider({ apiKey: "cfg-key", model: "cfg-model", baseUrl: "https://cfg.example/v1" });
    expect(p?.apiKey).toBe("env-key");
    expect(p?.modelId).toBe("env-model");
    expect(p?.baseUrl).toBe("https://cfg.example/v1"); // env base unset -> config base
  });

  test("env key with config model/base fills the gaps", () => {
    delete process.env.TUTOR_MODEL;
    const p = resolveProvider({ model: "cfg-model", baseUrl: "https://cfg.example/v1" });
    expect(p?.apiKey).toBe("env-key");
    expect(p?.modelId).toBe("cfg-model");
  });

  test("config baseUrl without apiKey is treated as a local endpoint", () => {
    delete process.env.OPENAI_API_KEY;
    const p = resolveProvider({ baseUrl: "http://127.0.0.1:11434" });
    expect(p?.provider).toBe("ollama");
    expect(p?.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });
});
