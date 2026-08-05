import { spawn } from "node:child_process";
import { Type, type Static } from "@earendil-works/pi-ai";
import { isSpoiler, REDACTED_MESSAGE, type ModuleDesc } from "@tutor/shared";
import { join, dirname, basename, relative, sep } from "node:path";
import { mkdir, readFile, realpath, readdir, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, statSync } from "node:fs";
import { searchWeb, type SearchFn } from "./web-search";
import { jsonResult, type PiAgentTool } from "./pi-tool";
import type { TutorContext } from "./types";

const MAX_OUTPUT = 60_000; // chars of test output relayed to the model
const MAX_FILE = 64 * 1024; // bytes read per file into model context

/** Normalized course root without trailing separators. */
const rootOf = (courseRoot: string) => courseRoot.replace(/[\\/]+$/, "");

/** True when `abs` is `root` itself or lexically under it (trailing-sep aware). */
function withinRoot(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + sep);
}

/**
 * Any path the resolver classified as a teacher's copy (solutions dir contents,
 * project solution files). `solutionPaths` are absolute file paths.
 */
function underSolutionPath(modules: ModuleDesc[], abs: string): boolean {
  for (const m of modules) {
    for (const sp of m.solutionPaths) {
      if (abs === sp || abs.startsWith(sp + sep)) return true;
    }
  }
  return false;
}

const redacted = () => ({ blocked: true, message: REDACTED_MESSAGE });
const escapes = () => ({ blocked: true, message: "path escapes the course root" });

function runCommand(cwd: string, cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const sink = (buf: Buffer) => {
      out += buf.toString();
      if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + "\n…[truncated]";
    };
    child.stdout!.on("data", sink);
    child.stderr!.on("data", sink);
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
    child.on("error", (err) => resolve({ code: -1, out: `failed to spawn: ${err.message}` }));
  });
}

const runTestsParams = Type.Object({ module: Type.String() });

