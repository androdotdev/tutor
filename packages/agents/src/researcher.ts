import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { jsonResult, type PiAgentTool } from "@tutor/core";
import { buildModel, buildStreamFn, type ProviderSelection } from "@tutor/llms";
import type { ResearchFinding, ResearchReport } from "./pipeline-types";
import { attachPiBridge, lastAssistantText } from "./pi-events";
import { progressLogger } from "./progress";

export interface ResearchOptions {
  provider: ProviderSelection;
  prompt: string;
  webSearchTool: PiAgentTool;
  /** Stream the model's reasoning/text and log tool calls to stdout. */
  progress?: boolean;
}

const MAX_RESEARCH_ITERATIONS = 12;

function buildResearchPrompt(): string {
  return [
    "You are a research assistant for course authoring. Use the web_search tool to gather CURRENT, sourced facts about the course topic in your task (official docs, best practices, current API shapes).",
    "Search as many times as you need. When done, call submit_findings ONCE with the report: every finding MUST have",
    'a claim and a source_url of the page supporting it; if results are thin or conflicting, say so in caveats.',
    'Never invent a source_url. After submit_findings, reply "done".',
  ].join(" ");
}

/**
 * Validation errors for a submit_findings payload; null when the payload is a
 * valid report. Each entry names the exact field problem so a corrective retry
 * (and the final CLI error) can tell the model what to fix.
 */
export function reportErrors(input: unknown): string[] | null {
  if (typeof input !== "object" || input === null) {
    return ["submit_findings arguments were not a JSON object"];
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
 * Hand-rolled shape guard for the researcher's forced tool-call payload.
 * `findings` must be an array of objects each with a non-empty string `claim`
 * and a string `source_url` (optional string `note`); `caveats` is an optional
 * string. An empty findings array is valid. Anything else -> null.
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

/**
 * The researcher's only output channel: stashes the model's VALIDATED
 * arguments in a closure so the stage can read them after the run. The pi
 * loop validates the TypeBox schema before execute runs, so a malformed
 * payload never reaches the tool; its error is fed back to the model.
 * `terminate: true` ends the run right after the batch, like the old
 * completesRun lifecycle.
 */
const submitFindingsParams = Type.Object({
  findings: Type.Array(
    Type.Object({
      claim: Type.String(),
      source_url: Type.String(),
      note: Type.Optional(Type.String()),
    }),
  ),
  caveats: Type.Optional(Type.String()),
});

function createSubmitFindingsTool(): { tool: PiAgentTool<typeof submitFindingsParams>; captured: () => unknown } {
  let captured: unknown;
  const tool: PiAgentTool<typeof submitFindingsParams> = {
    name: "submit_findings",
    label: "Submit the research report",
    description: "Submit the research report. The ONLY way to deliver your findings.",
    parameters: submitFindingsParams,
    execute: async (_toolCallId, params) => {
      captured = params;
      return { ...jsonResult({ ok: true }), terminate: true };
    },
  };
  return { tool, captured: () => captured };
}

/** One full agent run; resolves to the capture outcome after the run. */
async function attempt(
  opts: ResearchOptions,
  prompt: string,
): Promise<{ report: ResearchReport | null; called: boolean; payload: unknown; outputText: string }> {
  const { tool: submitFindingsTool, captured } = createSubmitFindingsTool();
  const agent = new Agent({
    streamFn: buildStreamFn(opts.provider),
    initialState: {
      systemPrompt: buildResearchPrompt(),
      model: buildModel(opts.provider),
      thinkingLevel: "off",
      tools: [opts.webSearchTool, submitFindingsTool],
    },
  });
  const bridge = attachPiBridge(agent, {
    maxIterations: MAX_RESEARCH_ITERATIONS,
    onEvent: opts.progress ? progressLogger("research") : undefined,
  });

  await agent.prompt(prompt);
  if (!bridge.capped()) {
    const error = agent.state.errorMessage;
    if (error) throw new Error(error ?? "research run failed");
  }
  const payload = captured();
  return {
    report: parseReport(payload),
    called: payload !== undefined,
    payload,
    outputText: lastAssistantText(agent),
  };
}

/** A one-line sketch of the payload for the final CLI error. */
function sketch(payload: unknown): string {
  try {
    const s = JSON.stringify(payload);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(payload);
  }
}

/**
 * Runs the research stage: gathers sourced facts about the topic and returns
 * them as a validated ResearchReport. Retries ONCE with a corrective prompt
 * that names the exact validation problems; a second failure throws with the
 * reason (never called vs invalid payload) and the model's last text.
 */
export async function runResearch(opts: ResearchOptions): Promise<ResearchReport> {
  const first = await attempt(opts, opts.prompt);
  if (first.report) return first.report;

  const errors = first.called ? reportErrors(first.payload) : null;
  const note = errors
    ? `\n\nYour previous submit_findings call was invalid:\n- ${errors.join("\n- ")}\nFix those fields and call submit_findings once with a valid report.`
    : "\n\nYour previous reply did not call submit_findings. Call submit_findings once with a valid report ({ findings: [{ claim, source_url }] }).";
  const retry = await attempt(opts, `${opts.prompt}${note}`);
  if (retry.report) return retry.report;

  const emptyArgs =
    retry.called &&
    typeof retry.payload === "object" &&
    retry.payload !== null &&
    Object.keys(retry.payload as object).length === 0;
  const why = retry.called
    ? `submit_findings payload still invalid: ${(reportErrors(retry.payload) ?? []).join("; ")} (payload: ${sketch(retry.payload)})`
    : `the model finished without calling submit_findings; last output: ${JSON.stringify(retry.outputText.slice(0, 200))}`;
  throw new Error(
    `Research stage failed: ${why}${emptyArgs ? " — submit_findings arrived with empty arguments; your provider may be stripping tool-call arguments" : ""}`,
  );
}
