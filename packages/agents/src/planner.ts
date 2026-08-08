// Plan stage: turn the topic prompt (plus optional research findings) into a
// CourseOutline delivered MODULE BY MODULE — `.lyceum/outline.json` holds only
// { name, topic }, and each module is its own `.lyceum/modules/<id>.json`
// (Option A file-based handoff, see .draft/course-builder-redesign.md).
//
// Why module-wise: a single giant outline JSON in one write_file call is the
// failure mode the models actually hit — they over-think, never emit the blob,
// and dump the whole outline as their final TEXT instead. Per-module files are
// small (each write succeeds), partial progress survives a retry, and the stage
// also accepts a complete outline delivered as text (parsed + persisted
// stage-side) so "I planned it but didn't write the file" still lands.
import { Agent } from "@earendil-works/pi-agent-core";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildAuthorTools } from "@tutor/core";
import { buildModel, buildStreamFn, type ProviderSelection } from "@tutor/llms";
import type { CourseOutline, ModuleDifficulty, PlannedModule, ResearchReport } from "./pipeline-types.ts";
import { attachPiBridge, lastAssistantText, type TutorRuntimeEvent } from "./pi-events";
import { stageSink, wireAbort } from "./progress";

export interface PlanOptions {
  provider: ProviderSelection;
  prompt: string;
  /** Course root; the outline lands at `<courseRoot>/.lyceum/`. */
  courseRoot: string;
  research?: ResearchReport | null;
  moduleCountOverride?: number;
  /** Stream the model's reasoning/text and log tool calls to stdout. */
  progress?: boolean;
  /** Append the full stream to this file (lyceum new --log). */
  logFile?: string;
  /** Abort the in-flight plan run (Esc in the TUI). */
  abort?: AbortSignal;
  /** Extra app-facing listener alongside the stage sink (TUI transcript). */
  onEvent?: (event: TutorRuntimeEvent) => void;
}

const DIFFICULTIES = ["intro", "core", "capstone"] as const;
const OUTLINE_FILE = join(".lyceum", "outline.json");
const MODULES_DIR = join(".lyceum", "modules");

/** Clamp a requested module count into the 2..8 range; null when unset. */
function clampedCount(count: number | undefined): number | null {
  if (!count) return null;
  return Math.max(2, Math.min(8, count));
}

/** Static role/rules for the planner; per-run data (topic, research) rides in the user turn. */
function buildPlanSystemPrompt(clamped: number | null): string {
  const base = [
    "You are a curriculum designer. Design a self-learning course from the task you are given: 2 to 8 modules, difficulty ramping intro → core → capstone.",
    "",
    "Deliver the plan MODULE BY MODULE with the write_file tool — never one big file, never in your final text:",
    "1. First write .lyceum/outline.json = { name, topic } — the course name and topic only.",
    "2. Then write ONE file per module: .lyceum/modules/<id>.json = { id, title, concepts, difficulty, sources? },",
    "   where id is a 2-digit number (01, 02, ...), title is a short phrase, concepts are 3-6 short phrases",
    "   an authoring agent will teach, difficulty is one of intro|core|capstone, and sources lists the",
    "   relevant urls from the research findings when provided.",
    "3. Continue until every module of the course has its own file under .lyceum/modules/.",
    "",
    "Ordering: the id IS the teaching sequence — 01 is the first lesson. Decide the order before",
    "numbering: each module must build only on knowledge from earlier modules, so prerequisites",
    "come first (e.g. a networking refresher precedes any module that assumes networking).",
    "Difficulty ramps intro → core → capstone across that order: no core module before an intro one,",
    "no capstone before a core one.",
    "",
    "The plan is only complete once all module files exist on disk.",
  ].join("\n");
  const cap = clamped !== null ? `\n\nThe course must have exactly ${clamped} modules.` : "";
  return base + cap;
}

