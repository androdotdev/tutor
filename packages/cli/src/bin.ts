#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveCourse, findModule, type ModuleDesc } from "@tutor/shared";
import { resolveProvider, type ProviderSelection } from "@tutor/llms";
import {
  buildCourse,
  createAuthorSession,
  fileLogger,
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
import { runSetup } from "./setup";

const userConfig = loadUserConfig();

// Read at runtime (not bundled): ../package.json is the package root both in
// the repo (packages/cli/) and in the installed npm package (dist/).
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

const ENV_HELP = `env:
  OPENAI_API_KEY / OPENAI_BASE_URL   (or OLLAMA_HOST)  — the coach's brain
  TUTOR_MODEL                       — model override
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
  // Precedence: cwd discovery (walk-up for a modules/ dir) > XDG config defaultCourse.
  const courseRoot = findCourseRoot(process.cwd()) ?? userConfig.defaultCourse;
  if (!courseRoot) {
    throw new CliError("no course root found (no ./modules directory). cd into the course or set defaultCourse in config.");
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
async function authorSingleModule(
  courseRoot: string,
  title: string,
  provider: ProviderSelection,
  logFile?: string,
): Promise<void> {
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
    if (e.type === "tool-finished" && e.toolName === "write_file" && !e.isError) {
      const details = (e.result as { details?: unknown } | null)?.details;
      if (typeof details === "object" && details !== null && "path" in details) {
        written.push(String((details as { path: unknown }).path));
      }
    }
  });
  if (logFile) session.subscribe(fileLogger(logFile));
  const task = `Author the module now. Title: "${module.title}". Module dir: ${module.dir}.
Follow the order in the policy: tests first, then exercise stub, then README, then run_tests to verify the grader loads. Finish with a summary of what the learner must implement.`;
  console.log(`authoring ${module.dir}…`);
  console.log("waiting for model…");
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
  .description("generate a course from a course name: clarify → research → plan → author every module")
  .argument("[course...]", "course name — every word is the name, no quotes needed, e.g. make a docker course (a module title in append mode)")
  .option("--dir <path>", "course directory (default: current directory)")
  .option("--name <name>", "course display name (stub mode)")
  .option("--topic <topic>", "course topic (stub mode)")
  .option("--modules <n>", "override the module count (2-8)")
  .option("--yes", "skip clarifying questions")
  .option("--stub", "scaffold empty modules only (no LLM)")
  .option("--no-research", "skip the web research stage")
  .option("--log", "capture the full model stream to .lyceum/new.log (dev/testing)")
  .action(
    async (
      promptArgs: string[] | undefined,
      opts: { dir?: string; name?: string; topic?: string; modules?: string; yes?: boolean; stub?: boolean; research?: boolean; log?: boolean },
    ) => {
      // Variadic positionals are joined into ONE prompt: `lyceum new make a
      // docker course` must not become prompt="make", dir="a" with the rest
      // swallowed (the old two-positional form did exactly that).
      const prompt = (promptArgs ?? []).join(" ");
      const targetDir = opts.dir ?? process.cwd();
      const moduleCount = opts.modules ? Number(opts.modules) : undefined;

      // --log: fresh .lyceum/new.log per run, appended by every stage.
      const logFile = opts.log ? openLogFile(targetDir) : undefined;

      // --stub: deterministic scaffold, no LLM. Course directory is --dir (or
      // cwd); a positional is the prompt and is ignored here.
      if (opts.stub) {
        const name =
          opts.name ?? basename(targetDir).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        const created = await scaffoldCourse(
          { name, topic: opts.topic, moduleCount: Number.isFinite(moduleCount ?? NaN) ? moduleCount : 3 },
          targetDir,
        );
        console.log(`course "${name}" scaffolded at ${targetDir}`);
        for (const m of created.modules) console.log(`  ${m.id}  ${m.title}`);
        console.log(`Open it:  cd ${targetDir} && lyceum`);
        return;
      }

      if (!prompt) {
        throw new CliError("new needs a course name — e.g. lyceum new Express routing for beginners");
      }
      const provider = resolveProvider(userConfig.provider);
      if (!provider) throw new CliError("new needs an LLM — set OPENAI_API_KEY or OLLAMA_HOST");
      console.log(`lyceum ${VERSION} — course: "${prompt}" — ${provider.label} (${provider.modelId})`);

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
          logFile,
        });
        printBuildSummary(result, existingPlan.outline.modules.length);
        if (result.failed.length) throw new CliError(`${result.failed.length} module(s) failed — re-run lyceum new to resume`);
        return;
      }

      // Append mode: an existing modules/ dir + a title = author ONE module
      // (old `add`/`draft` semantics folded into `new`).
      if (existsSync(join(targetDir, "modules"))) {
        await authorSingleModule(targetDir, prompt, provider, logFile);
        return;
      }

      // 1. Clarify (--yes skips; the recap feeds the planner).
      let context = prompt;
      if (!opts.yes) {
        console.log("clarifying…");
        console.log("waiting for model…"); // first-token latency can be long; never a silent hang
        const { recap } = await runClarify({ provider, prompt, progress: true, logFile });
        context = `${prompt}\n\nClarified: ${recap}`;
      }

      // 2. Research: always runs (web_search is a required stage); --no-research
      // opts out for cheap/offline runs.
      let research: ResearchReport | null = null;
      if (opts.research !== false) {
        console.log("researching…");
        console.log("waiting for model…");
        const { web_search } = buildAuthorTools({ courseRoot: targetDir, modules: [] });
        research = await runResearch({ provider, prompt: context, courseRoot: targetDir, webSearchTool: web_search, progress: true, logFile });
      }

      // 3. Plan.
      console.log("planning…");
      console.log("waiting for model…");
      const outline = await planCourse({
        provider,
        prompt: context,
        courseRoot: targetDir,
        research,
        moduleCountOverride: moduleCount,
        progress: true,
        logFile,
      });
      saveCoursePlan(newCoursePlan(targetDir, prompt, outline));
      console.log(`planned ${outline.modules.length} modules: ${outline.modules.map((m) => m.title).join(", ")}`);

      // 4. Author every module (continue-on-error; resume via the checkpoint).
      console.log("authoring…");
      console.log("waiting for model…");
      const result = await buildCourse({ provider, courseRoot: targetDir, outline, prompt, progress: true, logFile });
      printBuildSummary(result, outline.modules.length);
      if (result.failed.length) throw new CliError(`${result.failed.length} module(s) failed — re-run lyceum new to resume`);
      console.log(`Open it:  cd ${targetDir} && lyceum`);
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
  .command("provider")
  .description("show the resolved LLM provider")
  .action(() => {
    const p = resolveProvider(userConfig.provider);
    console.log(p ? `provider=${p.label} model=${p.modelId} base=${p.baseUrl}` : "none configured");
  });

program
  .command("setup")
  .description("write the user config to the XDG config dir (~/.config/lyceum/config.json)")
  .action(async () => {
    const config = await runSetup();
    const fresh = loadUserConfig();
    const p = resolveProvider(fresh.provider);
    console.log(`wrote ${config.dir}/config.json`);
    console.log(p ? `resolved provider: ${p.label} model=${p.modelId} base=${p.baseUrl}` : "resolved provider: none (env vars win over config)");
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

/** --log: truncate (or create) .lyceum/new.log for full-stream capture. */
function openLogFile(courseRoot: string): string {
  const dir = join(courseRoot, ".lyceum");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "new.log");
  writeFileSync(path, ""); // fresh run = fresh log
  return path;
}
