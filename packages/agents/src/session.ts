import { createAgentRuntime, type AgentRuntimeConfig } from "@cline/agents";
import type { AgentMessage, AgentRuntimeEvent } from "@cline/shared";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isSpoiler, type ModuleDesc } from "@tutor/shared";
import { buildModel, type ProviderSelection } from "@tutor/llms";
import { buildTools, toClineTool } from "@tutor/core";
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
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
}

export function createTutorSession(opts: TutorSessionOptions): TutorSession {
  const baseTools = buildTools({ courseRoot: opts.courseRoot, modules: opts.modules, skillsDir: opts.skillsDir });

  // Resume: load the per-course history file, seed the most recent turns so
  // the coach actually has the context of the earlier conversation.
  const turns: HistoryTurn[] = opts.historyFile ? loadHistoryFile(opts.historyFile) : [];
  const initialMessages: AgentMessage[] = turns.slice(-HISTORY_SEED_TURNS).map((t, i) => ({
    id: `hist-${t.ts}-${i}`,
    role: t.who,
    content: [{ type: "text", text: t.text }],
    createdAt: t.ts,
  }));

  const runtime = createAgentRuntime({
    model: buildModel(opts.provider),
    systemPrompt: buildSystemPrompt(opts.module, buildModuleContext(opts.courseRoot, opts.module), opts.userPrompt),
    tools: [toClineTool(baseTools.run_tests), toClineTool(baseTools.read_file), toClineTool(baseTools.grep)],
    maxIterations: opts.maxIterations ?? 8,
    initialMessages: initialMessages.length ? initialMessages : undefined,
  } satisfies AgentRuntimeConfig);

  const persist = (turn: HistoryTurn): void => {
    if (!opts.historyFile) return;
    turns.push(turn);
    while (turns.length > HISTORY_MAX_TURNS) turns.shift();
    saveHistoryFile(opts.historyFile, turns);
  };

  let started = false;

  return {
    historyTurns: turns,
    async ask(input: string): Promise<string> {
      let result;
      try {
        result = started ? await runtime.continue(input) : await runtime.run(input);
        started = true;
      } catch (err) {
        // Keep the question even when the run itself blew up mid-flight.
        persist({ who: "user", text: input, ts: Date.now() });
        throw err;
      }
      // @cline/agents resolves with status "failed" instead of rejecting for most
      // loop errors; surface them so callers (TUI, CLI) can show a real message.
      if (result.status === "failed") {
        persist({ who: "user", text: input, ts: Date.now() });
        throw new Error(result.error?.message ?? "coach run failed");
      }
      persist({ who: "user", text: input, ts: Date.now() });
      persist({ who: "assistant", text: result.outputText, ts: Date.now() });
      return result.outputText;
    },
    abort(reason?: unknown) {
      runtime.abort(reason);
    },
    subscribe(listener) {
      return runtime.subscribe(listener);
    },
  };
}