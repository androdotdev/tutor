import { Key, matchesKey, ProcessTerminal, Text, TUI } from "@oh-my-pi/pi-tui";
import type { ModuleDesc } from "@tutor/shared";
import { resolveCourse } from "@tutor/shared";
import { resolveProvider } from "@tutor/llms";
import { createTutorSession } from "@tutor/agents";
import type { UserConfig } from "../config";
import { LyceumApp, SessionView } from "./App";

const SCROLL_KEYS = ["shift+up", "shift+down", "pageUp", "pageDown", "home", "end"] as const;

export async function runTui(
  courseRoot: string,
  initialModule: ModuleDesc | undefined,
  userConfig: UserConfig,
): Promise<void> {
  const modules = await resolveCourse(courseRoot);
  if (!modules.length) throw new Error(`no modules found under ${courseRoot}/modules`);

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
    makeSession: (module) =>
      createTutorSession({
        courseRoot,
        modules,
        module,
        provider,
        userPrompt: userConfig.systemPrompt,
        skillsDir: userConfig.skillsDir,
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
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      quit();
      return { consume: true };
    }
    const view = app.sessionView;
    if (view instanceof SessionView) {
      const isScrollKey = SCROLL_KEYS.some((k) => matchesKey(data, k));
      if (isScrollKey) {
        const consumed = view.transcript.handleScrollKey(data);
        view.transcript.setFollowTail(matchesKey(data, "end"));
        return consumed ? { consume: true } : undefined;
      }
    }
    return undefined;
  });

  tui.start();
}
