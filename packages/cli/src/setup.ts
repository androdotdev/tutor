// `lyceum setup`: interactively write the user config to the XDG config dir
// (~/.config/lyceum/config.json, or $XDG_CONFIG_HOME/lyceum). Env vars still
// win over config at resolution time (see @tutor/llms resolveProvider) — setup
// only writes the file, it never sets env vars.
//
// Line input is a hand-rolled reader, NOT node:readline/promises: Bun's
// readline/promises `question()` hangs on the second call when stdin is a pipe
// (verified 2026-08-06), which breaks scripted/CI setup. The manual reader
// handles both TTY (line-buffered data events) and pipes (multi-line chunks
// land in one event — a backlog carries the surplus to the next question).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { configDir } from "./config";

export interface SetupResult {
  dir: string;
  /** Absolute path of the written config.json. */
  path: string;
}

interface ExistingConfig {
  provider?: { apiKey?: string; baseUrl?: string; model?: string };
  defaultCourse?: string;
  systemPrompt?: string;
}

/** Bytes read but not yet consumed by a question (a pipe can deliver several lines at once). */
let backlog = "";

/** Read one line from stdin; never hangs on EOF when backlog is empty. */
function readLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    const take = (): boolean => {
      const nl = backlog.indexOf("\n");
      if (nl < 0) return false;
      const line = backlog.slice(0, nl).replace(/\r$/, "");
      backlog = backlog.slice(nl + 1);
      resolve(line);
      return true;
    };
    if (take()) return;

    const onData = (chunk: Buffer): void => {
      backlog += chunk.toString("utf8");
      if (take()) {
        stdin.off("data", onData);
        stdin.off("end", onEnd);
        stdin.off("error", onError);
      }
    };
    const onEnd = (): void => {
      stdin.off("data", onData);
      stdin.off("error", onError);
      // Trailing input without a newline is still an answer.
      if (backlog) {
        const line = backlog;
        backlog = "";
        resolve(line);
      } else {
        reject(new Error("stdin closed while waiting for input"));
      }
    };
    const onError = (err: Error): void => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      reject(err);
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
  });
}

/** One prompt; empty answer keeps the current value (shown as the default). */
async function ask(label: string, current: string | undefined): Promise<string> {
  const hint = current ? ` [${current}]` : "";
  stdout.write(`${label}${hint}: `);
  const answer = (await readLine()).trim();
  return answer || current || "";
}

function loadExisting(): ExistingConfig {
  try {
    const raw = readFileSync(join(configDir(), "config.json"), "utf8");
    const data: unknown = JSON.parse(raw);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return data as ExistingConfig;
    }
  } catch {
    /* no config yet */
  }
  return {};
}

/**
 * Prompt for apiKey / baseUrl / model / defaultCourse and write config.json,
 * preserving any existing systemPrompt and untouched provider fields.
 */
export async function runSetup(): Promise<SetupResult> {
  const dir = configDir();
  const existing = loadExisting();
  const envKey = process.env.OPENAI_API_KEY;
  const envBase = process.env.OPENAI_BASE_URL;

  stdout.write(`lyceum setup — writes ${dir}/config.json (env vars win over config)\n`);
  const apiKey = await ask("API key", existing.provider?.apiKey ?? envKey);
  const baseUrl = await ask("Base URL", existing.provider?.baseUrl ?? envBase);
  const model = await ask("Model", existing.provider?.model);
  const defaultCourse = await ask("Default course directory", existing.defaultCourse);

  const provider: Record<string, string> = {};
  if (apiKey) provider.apiKey = apiKey;
  if (baseUrl) provider.baseUrl = baseUrl;
  if (model) provider.model = model;

  const config: Record<string, unknown> = {};
  if (Object.keys(provider).length) config.provider = provider;
  if (defaultCourse) config.defaultCourse = defaultCourse;
  if (existing.systemPrompt) config.systemPrompt = existing.systemPrompt;

  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return { dir, path };
}