export function buildTools(ctx: TutorContext) {
  const courseRoot = ctx.courseRoot;
  const modules = ctx.modules;

  const run_tests: PiAgentTool<typeof runTestsParams> = {
    name: "run_tests",
    label: "Run the module test suite",
    description:
      "Run the course module's test suite (spawns `bun test`). The ONLY referee: relay its output verbatim to the student. Input `module` is a module id, directory name, or title. Returns the tail of test output.",
    parameters: runTestsParams,
    execute: async (_toolCallId, input: Static<typeof runTestsParams>) => {
      const target = input.module?.trim() ?? "";
      const module = modules.find(
        (m) => m.dir === target || m.id === target || m.title.toLowerCase() === target.toLowerCase(),
      );
      if (!module) return jsonResult({ ok: false, out: `no module matches "${target}"` });
      if (!module.testTargets.length) return jsonResult({ ok: false, out: `module ${module.dir} has no test targets` });
      const { code, out } = await runCommand(courseRoot, "bun", ["test", ...module.testTargets]);
      return jsonResult({ ok: code === 0, module: module.dir, exitCode: code, out });
    },
  };

  const readFileParams = Type.Object({ path: Type.String() });

  const read_file: PiAgentTool<typeof readFileParams> = {
    name: "read_file",
    label: "Read a course file",
    description:
      "Read a course file (module README, exercise stub, or test) into context so you can help. `path` is relative to the course root. Files under solutions/ and project solution stubs are permanently redacted.",
    parameters: readFileParams,
    execute: async (_toolCallId, input: Static<typeof readFileParams>) => {
      const courseRoot = rootOf(ctx.courseRoot);
      const abs = join(courseRoot, input.path);
      if (!withinRoot(courseRoot, abs)) return jsonResult(escapes());
      // Lexical gate: solutions dirs + project solution stubs (covers both layouts).
      if (isSpoiler(courseRoot, abs) || underSolutionPath(ctx.modules, abs)) return jsonResult(redacted());
      // Symlink-hardening: re-check the fully resolved path, which may point
      // outside the course or at a spoiler (e.g. exercises/peek.js -> solutions/).
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        return jsonResult({ blocked: true, message: `no such file: ${input.path}` });
      }
      if (!withinRoot(courseRoot, real)) return jsonResult(escapes());
      if (isSpoiler(courseRoot, real) || underSolutionPath(ctx.modules, real)) return jsonResult(redacted());
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(real);
      } catch {
        return jsonResult({ blocked: true, message: `cannot read: ${input.path}` });
      }
      if (!st.isFile()) return jsonResult({ blocked: true, message: `${input.path} is not a file` });
      const raw = await readFile(real, "utf8");
      return jsonResult({
        path: input.path,
        bytes: st.size,
        content: raw.length > MAX_FILE ? raw.slice(0, MAX_FILE) + "\n…[truncated]" : raw,
      });
    },
  };

  /** Max grep hits relayed to the model. */
  const MAX_GREP_MATCHES = 30;
  /** Max chars of a matched line relayed to the model. */
  const MAX_GREP_LINE = 200;

  const grepParams = Type.Object({ pattern: Type.String() });

  const grep: PiAgentTool<typeof grepParams> = {
    name: "grep",
    label: "Search the course",
    description:
      "Search the course (modules + root files) for a regex pattern; returns up to 30 matches as `file:line: text`. Solutions/ and project solution stubs are never searched. Use it to find where something is defined or mentioned without reading whole files.",
    parameters: grepParams,
    execute: async (_toolCallId, input: Static<typeof grepParams>) => {
      let re: RegExp;
      try {
        re = new RegExp(input.pattern, "i");
      } catch (err) {
        return jsonResult({ ok: false, message: `invalid regex: ${(err as Error).message}` });
      }
      const courseRoot = rootOf(ctx.courseRoot);
      const matches: string[] = [];
      // Helper pins the string-path overload of readdir (Dirent<string>[]).
      const listEntries = (dir: string) => readdir(dir, { withFileTypes: true });
      const walk = async (dir: string): Promise<void> => {
        if (matches.length >= MAX_GREP_MATCHES) return;
        let entries: Awaited<ReturnType<typeof listEntries>>;
        try {
          entries = await listEntries(dir);
        } catch {
          return; // unreadable dir: skip, never fail the whole search
        }
        for (const ent of entries) {
          if (matches.length >= MAX_GREP_MATCHES) return;
          const abs = join(dir, ent.name);
          if (ent.isDirectory()) {
            if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
            if (isSpoiler(courseRoot, abs)) continue; // solutions/ dirs
            await walk(abs);
          } else if (ent.isFile() || ent.isSymbolicLink()) {
            // Same lexical + realpath gates as read_file: a symlinked file may
            // point at a spoiler or outside the course — resolve and re-check.
            if (isSpoiler(courseRoot, abs) || underSolutionPath(ctx.modules, abs)) continue;
            let real: string;
            try {
              real = await realpath(abs);
            } catch {
              continue;
            }
            if (!withinRoot(courseRoot, real)) continue;
            if (isSpoiler(courseRoot, real) || underSolutionPath(ctx.modules, real)) continue;
            let text: string;
            try {
              text = await readFile(real, "utf8");
            } catch {
              continue; // binary or unreadable
            }
            const rel = relative(courseRoot, real).split(sep).join("/");
            for (const [lineNo, line] of text.split("\n").entries()) {
              if (re.test(line)) {
                const shown = line.length > MAX_GREP_LINE ? `${line.slice(0, MAX_GREP_LINE)}…` : line;
                matches.push(`${rel}:${lineNo + 1}: ${shown}`);
                if (matches.length >= MAX_GREP_MATCHES) return;
              }
            }
          }
        }
      };
      await walk(courseRoot);
      return jsonResult({
        ok: true,
        pattern: input.pattern,
        matches: matches.length ? matches : ["no matches (solutions/ is never searched)"],
      });
    },
  };

  const MAX_SKILL = 8_000; // chars of a skill's content relayed to the model

  const listSkillsParams = Type.Object({});

  const list_skills: PiAgentTool<typeof listSkillsParams> = {
    name: "list_skills",
    label: "List available skills",
    description:
      "List the learner's available skills by name (names only — content is loaded on demand). Returns [] when no skills directory is configured.",
    parameters: listSkillsParams,
    execute: async () => {
      if (!ctx.skillsDir) return jsonResult({ ok: true, skills: [] });
      let entries: string[];
      try {
        entries = await readdir(ctx.skillsDir);
      } catch {
        return jsonResult({ ok: true, skills: [] }); // missing/unreadable dir: no skills
      }
      return jsonResult({
        ok: true,
        skills: entries.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort(),
      });
    },
  };

  const getSkillParams = Type.Object({ name: Type.String() });

  const get_skill: PiAgentTool<typeof getSkillParams> = {
    name: "get_skill",
    label: "Load one skill's content",
    description:
      "Load ONE user skill's content by name (from list_skills). Only the requested skill is read; content is capped. Use it when a skill would genuinely change how you teach this session.",
    parameters: getSkillParams,
    execute: async (_toolCallId, input: Static<typeof getSkillParams>) => {
      if (!ctx.skillsDir) return jsonResult({ ok: false, message: "no skills directory configured" });
      const name = input.name.trim();
      // Plain filename only: no separators, no traversal, no dots-only names.
      if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        return jsonResult({ ok: false, message: "invalid skill name" });
      }
      let entries: string[];
      try {
        entries = await readdir(ctx.skillsDir);
      } catch {
        return jsonResult({ ok: false, message: `no skills directory at ${ctx.skillsDir}` });
      }
      const target = entries.find((f) => f.toLowerCase() === `${name.toLowerCase()}.md`);
      if (!target) return jsonResult({ ok: false, message: `no skill named "${name}"` });
      // Resolve and re-check: a symlinked skill file must stay inside the dir.
      const abs = join(ctx.skillsDir, target);
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        return jsonResult({ ok: false, message: `cannot read skill "${name}"` });
      }
      if (!withinRoot(rootOf(ctx.skillsDir), real)) {
        return jsonResult({ blocked: true, message: "skill path escapes the skills directory" });
      }
      let text: string;
      try {
        text = await readFile(real, "utf8");
      } catch {
        return jsonResult({ ok: false, message: `cannot read skill "${name}"` });
      }
      return jsonResult({
        ok: true,
        name,
        content: text.length > MAX_SKILL ? `${text.slice(0, MAX_SKILL)}\n…(truncated)` : text,
      });
    },
  };

  return { run_tests, read_file, grep, list_skills, get_skill };
}

