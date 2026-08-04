// Plan stage: turn the topic prompt (plus optional research findings) into a
// CourseOutline via a single forced-tool-call capture (`submit_outline`).
// Mirrors the author session's runtime wiring (see author.ts).
import { createAgentRuntime, type AgentRuntimeConfig } from "@cline/agents";
import { createTool, type AgentTool } from "@cline/shared";
import { buildModel, type ProviderSelection } from "@tutor/llms";
import type { CourseOutline, ModuleDifficulty, PlannedModule, ResearchReport } from "./pipeline-types.ts";
import { progressLogger } from "./progress";

export interface PlanOptions {
  provider: ProviderSelection;
  prompt: string;
  research?: ResearchReport | null;
  moduleCountOverride?: number;
  /** Stream the model's reasoning/text and log tool calls to stdout. */
  progress?: boolean;
}

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

/** Validation errors for a submit_outline payload; null when valid. */
export function outlineErrors(input: unknown): string[] | null {
  if (typeof input !== "object" || input === null) {
    return ["submit_outline arguments were not a JSON object"];
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof obj.name !== "string" || obj.name.length === 0) errors.push("name is missing or empty");
  if (typeof obj.topic !== "string" || obj.topic.length === 0) errors.push("topic is missing or empty");
  if (!Array.isArray(obj.modules)) {
    errors.push("modules is missing or not an array");
    return errors;
  }
  if (obj.modules.length < 2 || obj.modules.length > 8) {
    errors.push(`modules must be 2-8, got ${obj.modules.length}`);
  }
  obj.modules.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      errors.push(`modules[${i}] is not an object`);
      return;
    }
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string" || m.id.length === 0) errors.push(`modules[${i}].id is missing or empty`);
    if (typeof m.title !== "string" || m.title.length === 0) errors.push(`modules[${i}].title is missing or empty`);
    if (!Array.isArray(m.concepts) || m.concepts.length === 0) {
      errors.push(`modules[${i}].concepts is missing or empty`);
    } else {
      m.concepts.forEach((c, j) => {
        if (typeof c !== "string" || c.length === 0) errors.push(`modules[${i}].concepts[${j}] must be a non-empty string`);
      });
    }
    if (!DIFFICULTIES.includes(m.difficulty as ModuleDifficulty)) {
      errors.push(`modules[${i}].difficulty must be one of intro|core|capstone`);
    }
    if (m.sources !== undefined) {
      if (!Array.isArray(m.sources)) {
        errors.push(`modules[${i}].sources must be an array of strings`);
      } else {
        m.sources.forEach((s, j) => {
          if (typeof s !== "string") errors.push(`modules[${i}].sources[${j}] must be a string`);
        });
      }
    }
  });
  return errors.length ? errors : null;
}

/** Hand-rolled shape guard for the submit_outline payload. */
function parseOutline(input: unknown): CourseOutline | null {
  if (outlineErrors(input)) return null;
  const obj = input as Record<string, unknown>;

  const parsed: PlannedModule[] = [];
  for (const raw of obj.modules as unknown[]) {
    const m = raw as Record<string, unknown>;
    const module: PlannedModule = {
      id: m.id as string,
      title: m.title as string,
      concepts: m.concepts as string[],
      difficulty: m.difficulty as ModuleDifficulty,
    };
    if (m.sources !== undefined) module.sources = m.sources as string[];
    parsed.push(module);
  }

  return { name: obj.name as string, topic: obj.topic as string, modules: parsed };
}

/** One fresh runtime + capture attempt; null means "invalid outline, retry". */
async function runOutlineAttempt(
  provider: ProviderSelection,
  systemPrompt: string,
  input: string,
  clamped: number | null,
  progress?: boolean,
): Promise<{ outline: CourseOutline | null; called: boolean; payload: unknown; outputText: string }> {
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
    hooks: progress ? { onEvent: progressLogger("plan") } : undefined,
  } satisfies AgentRuntimeConfig);

  const result = await runtime.run(input);
  if (result.status === "failed") {
    throw new Error("Planner did not produce a valid course outline");
  }

  let outline = parseOutline(captured);
  if (outline && clamped !== null && outline.modules.length !== clamped) outline = null;
  return { outline, called: captured !== null, payload: captured, outputText: result.outputText };
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

/** Run the plan stage: at most one retry before giving up on the outline. */
export async function planCourse(opts: PlanOptions): Promise<CourseOutline> {
  const systemPrompt = buildPlanSystemPrompt(opts);
  const clamped = clampedCount(opts.moduleCountOverride);

  const first = await runOutlineAttempt(opts.provider, systemPrompt, opts.prompt, clamped, opts.progress);
  if (first.outline) return first.outline;

  const errors = first.called ? outlineErrors(first.payload) : null;
  const clampNote = clamped !== null ? `\nThe course must have exactly ${clamped} modules (you delivered ${outlineCount(first.payload)}).` : "";
  const note = errors
    ? `\n\nYour previous submit_outline call was invalid:\n- ${errors.join("\n- ")}${clampNote}\nFix those fields and call submit_outline once with a valid outline.`
    : `\n\nYour previous reply did not call submit_outline. Call submit_outline once with a valid outline ({ name, topic, modules: [{ id, title, concepts, difficulty }] })${clampNote}`;
  const second = await runOutlineAttempt(opts.provider, systemPrompt, `${opts.prompt}${note}`, clamped, opts.progress);
  if (second.outline) return second.outline;

  const why = second.called
    ? `submit_outline payload still invalid: ${(outlineErrors(second.payload) ?? ["module count mismatch"]).join("; ")} (payload: ${sketch(second.payload)})`
    : `the model finished without calling submit_outline; last output: ${JSON.stringify(second.outputText.slice(0, 200))}`;
  throw new Error(`Plan stage failed: ${why}`);
}

/** Module count inside a captured payload; 0 when not parseable. */
function outlineCount(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) return 0;
  const modules = (payload as Record<string, unknown>).modules;
  return Array.isArray(modules) ? modules.length : 0;
}
