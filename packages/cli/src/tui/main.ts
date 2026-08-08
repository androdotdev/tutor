import { Key, matchesKey, ProcessTerminal, Text, TUI } from "@oh-my-pi/pi-tui";
import { join } from "node:path";
import type { ModuleDesc } from "@tutor/shared";
import { resolveCourse } from "@tutor/shared";
import { resolveProvider } from "@tutor/llms";
import { createTutorSession } from "@tutor/agents";
import type { UserConfig } from "../config";
import { LyceumApp } from "./App";

export async function runTui(
  courseRoot: string,
  initialModule: ModuleDesc | undefined,
  userConfig: UserConfig,
  opts?: { home?: boolean },
): Promise<void> {
  const modules = await resolveCourse(courseRoot);
  // Home works without modules (fresh course-building folder); the picker and
  // direct module sessions need a real course.
  if (!modules.length && !opts?.home) throw new Error(`no modules found under ${courseRoot}/modules`);

  const provider = resolveProvider(userConfig.provider);
  if (!provider) {
    throw new Error(
      "no LLM provider configured: set OPENAI_API_KEY (or OPENAI_BASE_URL) or OLLAMA_HOST",
    );
  }

  const tui = new TUI(new ProcessTerminal());
  tui.addChild(new Text("lyceum — Socratic self-learning coach", 0, 0));

  const app = new LyceumApp(tui, {
    courseRoot,
    modules,
    provider,
    initialModule,
    initialView: opts?.home ? "home" : "picker",
    makeSession: (module) =>
      createTutorSession({
        courseRoot,
        modules,
        module,
        provider,
        userPrompt: userConfig.systemPrompt,
        skillsDir: userConfig.skillsDir,
        historyFile: join(courseRoot, "session", `${module.id}.json`),
      }),
    onQuit: quit,
  });
  tui.addChild(app);

  let exiting = false;
  function quit(): void {
    if (exiting) return;
    exiting = true;
    try {
      tui.stop();
    } finally {
      process.exit(0);
    }
  }

  // Global bindings that must work regardless of focus. Listeners run before the
  // focused component; { consume: true } stops the key from reaching it.
  // Scrolling is native: the transcript commits to terminal scrollback, so
  // Shift+↑/↓ and friends are handled by tmux/the terminal, not here.
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      quit();
      return { consume: true };
    }
    return undefined;
  });

  tui.start();
}
