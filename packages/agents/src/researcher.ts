import { createAgentRuntime, type AgentRuntimeConfig } from "@cline/agents";
import { createTool, type AgentTool } from "@cline/shared";
import { buildModel, type ProviderSelection } from "@tutor/llms";
import type { ResearchFinding, ResearchReport } from "./pipeline-types";

export interface ResearchOptions {
  provider: ProviderSelection;
  prompt: string;
  webSearchTool: AgentTool<{ query: string }, unknown>;
}

const MAX_RESEARCH_ITERATIONS = 12;
const RETRY_NOTE =
  "\n\nYour previous reply did not produce a valid submit_findings call. Call submit_findings once with a valid report now.";

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
 * Hand-rolled shape guard for the researcher's forced tool-call payload.
 * `findings` must be an array of objects each with a non-empty string `claim`
 * and a string `source_url` (optional string `note`); `caveats` is an optional
 * string. An empty findings array is valid. Anything else -> null.
 */
export function parseReport(input: unknown): ResearchReport | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.findings)) return null;

  const findings: ResearchFinding[] = [];
  for (const item of record.findings) {
    if (typeof item !== "object" || item === null) return null;
    const finding = item as Record<string, unknown>;
    if (typeof finding.claim !== "string" || finding.claim.trim() === "") return null;
    if (typeof finding.source_url !== "string") return null;
    if (finding.note !== undefined && typeof finding.note !== "string") return null;
    const parsed: ResearchFinding = { claim: finding.claim, source_url: finding.source_url };
    if (typeof finding.note === "string") parsed.note = finding.note;
    findings.push(parsed);
  }

  const report: ResearchReport = { findings };
  if (record.caveats !== undefined) {
    if (typeof record.caveats !== "string") return null;
    report.caveats = record.caveats;
  }
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

/** One full agent run; resolves to a parsed report or null when the model
 *  finished without a valid submit_findings call. A failed run throws. */
async function attempt(opts: ResearchOptions, prompt: string): Promise<ResearchReport | null> {
  const { tool: submitFindingsTool, captured } = createSubmitFindingsTool();
  const runtime = createAgentRuntime({
    model: buildModel(opts.provider),
    systemPrompt: buildResearchPrompt(opts.prompt),
    tools: [opts.webSearchTool, submitFindingsTool],
    maxIterations: MAX_RESEARCH_ITERATIONS,
  } satisfies AgentRuntimeConfig);

  const result = await runtime.run(prompt);
  if (result.status === "failed") {
    throw new Error(result.error?.message ?? "research run failed");
  }
  return parseReport(captured());
}

/**
 * Runs the research stage: gathers sourced facts about the topic and returns
 * them as a validated ResearchReport. Retries ONCE with a corrective prompt
 * when the model does not deliver a valid submit_findings call.
 */
export async function runResearch(opts: ResearchOptions): Promise<ResearchReport> {
  const first = await attempt(opts, opts.prompt);
  if (first) return first;

  const retry = await attempt(opts, `${opts.prompt}${RETRY_NOTE}`);
  if (retry) return retry;

  throw new Error("Researcher did not produce a valid findings report");
}
