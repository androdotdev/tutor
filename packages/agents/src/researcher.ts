// Research stage: gather sourced facts about the topic and land them in
// `.lyceum/research.json` via write_file (Option A — file-based handoff, see
// .draft/course-builder-redesign.md). Tool-call ARGUMENT transport is the
// fragile channel (chunking, stripped args, truncation); the file channel
// persists, is inspectable, and survives crashes. The stage reads + validates
// the file after the run and retries once with corrective notes.
import { Agent } from "@earendil-works/pi-agent-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildAuthorTools, type PiAgentTool } from "@tutor/core";
import { buildModel, buildStreamFn, type ProviderSelection } from "@tutor/llms";
import type { ResearchFinding, ResearchReport } from "./pipeline-types";
import { attachPiBridge, lastAssistantText, type TutorRuntimeEvent } from "./pi-events";
import { stageSink, wireAbort } from "./progress";

export interface ResearchOptions {
  provider: ProviderSelection;
  prompt: string;
  /** Course root; the report lands at `<courseRoot>/.lyceum/research.json`. */
  courseRoot: string;
  webSearchTool: PiAgentTool;
  /** Stream the model's reasoning/text and log tool calls to stdout. */
  progress?: boolean;
  /** Append the full stream to this file (lyceum new --log). */
  logFile?: string;
  /** Abort the in-flight research run (Esc in the TUI). */
  abort?: AbortSignal;
  /** Extra app-facing listener alongside the stage sink (TUI transcript). */
  onEvent?: (event: TutorRuntimeEvent) => void;
}

const MAX_RESEARCH_ITERATIONS = 12;
const RESEARCH_FILE = join(".lyceum", "research.json");

function buildResearchPrompt(): string {
  return [
    "You are a research assistant for course authoring. Use the web_search tool to gather CURRENT, sourced facts about the course topic in your task (official docs, best practices, current API shapes).",
    "Search as many times as you need. When done, write your findings to .lyceum/research.json using the write_file tool: a JSON object { findings: [{ claim, source_url, note? }], caveats? }.",
    "Every finding MUST have a claim and a source_url of the page supporting it; if results are thin or conflicting, say so in caveats.",
    "Never invent a source_url. After writing the file, reply with a one-line summary.",
  ].join(" ");
}

/**
 * Validation errors for a research.json payload; null when the payload is a
 * valid report. Each entry names the exact field problem so a corrective retry
 * (and the final CLI error) can tell the model what to fix.
 */
export function reportErrors(input: unknown): string[] | null {
  if (typeof input !== "object" || input === null) {
    return ["research.json content was not a JSON object"];
  }
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.findings)) {
    return ["findings is missing or not an array"];
  }
  const errors: string[] = [];
  record.findings.forEach((item, i) => {
    if (typeof item !== "object" || item === null) {
      errors.push(`findings[${i}] is not an object`);
      return;
    }
    const finding = item as Record<string, unknown>;
    if (typeof finding.claim !== "string" || finding.claim.trim() === "") {
      errors.push(`findings[${i}].claim is missing or empty`);
    }
    if (typeof finding.source_url !== "string") {
      errors.push(`findings[${i}].source_url is missing or not a string`);
    }
    if (finding.note !== undefined && typeof finding.note !== "string") {
      errors.push(`findings[${i}].note must be a string`);
    }
  });
  if (record.caveats !== undefined && typeof record.caveats !== "string") {
    errors.push("caveats must be a string (or omit it)");
  }
  return errors.length ? errors : null;
}

/**
 * Shape guard for the research.json payload. `findings` must be an array of
 * objects each with a non-empty string `claim` and a string `source_url`
 * (optional string `note`); `caveats` is an optional string. An empty
 * findings array is valid. Anything else -> null.
 */
