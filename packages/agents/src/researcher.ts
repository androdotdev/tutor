import { createAgentRuntime, type AgentRuntimeConfig } from "@cline/agents";
import { createTool, type AgentTool } from "@cline/shared";
import { buildModel, type ProviderSelection } from "@tutor/llms";
import type { ResearchFinding, ResearchReport } from "./pipeline-types";
import { progressLogger } from "./progress";

export interface ResearchOptions {
  provider: ProviderSelection;
  prompt: string;
  webSearchTool: AgentTool<{ query: string }, unknown>;
  /** Stream the model's reasoning/text and log tool calls to stdout. */
  progress?: boolean;
}

const MAX_RESEARCH_ITERATIONS = 12;

function buildResearchPrompt(topic: string): string {
  return [
    `You are a research assistant for course authoring. Topic: ${topic}.`,
    "Use the web_search tool to gather CURRENT, sourced facts (official docs, best practices, current API shapes).",
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
 * The researcher's only output channel: stashes the model's arguments in a
 * closure so the stage can read them after the run; `{ ok: true }` lets the
 * agent loop finish normally.
 */
function createSubmitFindingsTool(): { tool: AgentTool; captured: () => unknown } {
  let captured: unknown;
  const tool = createTool({
    name: "submit_findings",
    description: "Submit the research report. The ONLY way to deliver your findings.",
    inputSchema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim: { type: "string" },
              source_url: { type: "string" },
              note: { type: "string" },
            },
            required: ["claim", "source_url"],
          },
        },
        caveats: { type: "string" },
      },
      required: ["findings"],
    },
    execute: async (input: unknown) => {
      captured = input;
      return { ok: true };
    },
  });
  return { tool, captured: () => captured };
}

/** One full agent run; resolves to the capture outcome after the run. */
async function attempt(
  opts: ResearchOptions,
  prompt: string,
): Promise<{ report: ResearchReport | null; called: boolean; payload: unknown; outputText: string }> {
  const { tool: submitFindingsTool, captured } = createSubmitFindingsTool();
  const runtime = createAgentRuntime({
    model: buildModel(opts.provider),
    systemPrompt: buildResearchPrompt(opts.prompt),
    tools: [opts.webSearchTool, submitFindingsTool],
    maxIterations: MAX_RESEARCH_ITERATIONS,
    hooks: opts.progress ? { onEvent: progressLogger("research") } : undefined,
  } satisfies AgentRuntimeConfig);

  const result = await runtime.run(prompt);
  if (result.status === "failed") {
    throw new Error(result.error?.message ?? "research run failed");
  }
  const payload = captured();
  return {
    report: parseReport(payload),
    called: payload !== undefined,
    payload,
    outputText: result.outputText,
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

  const why = retry.called
    ? `submit_findings payload still invalid: ${(reportErrors(retry.payload) ?? []).join("; ")} (payload: ${sketch(retry.payload)})`
    : `the model finished without calling submit_findings; last output: ${JSON.stringify(retry.outputText.slice(0, 200))}`;
  throw new Error(`Research stage failed: ${why}`);
}