/** The per-run task payload: topic (plus clarify recap) and research findings. */
function buildPlanInput(prompt: string, research?: ResearchReport | null): string {
  const base = `Topic: ${prompt}`;
  const researchBlock = research ? `\n\nResearch findings (cite these):\n${JSON.stringify(research)}` : "";
  return base + researchBlock;
}

/** Validation errors for the { name, topic } metadata payload; null when valid. */
function metaErrors(input: unknown): string[] | null {
  if (typeof input !== "object" || input === null) return ["outline.json content was not a JSON object"];
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof obj.name !== "string" || obj.name.length === 0) errors.push("outline.json: name is missing or empty");
  if (typeof obj.topic !== "string" || obj.topic.length === 0) errors.push("outline.json: topic is missing or empty");
  return errors.length ? errors : null;
}

/** Validation errors for ONE module file payload; null when valid. */
export function moduleErrors(input: unknown): string[] | null {
  if (typeof input !== "object" || input === null) return ["not a JSON object"];
  const m = input as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof m.id !== "string" || !/^\d{2}$/.test(m.id)) errors.push("id must be a 2-digit string like \"01\"");
  if (typeof m.title !== "string" || m.title.length === 0) errors.push("title is missing or empty");
  if (!Array.isArray(m.concepts) || m.concepts.length === 0) {
    errors.push("concepts is missing or empty");
  } else {
    m.concepts.forEach((c, j) => {
      if (typeof c !== "string" || c.length === 0) errors.push(`concepts[${j}] must be a non-empty string`);
    });
  }
  if (!DIFFICULTIES.includes(m.difficulty as ModuleDifficulty)) {
    errors.push(`difficulty must be one of ${DIFFICULTIES.join("|")}`);
  }
  if (m.sources !== undefined) {
    if (!Array.isArray(m.sources)) {
      errors.push("sources must be an array of strings");
    } else {
      m.sources.forEach((s, j) => {
        if (typeof s !== "string") errors.push(`sources[${j}] must be a string`);
      });
    }
  }
  return errors.length ? errors : null;
}

/** Validation errors for an assembled full outline; null when valid. */
export function outlineErrors(input: unknown): string[] | null {
  const meta = metaErrors(input);
  if (meta) return meta;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.modules)) return ["modules is missing or not an array"];
  const errors: string[] = [];
  if (obj.modules.length < 2 || obj.modules.length > 8) {
    errors.push(`modules must be 2-8, got ${obj.modules.length}`);
  }
  obj.modules.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      errors.push(`modules[${i}] is not an object`);
      return;
    }
    const me = moduleErrors(raw);
    if (me) me.forEach((e) => errors.push(`modules[${i}].${e}`));
  });
  return errors.length ? errors : null;
}

/** Shape guard for an assembled outline payload. */
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

/** Read + parse a single stage file; distinguish missing vs unreadable vs invalid JSON. */
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

/**
 * Assemble the outline from the on-disk stage files: outline.json metadata +
 * every valid module file under .lyceum/modules/. Returns the outline when
 * the metadata AND at least the count range (2-8) validate; the caller applies
 * the clamp on top. `errors` carries every problem found for retry notes.
 */