export function parseReport(input: unknown): ResearchReport | null {
  if (reportErrors(input)) return null;
  const record = input as Record<string, unknown>;

  const findings: ResearchFinding[] = [];
  for (const item of record.findings as unknown[]) {
    const finding = item as Record<string, unknown>;
    const parsed: ResearchFinding = { claim: finding.claim as string, source_url: finding.source_url as string };
    if (typeof finding.note === "string") parsed.note = finding.note;
    findings.push(parsed);
  }

  const report: ResearchReport = { findings };
  if (typeof record.caveats === "string") report.caveats = record.caveats;
  return report;
}

/** Read + parse the stage file; distinguish missing vs unreadable vs invalid JSON. */
async function readStageFile(
  courseRoot: string,
  file: string,
): Promise<{ payload: unknown; parseError: string | null; hadFile: boolean }> {
  let raw: string;
  try {
    raw = await readFile(join(courseRoot, file), "utf8");
  } catch {
    return { payload: undefined, parseError: null, hadFile: false };
  }
  try {
    return { payload: JSON.parse(raw) as unknown, parseError: null, hadFile: true };
  } catch (err) {
    return {
      payload: undefined,
      parseError: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      hadFile: true,
    };
  }
}

/** One full agent run; resolves to the file outcome after the run. */
async function attempt(
  opts: ResearchOptions,
  prompt: string,
): Promise<{ report: ResearchReport | null; payload: unknown; parseError: string | null; hadFile: boolean; outputText: string }> {
  const { write_file } = buildAuthorTools({ courseRoot: opts.courseRoot, modules: [] });
  const agent = new Agent({
    streamFn: buildStreamFn(opts.provider),
    initialState: {
      systemPrompt: buildResearchPrompt(),
      model: buildModel(opts.provider),
      thinkingLevel: "off",
      tools: [opts.webSearchTool, write_file],
    },
  });
  const bridge = attachPiBridge(agent, {
    maxIterations: MAX_RESEARCH_ITERATIONS,
    onEvent: stageSink("research", {
      progress: opts.progress,
      logFile: opts.logFile,
      onEvent: opts.onEvent,
    }),
  });

  const unwire = wireAbort(agent, opts.abort);
  try {
    await agent.prompt(prompt);
  } finally {
    unwire();
  }
  if (!bridge.capped()) {
    const error = agent.state.errorMessage;
    if (error) throw new Error(error ?? "research run failed");
  }
  const { payload, parseError, hadFile } = await readStageFile(opts.courseRoot, RESEARCH_FILE);
  return { report: parseReport(payload), payload, parseError, hadFile, outputText: lastAssistantText(agent) };
}

/** A one-line sketch of the file payload for the final CLI error. */
function sketch(payload: unknown): string {
  try {
    const s = JSON.stringify(payload);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(payload);
  }
}

/** All validation/parse problems in a written file, for the retry note. */
function fileErrors(payload: unknown, parseError: string | null): string[] {
  if (parseError) return [parseError];
  return reportErrors(payload) ?? [];
}

/**
 * Runs the research stage: gathers sourced facts about the topic and returns
 * them as a validated ResearchReport. Retries ONCE with a corrective prompt
 * that names the exact validation problems; a second failure throws with the
 * reason (file never written vs invalid content) and the model's last text.
 */
export async function runResearch(opts: ResearchOptions): Promise<ResearchReport> {
  const first = await attempt(opts, opts.prompt);
  if (first.report) return first.report;

  const firstErrors = fileErrors(first.payload, first.parseError);
  const note = firstErrors.length
    ? `\n\nYour previous .lyceum/research.json was invalid:\n- ${firstErrors.join("\n- ")}\nFix those fields and write the file again with a valid report.`
    : "\n\nYour previous reply did not write .lyceum/research.json. Write it once via write_file with a valid report ({ findings: [{ claim, source_url }] }).";
  const retry = await attempt(opts, `${opts.prompt}${note}`);
  if (retry.report) return retry.report;

  const why = retry.hadFile
    ? `research.json is still invalid: ${fileErrors(retry.payload, retry.parseError).join("; ")} (file: ${sketch(retry.payload)})`
    : `the model finished without writing .lyceum/research.json; last output: ${JSON.stringify(retry.outputText.slice(0, 200))}`;
  throw new Error(`Research stage failed: ${why}`);
}