/**
 * Author-mode tool set: the agent can READ the course, RUN the grader, WRITE
 * module files (README / exercise stub / tests), and RESEARCH topics on the web.
 * `solutions/` stays hard-redacted for both read and write, so the learner
 * can't peek or pollute the teacher's copy.
 */
export function buildAuthorTools(ctx: TutorContext, deps: { search?: SearchFn } = {}) {
  const { run_tests, read_file, grep } = buildTools(ctx);
  const search = deps.search ?? searchWeb;

  const webSearchParams = Type.Object({ query: Type.String() });

  const web_search: PiAgentTool<typeof webSearchParams> = {
    name: "web_search",
    label: "Search the web",
    description:
      "Search the web (no API key) for up to 5 results: title, URL, snippet each. Use it to research module topics — official docs, best practices, examples. Results are EXTERNAL pages: never paste them into exercises or README; write original content informed by them.",
    parameters: webSearchParams,
    execute: async (_toolCallId, input: Static<typeof webSearchParams>) => {
      const query = typeof input?.query === "string" ? input.query.trim() : "";
      if (query === "") {
        // Some providers strip tool-call arguments entirely, so a model that
        // believes it searched arrives with {}. Searching an empty/undefined
        // query silently feeds garbage ("undefined" pages) back to the model —
        // reject loudly so it retries with a query or proceeds without one.
        throw new Error("web_search called without a query — retry with the query argument.");
      }
      try {
        const results = await search(query);
        return jsonResult({ ok: true, query, results });
      } catch (err) {
        return jsonResult({
          ok: false,
          message: `web search failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };

  const writeFileParams = Type.Object({
    path: Type.String(),
    content: Type.String(),
  });

  const write_file: PiAgentTool<typeof writeFileParams> = {
    name: "write_file",
    label: "Create or overwrite a course file",
    description:
      "Create or overwrite a course file so you can author modules: README.md, exercise/index.js (stub), tests/index.test.js. `path` is relative to the course root. Never write to solutions/.",
    parameters: writeFileParams,
    execute: async (_toolCallId, input: Static<typeof writeFileParams>) => {
      const courseRoot = rootOf(ctx.courseRoot);
      const abs = join(courseRoot, input.path);
      if (!withinRoot(courseRoot, abs)) return jsonResult(escapes());
      if (isSpoiler(courseRoot, abs) || underSolutionPath(ctx.modules, abs)) {
        return jsonResult({ blocked: true, message: "writing to solutions/ is not allowed" });
      }
      // Never write through a symlink: truncating a link would hit its target
      // (e.g. a solutions file), not the path the model asked for.
      try {
        if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
          return jsonResult({ blocked: true, message: "refusing to write through a symlink" });
        }
      } catch {
        return jsonResult({ blocked: true, message: `cannot inspect: ${input.path}` });
      }
      // Resolve the deepest existing ancestor so a symlinked intermediate dir
      // cannot redirect the write outside the course (or into solutions).
      let parent = dirname(abs);
      const missing: string[] = [];
      while (!existsSync(parent)) {
        const name = basename(parent);
        missing.unshift(name);
        const up = dirname(parent);
        if (up === parent) break;
        parent = up;
      }
      let realParent: string;
      try {
        realParent = await realpath(parent);
      } catch {
        return jsonResult({ blocked: true, message: `cannot resolve parent: ${input.path}` });
      }
      if (!withinRoot(courseRoot, realParent)) return jsonResult(escapes());
      if (isSpoiler(courseRoot, realParent) || underSolutionPath(ctx.modules, realParent)) {
        return jsonResult({ blocked: true, message: "writing to solutions/ is not allowed" });
      }
      // Recreate the missing chain under the validated real parent.
      if (missing.length) {
        await mkdir(join(realParent, ...missing), { recursive: true });
      }
      await writeFile(abs, input.content, "utf8");
      return jsonResult({ ok: true, path: input.path, bytes: input.content.length });
    },
  };

  return { run_tests, read_file, write_file, grep, web_search };
}
