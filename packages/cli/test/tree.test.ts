// /tree tests: overlay wiring + history rewind (omp-style jump/rewind, v1).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SelectItem, TUI } from "@oh-my-pi/pi-tui";
import { loadHistoryFile, type HistoryTurn, type TutorSession } from "@tutor/agents";
import type { ModuleDesc } from "@tutor/shared";
import type { ProviderSelection } from "@tutor/llms";
import { LyceumApp, SessionView } from "../src/tui/App";
import { openTreeOverlay, rewindHistoryFile } from "../src/tui/tree";

const module = {
  id: "m1",
  title: "One",
  dir: "one",
  moduleDir: "one",
  layout: "exercise",
} as ModuleDesc;

const turns: HistoryTurn[] = [
  { who: "user", text: "help", ts: 1 },
  { who: "assistant", text: "sure", ts: 2 },
  { who: "user", text: "and then?", ts: 3 },
];

function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lyceum-tree-"));
  const file = join(dir, name);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

function writeTurns(file: string): void {
  writeFileSync(file, JSON.stringify(turns));
}

function readTurns(file: string): HistoryTurn[] {
  return JSON.parse(readFileSync(file, "utf8")) as HistoryTurn[];
}

describe("rewindHistoryFile", () => {
  test("truncates the file at the picked turn (inclusive)", () => {
    const file = tempFile("session/m1.json");
    writeTurns(file);
    const { original, kept } = rewindHistoryFile(file, 1);
    expect(original).toBe(3);
    expect(kept).toBe(2);
    const left = readTurns(file);
    expect(left.length).toBe(2);
    expect(left[1].text).toBe("sure");
  });

  test("picking the first turn keeps one turn", () => {
    const file = tempFile("session/m1.json");
    writeTurns(file);
    const { kept } = rewindHistoryFile(file, 0);
    expect(kept).toBe(1);
  });

  test("missing or corrupt files are a no-op", () => {
    const file = tempFile("session/m1.json");
    const { original, kept } = rewindHistoryFile(file, 0);
    expect(original).toBe(0);
    expect(kept).toBe(0);
  });
});

describe("openTreeOverlay", () => {
  test("fullscreen picker: select rewinds to the index, cancel hides untouched", () => {
    let picked: number | null = null;
    let hidden = false;
    let list: { onSelect?: (item: SelectItem) => void; onCancel?: () => void } | null = null;
    let options: unknown = null;
    const mockTui = {
      terminal: { rows: 24 },
      showOverlay(component: unknown, opts?: unknown) {
        list = component as typeof list;
        options = opts;
        return { hide: () => (hidden = true), setHidden() {}, isHidden: () => false };
      },
    } as unknown as TUI;

    openTreeOverlay(mockTui, turns, (i) => (picked = i));
    expect(options).toEqual({ fullscreen: true });
    list?.onSelect?.({ value: "1", label: "sure" });
    expect(picked).toBe(1);
    expect(hidden).toBe(true);

    list?.onCancel?.();
    expect(hidden).toBe(true); // hide is idempotent; session untouched
  });
});

describe("SessionView /tree", () => {
  function makeSession(history: HistoryTurn[], ask: () => Promise<string> = async () => ""): TutorSession {
    return { historyTurns: history, subscribe: () => () => {}, abort() {}, ask };
  }

  const tui = { requestRender() {} } as unknown as TUI;

  test("no history → note, no overlay", () => {
    const view = new SessionView(tui, {
      session: makeSession([]),
      module,
      onBack() {},
      onRewind() {},
    });
    view.focusable.onSubmit?.("/tree");
    expect(view.transcript.render(80).join("\n")).toContain("no earlier turns to rewind to");
  });

  test("busy run defers with a hint", () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const view = new SessionView(tui, {
      session: makeSession(turns.slice(0, 2), () => promise.then(() => "")),
      module,
      onBack() {},
      onRewind() {},
    });
    view.focusable.onSubmit?.("hello"); // busy=true synchronously before the await
    view.focusable.onSubmit?.("/tree");
    expect(view.transcript.render(80).join("\n")).toContain("coach is thinking");
    resolve();
  });

  test("non-tree messages still reach the coach", () => {
    let asked = "";
    const view = new SessionView(tui, {
      session: makeSession([], async (input) => {
        asked = input;
        return "ok";
      }),
      module,
      onBack() {},
      onRewind() {},
    });
    view.focusable.onSubmit?.("what is a closure?");
    expect(asked).toBe("what is a closure?");
  });
});

describe("LyceumApp rewind", () => {
  test("picking a turn truncates the file and rebuilds the session", () => {
    const file = tempFile("session/m1.json");
    writeTurns(file);
    let sessions = 0;
    const mockTui = {
      terminal: { rows: 24 },
      requestRender() {},
      setFocus() {},
      showOverlay() {
        return { hide() {}, setHidden() {}, isHidden: () => false };
      },
    } as unknown as TUI;
    let list: { onSelect?: (item: SelectItem) => void } | null = null;
    const capturingTui = {
      ...mockTui,
      showOverlay(component: unknown) {
        list = component as typeof list;
        return mockTui.showOverlay();
      },
    } as unknown as TUI;

    const app = new LyceumApp(capturingTui, {
      courseRoot: dirname(dirname(file)),
      modules: [module],
      provider: {} as ProviderSelection,
      initialModule: module,
      makeSession: () => {
        sessions += 1;
        return {
          historyTurns: loadHistoryFile(file),
          subscribe: () => () => {},
          abort() {},
          ask: async () => "",
        } as TutorSession;
      },
      onQuit() {},
    });

    app.focusable?.onSubmit?.("/tree");
    list?.onSelect?.({ value: "0", label: "help" }); // rewind to the first turn

    const left = readTurns(file);
    expect(left.length).toBe(1);
    expect(left[0].text).toBe("help");
    expect(sessions).toBe(2); // original + the rebuilt one
  });
});
