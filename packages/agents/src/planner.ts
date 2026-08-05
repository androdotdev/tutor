// Plan stage: turn the topic prompt (plus optional research findings) into a
// CourseOutline written to `.lyceum/outline.json` via write_file (Option A —
// file-based handoff, see .draft/course-builder-redesign.md). The stage reads
// + validates the file after the run; the outline then lands in the plan.json
// checkpoint through the same code path as before (bin.ts saveCoursePlan).
import { Agent } from "@earendil-works/pi-agent-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildAuthorTools } from "@tutor/core";
import { buildModel, buildStreamFn, type ProviderSelection } from "@tutor/llms";
import type { CourseOutline, ModuleDifficulty, PlannedModule, ResearchReport } from "./pipeline-types.ts";
import { attachPiBridge, lastAssistantText } from "./pi-events";
import { progressLogger } from "./progress";

export interface PlanOptions {
  provider: ProviderSelection;
  prompt: string;
  /** Course root; the outline lands at `<courseRoot>/.lyceum/outline.json`. */
  courseRoot: string;
  research?: ResearchReport | null;
  moduleCountOverride?: number;
  /** Stream the model's reasoning/text and log tool calls to stdout. */
  progress?: boolean;
}

const DIFFICULTIES = ["intro", "core", "capstone"] as const;
const OUTLINE_FILE = join(".lyceum", "outline.json");

/** Clamp a requested module count into the 2..8 range; null when unset. */
function clampedCount(count: number | undefined): number | null {
  if (!count) return null;
  return Math.max(2, Math.min(8, count));
}

/** Static role/rules for the planner; per-run data (topic, research) rides in the user turn. */
function buildPlanSystemPrompt(clamped: number | null): string {
  const base =
    "You are a curriculum designer. Design a self-learning course from the task you are given: 2 to 8 modules, difficulty ramping intro → core → capstone. Each module: a 2-digit id, a title, 3-6 concrete concepts (short phrases an authoring agent will teach), and a difficulty. Attach the relevant source urls to module.sources when research findings are provided. Write the complete outline to .lyceum/outline.json using the write_file tool — a JSON object { name, topic, modules: [{ id, title, concepts, difficulty, sources? }] }. It is the ONLY way to deliver your answer.";
  const cap = clamped !== null ? `\n\nThe course must have exactly ${clamped} modules.` : "";
  return base + cap;
}

/** The per-run task payload: topic (plus clarify recap) and research findings. */
function buildPlanInput(prompt: string, research?: ResearchReport | null): string {
  const base = `Topic: ${prompt}`;
  const researchBlock = research ? `\n\nResearch findings (cite these):\n${JSON.stringify(research)}` : "";
  return base + researchBlock;
}

/** Validation errors for an outline.json payload; null when valid. */
export function outlineErrors(input: unknown): string[] | null {
  if (typeof input !== "object" || input === null) {
    return ["outline.json content was not a JSON object"];
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

/** Shape guard for the outline.json payload. */
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

/** One fresh runtime + file attempt; null means "invalid outline, retry". */
async function runOutlineAttempt(
  provider: ProviderSelection,
  courseRoot: string,
  systemPrompt: string,
  input: string,
  clamped: number | null,
  progress?: boolean,
): Promise<{ outline: CourseOutline | null; payload: unknown; parseError: string | null; hadFile: boolean; outputText: string }> {
  const { write_file } = buildAuthorTools({ courseRoot, modules: [] });
  const agent = new Agent({
    streamFn: buildStreamFn(provider),
    initialState: {
      systemPrompt,
      model: buildModel(provider),
      thinkingLevel: "off",
      tools: [write_file],
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

  const { payload, parseError, hadFile } = await readStageFile(courseRoot, OUTLINE_FILE);
  let outline = parseOutline(payload);
  if (outline && clamped !== null && outline.modules.length !== clamped) outline = null;
  return { outline, payload, parseError, hadFile, outputText: lastAssistantText(agent) };
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
  return outlineErrors(payload) ?? [];
}

/** Module count inside a written file; 0 when not parseable. */
function outlineCount(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) return 0;
  const modules = (payload as Record<string, unknown>).modules;
  return Array.isArray(modules) ? modules.length : 0;
}

/** Run the plan stage: at most one retry before giving up on the outline. */
export async function planCourse(opts: PlanOptions): Promise<CourseOutline> {
  const clamped = clampedCount(opts.moduleCountOverride);
  const systemPrompt = buildPlanSystemPrompt(clamped);
  const input = buildPlanInput(opts.prompt, opts.research);

  const first = await runOutlineAttempt(opts.provider, opts.courseRoot, systemPrompt, input, clamped, opts.progress);
  if (first.outline) return first.outline;

  const firstErrors = fileErrors(first.payload, first.parseError);
  const clampNote =
    clamped !== null ? `\nThe course must have exactly ${clamped} modules (you wrote ${outlineCount(first.payload)}).` : "";
  const note = firstErrors.length
    ? `\n\nYour previous .lyceum/outline.json was invalid:\n- ${firstErrors.join("\n- ")}${clampNote}\nFix those fields and write the file again with a valid outline.`
    : `\n\nYour previous reply did not write .lyceum/outline.json. Write it once via write_file with a valid outline ({ name, topic, modules: [{ id, title, concepts, difficulty }] })${clampNote}`;
  const second = await runOutlineAttempt(opts.provider, opts.courseRoot, systemPrompt, `${input}${note}`, clamped, opts.progress);
  if (second.outline) return second.outline;

  const why = second.hadFile
    ? `outline.json is still invalid: ${fileErrors(second.payload, second.parseError).join("; ")} (file: ${sketch(second.payload)})`
    : `the model finished without writing .lyceum/outline.json; last output: ${JSON.stringify(second.outputText.slice(0, 200))}`;
  throw new Error(`Plan stage failed: ${why}`);
}
