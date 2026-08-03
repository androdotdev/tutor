// XDG user config for lyceum: ~/.config/lyceum/ (or $XDG_CONFIG_HOME/lyceum).
//
//   config.json      { provider: { apiKey, baseUrl, model }, defaultCourse, systemPrompt }
//   system-prompt.md coaching instructions appended to the teaching policy
//                    (wins over the `systemPrompt` key when both exist)
//   skills/*.md      skills the tutor can load on demand (lazy: names only
//                    until get_skill is called; see list_skills/get_skill)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "@tutor/llms";

export interface UserConfig {
  dir: string;
  provider: ProviderConfig;
  defaultCourse?: string;
  systemPrompt?: string;
  skillsDir: string;
}

/** Cap for the user's coaching prompt (config.json key or system-prompt.md). */
const MAX_PROMPT = 8_000;

/** XDG config home for lyceum: $XDG_CONFIG_HOME/lyceum, else ~/.config/lyceum. */
export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "lyceum");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Load the user config; missing/broken files yield empty config, never throw. */
export function loadUserConfig(): UserConfig {
  const dir = configDir();

  const provider: ProviderConfig = {};
  let defaultCourse: string | undefined;
  let jsonPrompt: string | undefined;
  try {
    const raw = readFileSync(join(dir, "config.json"), "utf8");
    const data: unknown = JSON.parse(raw);
    if (isRecord(data)) {
      if (isRecord(data.provider)) {
        provider.apiKey = optionalString(data.provider.apiKey);
        provider.baseUrl = optionalString(data.provider.baseUrl);
        provider.model = optionalString(data.provider.model);
      }
      defaultCourse = optionalString(data.defaultCourse);
      jsonPrompt = optionalString(data.systemPrompt);
    }
  } catch {
    // No config.json or invalid JSON: fall through with defaults.
  }

  let systemPrompt = jsonPrompt;
  try {
    const filePrompt = readFileSync(join(dir, "system-prompt.md"), "utf8").trim();
    if (filePrompt) systemPrompt = filePrompt; // file wins over the config.json key
  } catch {
    /* no system-prompt.md */
  }
  if (systemPrompt && systemPrompt.length > MAX_PROMPT) {
    systemPrompt = `${systemPrompt.slice(0, MAX_PROMPT)}\n…(truncated)`;
  }

  return { dir, provider, defaultCourse, systemPrompt, skillsDir: join(dir, "skills") };
}