async function assembleOutline(
  courseRoot: string,
  clamped: number | null,
): Promise<{ outline: CourseOutline | null; errors: string[]; present: string[] }> {
  const errors: string[] = [];
  const meta = await readStageFile(courseRoot, OUTLINE_FILE);
  if (!meta.hadFile) {
    errors.push("outline.json was not written (write { name, topic } first)");
  } else if (meta.parseError) {
    errors.push(`outline.json: ${meta.parseError}`);
  } else {
    const me = metaErrors(meta.payload);
    if (me) errors.push(...me);
  }

  const present: string[] = [];
  const modules: PlannedModule[] = [];
  const seen = new Set<string>();
  let moduleFiles: string[] = [];
  try {
    moduleFiles = await readDirNames(join(courseRoot, MODULES_DIR));
  } catch {
    errors.push(`${MODULES_DIR} was not created — write at least one module file`);
  }
  for (const name of moduleFiles.sort()) {
    if (!name.endsWith(".json")) continue;
    const file = join(MODULES_DIR, name);
    const raw = await readStageFile(courseRoot, file);
    if (!raw.hadFile) continue;
    if (raw.parseError) {
      errors.push(`${file}: ${raw.parseError}`);
      continue;
    }
    const me = moduleErrors(raw.payload);
    if (me) {
      errors.push(`${file}: ${me.join("; ")}`);
      continue;
    }
    const m = raw.payload as PlannedModule;
    if (seen.has(m.id)) {
      errors.push(`${file}: duplicate module id "${m.id}"`);
      continue;
    }
    seen.add(m.id);
    present.push(m.id);
    modules.push(m);
  }
  present.sort();

  const countNote =
    modules.length < 2 || modules.length > 8
      ? `module count must be 2-8, wrote ${modules.length}`
      : null;
  if (countNote) errors.push(countNote);
  if (clamped !== null && modules.length !== clamped) {
    errors.push(`the course must have exactly ${clamped} modules, wrote ${modules.length}`);
  }

  if (!meta.hadFile || meta.parseError || metaErrors(meta.payload)) return { outline: null, errors, present };
  if (errors.some((e) => e.startsWith("module count") || e.startsWith("the course must have"))) {
    return { outline: null, errors, present };
  }
  if (modules.length < 2) return { outline: null, errors, present };
  modules.sort((a, b) => a.id.localeCompare(b.id));
  const metaObj = meta.payload as Record<string, unknown>;
  return {
    outline: { name: metaObj.name as string, topic: metaObj.topic as string, modules },
    errors,
    present,
  };
}

async function readDirNames(dir: string): Promise<string[]> {
  return readdir(dir);
}

/** Fresh stage: a stale outline/module set from a previous run must not assemble. */
async function clearStageFiles(courseRoot: string): Promise<void> {
  await rm(join(courseRoot, MODULES_DIR), { recursive: true, force: true });
  await rm(join(courseRoot, OUTLINE_FILE), { force: true });
}

/** Persist an accepted outline to the stage files (used by the text fallback). */
async function persistStageOutline(courseRoot: string, outline: CourseOutline): Promise<void> {
  await mkdir(join(courseRoot, MODULES_DIR), { recursive: true });
  await writeFile(join(courseRoot, OUTLINE_FILE), JSON.stringify({ name: outline.name, topic: outline.topic }), "utf8");
  for (const m of outline.modules) {
    await writeFile(join(courseRoot, MODULES_DIR, `${m.id}.json`), JSON.stringify(m), "utf8");
  }
}

/**
 * Rescue a model that planned but never wrote the files: extract a complete
 * valid outline JSON from its final text (fenced block first, then a balanced
 * brace scan) and persist it stage-side. Null when the text has no outline.
 */
function extractOutlineFromText(text: string): CourseOutline | null {
  if (!text) return null;
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let hit: RegExpExecArray | null;
  while ((hit = fence.exec(text)) !== null) candidates.push(hit[1]);
  // Longest balanced-brace JSON object in the text (the outline usually comes
  // last and is the largest structure).
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const c of candidates.sort((a, b) => b.length - a.length)) {
    try {
      const outline = parseOutline(JSON.parse(c) as unknown);
      if (outline) return outline;
    } catch {
      /* not JSON — try the next candidate */
    }
  }
  return null;
}

/** One fresh runtime + file attempt; null means "invalid outline, retry". */
async function runOutlineAttempt(
  provider: ProviderSelection,
  courseRoot: string,
  systemPrompt: string,
  input: string,
  clamped: number | null,
  progress?: boolean,
  logFile?: string,
  abort?: AbortSignal,
  onEvent?: (event: TutorRuntimeEvent) => void,
): Promise<{ outline: CourseOutline | null; errors: string[]; present: string[]; outputText: string }> {
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
    // meta + one file per module (up to 8) + final reply; a cap here would
    // silently truncate a full 8-module plan.
    maxIterations: 16,
    onEvent: stageSink("plan", { progress, logFile, onEvent }),
  });

  const unwire = wireAbort(agent, abort);
  try {
    await agent.prompt(input);
  } finally {
    unwire();
  }
  if (!bridge.capped()) {
    const error = agent.state.errorMessage;
    if (error) throw new Error(error ?? "Planner did not produce a valid course outline");
  }

  const assembled = await assembleOutline(courseRoot, clamped);
  return { ...assembled, outputText: lastAssistantText(agent) };
}

