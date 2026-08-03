#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { resolveCourse, findModule, type ModuleDesc } from "@tutor/shared";
import { resolveProvider } from "@tutor/llms";
import { createAuthorSession } from "@tutor/agents";
import { scaffoldCourse, addModule } from "@tutor/core";
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
  // headless commands (list/test/new/add/provider) and out of the tsup entry
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

program
  .command("new")
  .description("scaffold a course")
  .argument("<dir>", "course directory")
  .option("--name <name>", "course display name (default: derived from dir)")
  .option("--topic <topic>", "course topic")
  .option("--title <title>", "alias for --topic")
  .option("--modules <n>", "number of modules", "3")
  .action(async (dir: string, opts: { name?: string; topic?: string; title?: string; modules: string }) => {
    const name =
      opts.name ??
      basename(dir).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const parsed = Number(opts.modules);
    const created = await scaffoldCourse(
      { name, topic: opts.topic ?? opts.title, moduleCount: Number.isFinite(parsed) ? parsed : 3 },
      dir,
    );
    console.log(`course "${name}" scaffolded at ${dir}`);
    for (const m of created.modules) console.log(`  ${m.id}  ${m.title}`);
    console.log(`Open it:  LYCEUM_COURSE=${dir} lyceum`);
  });

program
  .command("add")
  .description("append a module to the course")
  .argument("[title]", "module title", "Next module")
  .option("--topic <topic>", "module topic")
  .action(async (title: string, opts: { topic?: string }) => {
    const { courseRoot } = await loadCourse();
    const mod = await addModule(courseRoot, { title, topic: opts.topic });
    console.log(`added module ${mod.id} ${mod.dir}`);
  });

program
  .command("draft")
  .description("author a module with the AI agent")
  .argument("[title]", "module title, or an existing module to finish", "Untitled module")
  .action(async (title: string) => {
    const { courseRoot, modules: initial } = await loadCourse();
    let modules = initial;
    let module = (await findModule(modules, title)) ?? null;
    if (!module) {
      const mod = await addModule(courseRoot, { title });
      modules = await resolveCourse(courseRoot);
      module = (await findModule(modules, mod.dir)) ?? null;
    }
    if (!module) throw new CliError(`could not resolve module "${title}"`);
    const provider = resolveProvider(userConfig.provider);
    if (!provider) throw new CliError("draft needs an LLM — set OPENAI_API_KEY or OLLAMA_HOST");

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
  });

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
