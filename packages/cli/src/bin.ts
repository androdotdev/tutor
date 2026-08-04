#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveCourse, findModule, type ModuleDesc } from "@tutor/shared";
import { resolveProvider, type ProviderSelection } from "@tutor/llms";
import {
  buildCourse,
  createAuthorSession,
  loadCoursePlan,
  newCoursePlan,
  planCourse,
  runClarify,
  runResearch,
  saveCoursePlan,
  type BuildCourseResult,
  type ResearchReport,
} from "@tutor/agents";
import { addModule, buildAuthorTools, scaffoldCourse } from "@tutor/core";
import { findCourseRoot } from "./root";
import { loadUserConfig } from "./config";

const userConfig = loadUserConfig();

const ENV_HELP = `env:
  OPENAI_API_KEY / OPENAI_BASE_URL   (or OLLAMA_HOST)  — the coach's brain
  TUTOR_MODEL                       — model override
  LYCEUM_COURSE                     — course root override
config (~/.config/lyceum/, env vars win):
  config.json                       — provider {apiKey,baseUrl,model} + defaultCourse
  system-prompt.md                  — coaching instructions appended to the policy
  skills/*.md                       — skills loaded on demand (list_skills/get_skill)`;

/** A command failure with a specific process exit code. */
class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

async function loadCourse(): Promise<{ courseRoot: string; modules: ModuleDesc[] }> {
  // Precedence: LYCEUM_COURSE env > cwd discovery > XDG config defaultCourse.
  const courseRoot = process.env.LYCEUM_COURSE ?? findCourseRoot(process.cwd()) ?? userConfig.defaultCourse;
  if (!courseRoot) {
    throw new CliError("no course root found (no ./modules directory). Set LYCEUM_COURSE.");
  }
  const modules = await resolveCourse(courseRoot);
  return { courseRoot, modules };
}

async function launchTui(moduleArg?: string): Promise<void> {
  const { courseRoot, modules } = await loadCourse();
  if (!modules.length) throw new CliError(`no modules found in ${courseRoot}/modules`);
  let initial: ModuleDesc | undefined;
  const target = moduleArg?.trim();
  if (target) {
    const m = await findModule(modules, target);
    if (!m) throw new CliError(`no module matches "${target}"`);
    initial = m;
  }
  // Dynamic import keeps pi-tui (and its native terminal addon) out of the
  // headless commands (list/test/new/provider) and out of the tsup entry
  // graph; static import would pull the terminal stack into every invocation.
  const { runTui } = await import("./tui/main");
  await runTui(courseRoot, initial, userConfig);
}

const program = new Command("lyceum")
  .description("Socratic tutor & author for self-learning courses")
  .usage("[command] [options]")
  .addHelpText("after", `\n${ENV_HELP}`)
  .allowExcessArguments(true)
  .exitOverride();

// Bare `lyceum` opens the TUI, same as `lyceum run`. Tokens that match no
// subcommand land in program.args, so reject them as unknown commands
// (commander's default would say "too many arguments").
program.action(() => {
  if (program.args.length > 0) {
    throw new CliError(`unknown command "${String(program.args[0])}"`);
  }
  return launchTui();
});

/** Append mode: author ONE module by title (find-or-create). Old add/draft logic. */
async function authorSingleModule(courseRoot: string, title: string, provider: ProviderSelection): Promise<void> {
  let modules = await resolveCourse(courseRoot);
  let module = (await findModule(modules, title)) ?? null;
  if (!module) {
    const mod = await addModule(courseRoot, { title });
    modules = await resolveCourse(courseRoot);
    module = (await findModule(modules, mod.dir)) ?? null;
  }
  if (!module) throw new CliError(`could not resolve module "${title}"`);
  const session = createAuthorSession({ courseRoot, modules, module, provider });
  const written: string[] = [];
  session.subscribe((e) => {
    if (e.type === "tool-finished" && e.toolCall.toolName === "write_file") {
      for (const part of e.message.content) {
        if (part.type === "tool-result") {
          const out = part.output;
          if (typeof out === "string") written.push(out);
          else if (typeof out === "object" && out !== null && "path" in out) written.push(String(out.path));
        }
      }
    }
  });
  const task = `Author the module now. Title: "${module.title}". Module dir: ${module.dir}.
Follow the order in the policy: tests first, then exercise stub, then README, then run_tests to verify the grader loads. Finish with a summary of what the learner must implement.`;
  const result = await session.run(task);
  console.log("— authoring summary —");
  console.log(result);
  if (written.length) console.log(`Files written: ${written.length}`);
}

