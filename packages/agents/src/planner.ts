// Plan stage: turn the topic prompt (plus optional research findings) into a
// CourseOutline via a single forced-tool-call capture (`submit_outline`).
// Mirrors the author session's runtime wiring (see author.ts).
import { createAgentRuntime, type AgentRuntimeConfig } from "@cline/agents";
import { createTool, type AgentTool } from "@cline/shared";
import { buildModel, type ProviderSelection } from "@tutor/llms";
import type { CourseOutline, ModuleDifficulty, PlannedModule, ResearchReport } from "./pipeline-types.ts";

export interface PlanOptions {
  provider: ProviderSelection;
  prompt: string;
  research?: ResearchReport | null;
  moduleCountOverride?: number;
}

/** Appended when the first attempt produced no valid submit_outline call. */
const RETRY_PROMPT =
  "\n\nYour previous reply did not produce a valid submit_outline call (modules must be 2-8). Call submit_outline once with a valid outline now.";

const DIFFICULTIES = ["intro", "core", "capstone"] as const;

/** Clamp a requested module count into the 2..8 range; null when unset. */
function clampedCount(count: number | undefined): number | null {
  if (!count) return null;
  return Math.max(2, Math.min(8, count));
}

function buildPlanSystemPrompt(opts: PlanOptions): string {
  const base =
    "You are a curriculum designer. Design a self-learning course for the topic below. 2 to 8 modules, difficulty ramping intro → core → capstone. Each module: a 2-digit id, a title, 3-6 concrete concepts (short phrases an authoring agent will teach), and a difficulty. When research findings are provided, attach the relevant source urls to module.sources. Call submit_outline ONCE with the complete outline — it is the only way to deliver your answer.\n\nTopic: " +
    opts.prompt;
  const research = opts.research ? `\n\nResearch findings (cite these):\n${JSON.stringify(opts.research)}` : "";
  const clamped = clampedCount(opts.moduleCountOverride);
  const cap = clamped !== null ? `\n\nThe course must have exactly ${clamped} modules.` : "";
  return base + research + cap;
}

/** Hand-rolled shape guard for the submit_outline payload. */
function parseOutline(input: unknown): CourseOutline | null {
  if (typeof input !== "object" || input === null) return null;
  const obj = input as Record<string, unknown>;
  const name = obj.name;
  const topic = obj.topic;
  const modules = obj.modules;
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof topic !== "string" || topic.length === 0) return null;
  // 2..8 modules is a hard cap: anything outside is rejected outright.
  if (!Array.isArray(modules) || modules.length < 2 || modules.length > 8) return null;

  const parsed: PlannedModule[] = [];
  for (const raw of modules) {
    if (typeof raw !== "object" || raw === null) return null;
    const m = raw as Record<string, unknown>;
    const id = m.id;
    const title = m.title;
    const concepts = m.concepts;
    const difficulty = m.difficulty;
    const sources = m.sources;

    if (typeof id !== "string" || id.length === 0) return null;
    if (typeof title !== "string" || title.length === 0) return null;
    if (!Array.isArray(concepts) || concepts.length === 0) return null;
    for (const c of concepts) {
      if (typeof c !== "string" || c.length === 0) return null;
    }
    if (!DIFFICULTIES.includes(difficulty as ModuleDifficulty)) return null;
    if (sources !== undefined) {
      if (!Array.isArray(sources)) return null;
      for (const s of sources) {
        if (typeof s !== "string") return null;
      }
    }

    const module: PlannedModule = {
      id,
      title,
      concepts: concepts as string[],
      difficulty: difficulty as ModuleDifficulty,
    };
    if (sources !== undefined) module.sources = sources as string[];
    parsed.push(module);
  }

  return { name, topic, modules: parsed };
}

/** One fresh runtime + capture attempt; null means "invalid outline, retry". */
async function runOutlineAttempt(
  provider: ProviderSelection,
  systemPrompt: string,
  input: string,
  clamped: number | null,
): Promise<CourseOutline | null> {
  let captured: unknown = null;
  const submitOutlineTool: AgentTool = createTool({
    name: "submit_outline",
    description: "Submit the complete course outline. The ONLY way to deliver your answer.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        topic: { type: "string" },
        modules: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              concepts: { type: "array", items: { type: "string" } },
              difficulty: { type: "string", enum: ["intro", "core", "capstone"] },
              sources: { type: "array", items: { type: "string" } },
            },
            required: ["id", "title", "concepts", "difficulty"],
          },
        },
      },
      required: ["name", "topic", "modules"],
    },
    execute: async (input: unknown) => {
      captured = input;
      return { ok: true };
    },
  });

  const runtime = createAgentRuntime({
    model: buildModel(provider),
    systemPrompt,
    tools: [submitOutlineTool],
    maxIterations: 6,
  } satisfies AgentRuntimeConfig);

  const result = await runtime.run(input);
  if (result.status === "failed") {
    throw new Error("Planner did not produce a valid course outline");
  }

  const outline = parseOutline(captured);
  if (!outline) return null;
  if (clamped !== null && outline.modules.length !== clamped) return null;
  return outline;
}

/** Run the plan stage: at most one retry before giving up on the outline. */
export async function planCourse(opts: PlanOptions): Promise<CourseOutline> {
  const systemPrompt = buildPlanSystemPrompt(opts);
  const clamped = clampedCount(opts.moduleCountOverride);

  const first = await runOutlineAttempt(opts.provider, systemPrompt, opts.prompt, clamped);
  if (first) return first;

  const second = await runOutlineAttempt(opts.provider, systemPrompt, opts.prompt + RETRY_PROMPT, clamped);
  if (second) return second;

  throw new Error("Planner did not produce a valid course outline");
}
