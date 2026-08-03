import { spawn } from "node:child_process";
import { createTool } from "@cline/shared";
import { isSpoiler, REDACTED_MESSAGE, type ModuleDesc } from "@tutor/shared";
import { join, dirname, basename, sep } from "node:path";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, statSync } from "node:fs";
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

export function buildTools(ctx: TutorContext) {
  const courseRoot = ctx.courseRoot;
  const modules = ctx.modules;

  const run_tests = createTool({
    name: "run_tests",
    description:
      "Run the course module's test suite (spawns `bun test`). The ONLY referee: relay its output verbatim to the student. Input `module` is a module id, directory name, or title. Returns the tail of test output.",
    inputSchema: { type: "object", properties: { module: { type: "string" } }, required: ["module"] },
    execute: async (input: { module?: string }) => {
      const target = input.module?.trim() ?? "";
      const module = modules.find(
        (m) => m.dir === target || m.id === target || m.title.toLowerCase() === target.toLowerCase(),
      );
      if (!module) return { ok: false, out: `no module matches "${target}"` };
      if (!module.testTargets.length) return { ok: false, out: `module ${module.dir} has no test targets` };
      const { code, out } = await runCommand(courseRoot, "bun", ["test", ...module.testTargets]);
      return { ok: code === 0, module: module.dir, exitCode: code, out };
    },
  });

  const read_file = createTool({
    name: "read_file",
    description:
      "Read a course file (module README, exercise stub, or test) into context so you can help. `path` is relative to the course root. Files under solutions/ and project solution stubs are permanently redacted.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (input: { path: string }) => {
      const courseRoot = rootOf(ctx.courseRoot);
      const abs = join(courseRoot, input.path);
      if (!withinRoot(courseRoot, abs)) return escapes();
      // Lexical gate: solutions dirs + project solution stubs (covers both layouts).
      if (isSpoiler(courseRoot, abs) || underSolutionPath(ctx.modules, abs)) return redacted();
      // Symlink-hardening: re-check the fully resolved path, which may point
      // outside the course or at a spoiler (e.g. exercises/peek.js -> solutions/).
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        return { blocked: true, message: `no such file: ${input.path}` };
      }
      if (!withinRoot(courseRoot, real)) return escapes();
      if (isSpoiler(courseRoot, real) || underSolutionPath(ctx.modules, real)) return redacted();
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(real);
      } catch {
        return { blocked: true, message: `cannot read: ${input.path}` };
      }
      if (!st.isFile()) return { blocked: true, message: `${input.path} is not a file` };
      const raw = await readFile(real, "utf8");
      return {
        path: input.path,
        bytes: st.size,
        content: raw.length > MAX_FILE ? raw.slice(0, MAX_FILE) + "\n…[truncated]" : raw,
      };
    },
  });

  return { run_tests, read_file };
}

/**
 * Author-mode tool set: the agent can READ the course, RUN the grader, and WRITE
 * module files (README / exercise stub / tests). `solutions/` stays hard-redacted
 * for both read and write, so the learner can't peek or pollute the teacher's copy.
 */
export function buildAuthorTools(ctx: TutorContext) {
  const { run_tests, read_file } = buildTools(ctx);

  const write_file = createTool({
    name: "write_file",
    description:
      "Create or overwrite a course file so you can author modules: README.md, exercise/index.js (stub), tests/index.test.js. `path` is relative to the course root. Never write to solutions/.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    execute: async (input: { path: string; content: string }) => {
      const courseRoot = rootOf(ctx.courseRoot);
      const abs = join(courseRoot, input.path);
      if (!withinRoot(courseRoot, abs)) return escapes();
      if (isSpoiler(courseRoot, abs) || underSolutionPath(ctx.modules, abs)) {
        return { blocked: true, message: "writing to solutions/ is not allowed" };
      }
      // Never write through a symlink: truncating a link would hit its target
      // (e.g. a solutions file), not the path the model asked for.
      try {
        if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
          return { blocked: true, message: "refusing to write through a symlink" };
        }
      } catch {
        return { blocked: true, message: `cannot inspect: ${input.path}` };
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
        return { blocked: true, message: `cannot resolve parent: ${input.path}` };
      }
      if (!withinRoot(courseRoot, realParent)) return escapes();
      if (isSpoiler(courseRoot, realParent) || underSolutionPath(ctx.modules, realParent)) {
        return { blocked: true, message: "writing to solutions/ is not allowed" };
      }
      // Recreate the missing chain under the validated real parent.
      if (missing.length) {
        await mkdir(join(realParent, ...missing), { recursive: true });
      }
      await writeFile(abs, input.content, "utf8");
      return { ok: true, path: input.path, bytes: input.content.length };
    },
  });

  return { run_tests, read_file, write_file };
}