function printBuildSummary(result: BuildCourseResult, total: number): void {
  console.log(`${result.drafted}/${total} modules drafted`);
  for (const f of result.failed) console.log(`  failed: ${f.title} — ${f.error}`);
}

program
  .command("new")
  .description("generate a course from a prompt: clarify → research → plan → author every module")
  .argument("[prompt]", 'course description, e.g. "Express routing for beginners" (a module title in append mode)')
  .argument("[dir]", "course directory (default: current directory)")
  .option("--name <name>", "course display name (stub mode)")
  .option("--topic <topic>", "course topic (stub mode)")
  .option("--modules <n>", "override the module count (2-8)")
  .option("--yes", "skip clarifying questions")
  .option("--stub", "scaffold empty modules only (no LLM)")
  .option("--no-research", "skip the web research stage")
  .action(
    async (
      prompt: string | undefined,
      dir: string | undefined,
      opts: { name?: string; topic?: string; modules?: string; yes?: boolean; stub?: boolean; research?: boolean },
    ) => {
      const targetDir = dir ?? process.cwd();
      const moduleCount = opts.modules ? Number(opts.modules) : undefined;

      // --stub: deterministic scaffold, no LLM. A single positional is the dir
      // (today's `new <dir>` usage — kept working via this flag).
      if (opts.stub) {
        const stubDir = dir ?? prompt ?? process.cwd();
        const name =
          opts.name ?? basename(stubDir).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        const created = await scaffoldCourse(
          { name, topic: opts.topic, moduleCount: Number.isFinite(moduleCount ?? NaN) ? moduleCount : 3 },
          stubDir,
        );
        console.log(`course "${name}" scaffolded at ${stubDir}`);
        for (const m of created.modules) console.log(`  ${m.id}  ${m.title}`);
        console.log(`Open it:  LYCEUM_COURSE=${stubDir} lyceum`);
        return;
      }

      if (!prompt) {
        throw new CliError('new needs a course description — e.g. lyceum new "Express routing for beginners"');
      }
      const provider = resolveProvider(userConfig.provider);
      if (!provider) throw new CliError("new needs an LLM — set OPENAI_API_KEY or OLLAMA_HOST");

      // Resume: an existing checkpoint whose prompt matches re-runs the build
      // for modules still pending/failed (all-drafted = a no-op).
      const existingPlan = loadCoursePlan(targetDir);
      if (existingPlan && existingPlan.prompt === prompt) {
        const left = existingPlan.modules.filter((m) => m.status !== "drafted").length;
        console.log(`resuming ${targetDir} (${left} module(s) left)`);
        const result = await buildCourse({
          provider,
          courseRoot: targetDir,
          outline: existingPlan.outline,
          prompt,
          progress: true,
        });
        printBuildSummary(result, existingPlan.outline.modules.length);
        if (result.failed.length) throw new CliError(`${result.failed.length} module(s) failed — re-run lyceum new to resume`);
        return;
      }

      // Append mode: an existing modules/ dir + a title = author ONE module
      // (old `add`/`draft` semantics folded into `new`).
      if (existsSync(join(targetDir, "modules"))) {
        await authorSingleModule(targetDir, prompt, provider);
        return;
      }

      // 1. Clarify (--yes skips; the recap feeds the planner).
      let context = prompt;
      if (!opts.yes) {
        console.log("clarifying…");
        const { recap } = await runClarify({ provider, prompt, progress: true });
        context = `${prompt}\n\nClarified: ${recap}`;
      }

      // 2. Research: always runs (web_search is a required stage); --no-research
      // opts out for cheap/offline runs.
      let research: ResearchReport | null = null;
      if (opts.research !== false) {
        console.log("researching…");
        const { web_search } = buildAuthorTools({ courseRoot: targetDir, modules: [] });
        research = await runResearch({ provider, prompt: context, webSearchTool: web_search, progress: true });
      }

      // 3. Plan.
      console.log("planning…");
      const outline = await planCourse({
        provider,
        prompt: context,
        research,
        moduleCountOverride: moduleCount,
        progress: true,
      });
      saveCoursePlan(newCoursePlan(targetDir, prompt, outline));
      console.log(`planned ${outline.modules.length} modules: ${outline.modules.map((m) => m.title).join(", ")}`);

      // 4. Author every module (continue-on-error; resume via the checkpoint).
      console.log("authoring…");
      const result = await buildCourse({ provider, courseRoot: targetDir, outline, prompt, progress: true });
      printBuildSummary(result, outline.modules.length);
      if (result.failed.length) throw new CliError(`${result.failed.length} module(s) failed — re-run lyceum new to resume`);
      console.log(`Open it:  LYCEUM_COURSE=${targetDir} lyceum`);
    },
  );

