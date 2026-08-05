// Plan stage: turn the topic prompt (plus optional research findings) into a
// CourseOutline via a single forced-tool-call capture (`submit_outline`).
// Mirrors the author session's runtime wiring (see author.ts).
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { jsonResult, type PiAgentTool } from "@tutor/core";
import { buildModel, buildStreamFn, type ProviderSelection } from "@tutor/llms";
import type { CourseOutline, ModuleDifficulty, PlannedModule, ResearchReport } from "./pipeline-types.ts";
import { attachPiBridge, lastAssistantText } from "./pi-events";
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

/** Static role/rules for the planner; per-run data (topic, research) rides in the user turn. */
function buildPlanSystemPrompt(clamped: number | null): string {
  const base =
    "You are a curriculum designer. Design a self-learning course from the task you are given: 2 to 8 modules, difficulty ramping intro → core → capstone. Each module: a 2-digit id, a title, 3-6 concrete concepts (short phrases an authoring agent will teach), and a difficulty. Attach the relevant source urls to module.sources when research findings are provided. Call submit_outline ONCE with the complete outline — it is the only way to deliver your answer.";
  const cap = clamped !== null ? `\n\nThe course must have exactly ${clamped} modules.` : "";
  return base + cap;
}

/** The per-run task payload: topic (plus clarify recap) and research findings. */
function buildPlanInput(prompt: string, research?: ResearchReport | null): string {
  const base = `Topic: ${prompt}`;
  const researchBlock = research ? `\n\nResearch findings (cite these):\n${JSON.stringify(research)}` : "";
  return base + researchBlock;
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

/** The planner's only output channel; validated by the pi loop before execute. */
const submitOutlineParams = Type.Object({
  name: Type.String(),
  topic: Type.String(),
  modules: Type.Array(
    Type.Object({
      id: Type.String(),
      title: Type.String(),
      concepts: Type.Array(Type.String()),
      difficulty: Type.Union([Type.Literal("intro"), Type.Literal("core"), Type.Literal("capstone")]),
      sources: Type.Optional(Type.Array(Type.String())),
    }),
    { minItems: 2, maxItems: 8 },
  ),
});

/** One fresh runtime + capture attempt; null means "invalid outline, retry". */
async function runOutlineAttempt(
  provider: ProviderSelection,
  systemPrompt: string,
  input: string,
  clamped: number | null,
  progress?: boolean,
): Promise<{ outline: CourseOutline | null; called: boolean; payload: unknown; outputText: string }> {
  let captured: unknown = null;
  const submitOutlineTool: PiAgentTool<typeof submitOutlineParams> = {
    name: "submit_outline",
    label: "Submit the complete course outline",
    description: "Submit the complete course outline. The ONLY way to deliver your answer.",
    parameters: submitOutlineParams,
    execute: async (_toolCallId, params) => {
      captured = params;
      return { ...jsonResult({ ok: true }), terminate: true };
    },
  };

  const agent = new Agent({
    streamFn: buildStreamFn(provider),
    initialState: {
      systemPrompt,
      model: buildModel(provider),
      thinkingLevel: "off",
      tools: [submitOutlineTool],
    },
  });
  const bridge = attachPiBridge(agent, {
    maxIterations: 6,
    onEvent: progress ? progressLogger("plan") : undefined,
  });

  await agent.prompt(input);
  if (!bridge.capped()) {
    const error = agent.state.errorMessage;
    if (error) throw new Error(error ?? "Planner did not produce a valid course outline");
  }

  let outline = parseOutline(captured);
  if (outline && clamped !== null && outline.modules.length !== clamped) outline = null;
  return { outline, called: captured !== null, payload: captured, outputText: lastAssistantText(agent) };
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
  const clamped = clampedCount(opts.moduleCountOverride);
  const systemPrompt = buildPlanSystemPrompt(clamped);
  const input = buildPlanInput(opts.prompt, opts.research);

  const first = await runOutlineAttempt(opts.provider, systemPrompt, input, clamped, opts.progress);
  if (first.outline) return first.outline;

  const errors = first.called ? outlineErrors(first.payload) : null;
  const clampNote = clamped !== null ? `\nThe course must have exactly ${clamped} modules (you delivered ${outlineCount(first.payload)}).` : "";
  const note = errors
    ? `\n\nYour previous submit_outline call was invalid:\n- ${errors.join("\n- ")}${clampNote}\nFix those fields and call submit_outline once with a valid outline.`
    : `\n\nYour previous reply did not call submit_outline. Call submit_outline once with a valid outline ({ name, topic, modules: [{ id, title, concepts, difficulty }] })${clampNote}`;
  const second = await runOutlineAttempt(opts.provider, systemPrompt, `${input}${note}`, clamped, opts.progress);
  if (second.outline) return second.outline;

  const emptyArgs =
    second.called &&
    typeof second.payload === "object" &&
    second.payload !== null &&
    Object.keys(second.payload as object).length === 0;
  const why = second.called
    ? `submit_outline payload still invalid: ${(outlineErrors(second.payload) ?? ["module count mismatch"]).join("; ")} (payload: ${sketch(second.payload)})`
    : `the model finished without calling submit_outline; last output: ${JSON.stringify(second.outputText.slice(0, 200))}`;
  throw new Error(
    `Plan stage failed: ${why}${emptyArgs ? " — submit_outline arrived with empty arguments; your provider may be stripping tool-call arguments" : ""}`,
  );
}

/** Module count inside a captured payload; 0 when not parseable. */
function outlineCount(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) return 0;
  const modules = (payload as Record<string, unknown>).modules;
  return Array.isArray(modules) ? modules.length : 0;
}
