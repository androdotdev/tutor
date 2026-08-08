// Session-tree navigator (omp /tree, v1): pick an earlier turn, continue from
// there. Sessions are flat, so "rewind" truncates the history file at the
// picked turn and rebuilds the session — the coach forgets everything after it.
import { SelectList, type OverlayHandle, type TUI } from "@oh-my-pi/pi-tui";
import { loadHistoryFile, saveHistoryFile, type HistoryTurn } from "@tutor/agents";
import { selectTheme } from "./theme";

const LABEL_MAX = 60;

function turnLabel(turn: HistoryTurn): string {
  const who = turn.who === "user" ? "you" : "coach";
  const text = turn.text.replace(/\s+/g, " ").trim();
  const snippet = text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX)}…` : text;
  return `${who}: ${snippet}`;
}

/**
 * Fullscreen turn picker. Selecting a turn calls `onPick(index)` — the turn
 * and everything before it stay; later turns are forgotten. Cancel hides the
 * overlay and leaves the session untouched.
 */
export function openTreeOverlay(
  tui: TUI,
  turns: readonly HistoryTurn[],
  onPick: (index: number) => void,
): OverlayHandle {
  const items = turns.map((t, i) => ({
    value: String(i),
    label: turnLabel(t),
    description: new Date(t.ts).toLocaleString(),
  }));
  const list = new SelectList(items, Math.max(3, tui.terminal.rows - 2), selectTheme, {});
  const handle = tui.showOverlay(list, { fullscreen: true });
  list.onSelect = (item) => {
    handle.hide();
    onPick(Number(item.value));
  };
  list.onCancel = () => handle.hide();
  return handle;
}

/**
 * Rewind a session history file to `index` (inclusive). Returns the original
 * and kept turn counts (for the transcript note). Missing/corrupt files are a
 * no-op ({ original: 0, kept: 0 }).
 */
export function rewindHistoryFile(
  file: string,
  index: number,
): { original: number; kept: number } {
  const turns = loadHistoryFile(file);
  const original = turns.length;
  if (original === 0) return { original: 0, kept: 0 };
  const kept = turns.slice(0, index + 1);
  saveHistoryFile(file, kept);
  return { original, kept: kept.length };
}