program
  .command("run")
  .description("launch the Socratic TUI")
  .argument("[module]", "module id, directory, or title to open directly")
  .action((moduleArg?: string) => launchTui(moduleArg));

program
  .command("list")
  .description("list the course modules")
  .action(async () => {
    const { modules } = await loadCourse();
    for (const m of modules) {
      console.log(`${m.id}  ${m.title.padEnd(28)} ${m.layout}  ${m.moduleDir}`);
    }
  });

program
  .command("test")
  .description("run a module's tests (headless)")
  .argument("[module]", "module id, directory, or title; default: all modules")
  .action(async (moduleArg?: string) => {
    const { courseRoot, modules } = await loadCourse();
    const target = moduleArg?.trim();
    let sel: ModuleDesc[];
    if (target) {
      const m = await findModule(modules, target);
      sel = m ? [m] : [];
    } else {
      sel = modules;
    }
    if (!sel.length) throw new CliError(`no module matches "${target}"`);
    for (const m of sel) {
      if (!m.testTargets.length) {
        console.log(`${m.id} ${m.title}: no test targets`);
        continue;
      }
      console.log(`${m.id} ${m.title}`);
      const { code } = await run(courseRoot, "bun", ["test", ...m.testTargets]);
      if (code !== 0) throw new CliError(`tests failed for ${m.id}`, code);
    }
  });

program
  .command("provider")
  .description("show the resolved LLM provider")
  .action(() => {
    const p = resolveProvider(userConfig.provider);
    console.log(p ? `provider=${p.label} model=${p.modelId} base=${p.baseUrl}` : "none configured");
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync();
  } catch (err) {
    if (err instanceof CommanderError) {
      // commander writes its own error/help output before throwing, so only
      // the exit code needs to be set here. --help is a normal exit.
      process.exitCode = err.code === "commander.helpDisplayed" ? 0 : (err.exitCode ?? 1);
      return;
    }
    if (err instanceof CliError) {
      console.error(`lyceum: ${err.message}`);
      process.exitCode = err.exitCode;
      return;
    }
    console.error(`lyceum: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

void main();

interface RunResult {
  code: number;
  out: string;
}
function run(cwd: string, cmd: string, args: string[]): Promise<RunResult> {
  const { promise, resolve } = Promise.withResolvers<RunResult>();
  const child = spawn(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  child.on("close", (code) => resolve({ code: code ?? -1, out: "" }));
  child.on("error", (err) => resolve({ code: -1, out: err.message }));
  return promise;
}