/** A one-line sketch of the current stage state for the final CLI error. */
function sketchState(present: string[], errors: string[], outputText: string): string {
  const nothingWritten =
    present.length === 0 &&
    errors.every(
      (e) =>
        e.startsWith("outline.json was not written") ||
        e.startsWith(".lyceum/modules was not created") ||
        e.startsWith("module count"),
    );
  if (nothingWritten) {
    return `the model finished without writing .lyceum/outline.json or any module files; last output: ${JSON.stringify(outputText.slice(0, 200))}`;
  }
  const parts: string[] = [];
  if (present.length) parts.push(`module files present: ${present.join(", ")}`);
  if (errors.length) parts.push(errors.join("; "));
  parts.push(`last output: ${JSON.stringify(outputText.slice(0, 200))}`);
  return parts.join(" | ");
}

/** Run the plan stage: at most one retry, then a text-outline rescue, then give up. */
async function runPlanStage(opts: PlanOptions): Promise<CourseOutline> {
  const clamped = clampedCount(opts.moduleCountOverride);
  const systemPrompt = buildPlanSystemPrompt(clamped);
  const input = buildPlanInput(opts.prompt, opts.research);
  await clearStageFiles(opts.courseRoot);

  const first = await runOutlineAttempt(opts.provider, opts.courseRoot, systemPrompt, input, clamped, opts.progress, opts.logFile, opts.abort, opts.onEvent);
  if (first.outline) return first.outline;

  // The model planned in prose instead of files: accept a complete outline from
  // its text immediately — no point forcing a retry it has already refused.
  const firstTextOutline = first.present.length === 0 ? extractOutlineFromText(first.outputText) : null;
  if (firstTextOutline) {
    await persistStageOutline(opts.courseRoot, firstTextOutline);
    return firstTextOutline;
  }

  const note = [
    "\n\nYour previous reply did not produce a valid module-wise plan:",
    ...(first.errors.length ? first.errors.map((e) => `- ${e}`) : ["- nothing was written"]),
    first.present.length
      ? `\nModule files already on disk: ${first.present.join(", ")} — keep them, write the missing module files and fix the invalid ones.`
      : "\nWrite .lyceum/outline.json ({ name, topic }) and then one .lyceum/modules/<id>.json per module, using the write_file tool.",
  ].join("\n");
  const second = await runOutlineAttempt(opts.provider, opts.courseRoot, systemPrompt, `${input}${note}`, clamped, opts.progress, opts.logFile, opts.abort, opts.onEvent);
  if (second.outline) return second.outline;

  const textOutline = extractOutlineFromText(second.outputText) ?? (second.present.length === 0 ? extractOutlineFromText(first.outputText) : null);
  if (textOutline) {
    await persistStageOutline(opts.courseRoot, textOutline);
    return textOutline;
  }

  throw new Error(`Plan stage failed: ${sketchState(second.present, second.errors, second.outputText)}`);
}

/**
 * Run the plan stage, then drop the per-module transport files. The assembled
 * outline now lives in `outline.json` and the caller's `plan.json` checkpoint;
 * `.lyceum/modules/` was delivery, not state — research.json, outline.json and
 * plan.json are the final `.lyceum` contents.
 */
export async function planCourse(opts: PlanOptions): Promise<CourseOutline> {
  const outline = await runPlanStage(opts);
  await rm(join(opts.courseRoot, MODULES_DIR), { recursive: true, force: true });
  return outline;
}
