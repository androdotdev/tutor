import { Agent } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isSpoiler, type ModuleDesc } from "@tutor/shared";
import { buildModel, buildStreamFn, type ProviderSelection } from "@tutor/llms";
import { buildTools } from "@tutor/core";
import { attachPiBridge, lastAssistantText, type TutorRuntimeEvent } from "./pi-events";
import { buildSystemPrompt, type ModuleContext } from "./policy";

/** Per-file cap for context injected into the prompt. */
const CONTEXT_FILE_LIMIT = 8_000;

/** One recorded exchange turn (the learner's own conversation, stored locally). */
export interface HistoryTurn {
  who: "user" | "assistant";
  text: string;
  ts: number;
}

/** Turns kept in the session file; the oldest rotate out beyond this. */
const HISTORY_MAX_TURNS = 500;
/** Most recent turns seeded into the model when a session resumes. */
const HISTORY_SEED_TURNS = 50;

/** Load a session history file; missing or corrupt files yield []. */
export function loadHistoryFile(file: string): HistoryTurn[] {
  try {
    const raw = readFileSync(file, "utf8");
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const turns: HistoryTurn[] = [];
    for (const item of data) {
      const who = (item as { who?: unknown } | null)?.who;
      if (who !== "user" && who !== "assistant") continue;
      const text = (item as { text?: unknown }).text;
      const ts = (item as { ts?: unknown }).ts;
      if (typeof text === "string" && typeof ts === "number") {
        turns.push({ who, text, ts });
      }
    }
    return turns;
  } catch {
    return [];
  }
}

/** Persist turns to a session file, creating parent dirs. */
export function saveHistoryFile(file: string, turns: readonly HistoryTurn[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(turns), "utf8");
  } catch {
    // History is best-effort: a read-only course dir must not break chat.
  }
}

function readContextFile(courseRoot: string, file: string | null): string | undefined {
  if (!file) return undefined;
  // Defense in depth: never load anything the resolver would classify as a
  // spoiler (solutions/ or project solution stubs), even though ModuleDesc
  // paths are resolver-derived and should already be safe.
  if (isSpoiler(courseRoot, file)) return undefined;
  try {
    const text = readFileSync(file, "utf8");
    return text.length > CONTEXT_FILE_LIMIT
      ? `${text.slice(0, CONTEXT_FILE_LIMIT)}\n…(truncated)`
      : text;
  } catch {
    // Missing or unreadable file: contribute nothing rather than crash the session.
    return undefined;
  }
}

function buildModuleContext(courseRoot: string, module: ModuleDesc): ModuleContext {
  return {
    readme: readContextFile(courseRoot, module.readme),
    exercise: readContextFile(courseRoot, module.student),
  };
}

export interface TutorSessionOptions {
  courseRoot: string;
  modules: ModuleDesc[];
  module: ModuleDesc;
  provider: ProviderSelection;
  /** max agent iterations per turn (default 8) */
  maxIterations?: number;
  /** learner's coaching instructions from XDG config, appended to the policy */
  userPrompt?: string;
  /** user skills dir (XDG config skills/): enables list_skills/get_skill */
  skillsDir?: string;
  /**
   * Per-course session history file (e.g. <course>/session/<module>.json).
   * Prior turns are loaded and seeded into the model; every completed or
   * failed turn is appended back. Best-effort: never breaks chat.
   */
  historyFile?: string;
}

export interface TutorSession {
  /** Turns loaded from (and appended to) the history file at session start. */
  historyTurns: readonly HistoryTurn[];
  /** Send the student's turn, await the assistant's final text. */
  ask(input: string): Promise<string>;
  /** Cancel any in-flight run. */
  abort(reason?: unknown): void;
  /** Subscribe to runtime events (assistant-text-delta, tool-finished, ...). */
  subscribe(listener: (event: TutorRuntimeEvent) => void): () => void;
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Seed the model with the most recent history turns, in pi Message shape. */
function seedMessages(turns: readonly HistoryTurn[], model: { provider: string; id: string }): Message[] {
  return turns.slice(-HISTORY_SEED_TURNS).map((t) =>
    t.who === "user"
      ? { role: "user" as const, content: [{ type: "text" as const, text: t.text }], timestamp: t.ts }
      : {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: t.text }],
          api: "openai-completions" as const,
          provider: model.provider,
          model: model.id,
          usage: EMPTY_USAGE,
          stopReason: "stop" as const,
          timestamp: t.ts,
        },
  );
}

export function createTutorSession(opts: TutorSessionOptions): TutorSession {
  const baseTools = buildTools({ courseRoot: opts.courseRoot, modules: opts.modules, skillsDir: opts.skillsDir });

  // Resume: load the per-course history file, seed the most recent turns so
  // the coach actually has the context of the earlier conversation.
  const turns: HistoryTurn[] = opts.historyFile ? loadHistoryFile(opts.historyFile) : [];
  const model = buildModel(opts.provider);
  const initialMessages = seedMessages(turns, model);

  const agent = new Agent({
    streamFn: buildStreamFn(opts.provider),
    initialState: {
      systemPrompt: buildSystemPrompt(opts.module, buildModuleContext(opts.courseRoot, opts.module), opts.userPrompt),
      model,
      thinkingLevel: "off",
      tools: [baseTools.run_tests, baseTools.read_file, baseTools.grep],
      messages: initialMessages,
    },
  });

  // App-facing events fan out to every subscriber; the cap is enforced here.
  const listeners = new Set<(event: TutorRuntimeEvent) => void>();
  const bridge = attachPiBridge(agent, {
    maxIterations: opts.maxIterations ?? 8,
    onEvent: (event) => {
      for (const listener of listeners) listener(event);
    },
  });

  const persist = (turn: HistoryTurn): void => {
    if (!opts.historyFile) return;
    turns.push(turn);
    while (turns.length > HISTORY_MAX_TURNS) turns.shift();
    saveHistoryFile(opts.historyFile, turns);
  };

  return {
    historyTurns: turns,
    async ask(input: string): Promise<string> {
      let outputText: string;
      try {
        await agent.prompt(input);
        if (bridge.capped()) {
          // The cap aborted the loop after the last completed turn; the
          // answer streamed before the abort is the deliverable.
          outputText = lastAssistantText(agent);
        } else {
          const error = agent.state.errorMessage;
          if (error) throw new Error(error);
          outputText = lastAssistantText(agent);
        }
      } catch (err) {
        // Keep the question even when the run itself blew up mid-flight.
        persist({ who: "user", text: input, ts: Date.now() });
        throw err;
      }
      persist({ who: "user", text: input, ts: Date.now() });
      persist({ who: "assistant", text: outputText, ts: Date.now() });
      return outputText;
    },
    abort() {
      agent.abort();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
