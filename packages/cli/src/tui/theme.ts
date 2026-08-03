// Minimal ANSI themes for the pi-tui components. No chalk — plain escape codes.
import type { MarkdownTheme, SelectListTheme, SymbolTheme } from "@oh-my-pi/pi-tui";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`;

export const symbols: SymbolTheme = {
  cursor: "▸",
  inputCursor: "▏",
  boxRound: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
  },
  boxSharp: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
    teeDown: "┬",
    teeUp: "┴",
    teeLeft: "┤",
    teeRight: "├",
    cross: "┼",
  },
  table: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
    teeDown: "┬",
    teeUp: "┴",
    teeLeft: "┤",
    teeRight: "├",
    cross: "┼",
  },
  quoteBorder: "▌",
  hrChar: "─",
  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

export const selectTheme: SelectListTheme = {
  selectedPrefix: cyan,
  selectedText: bold,
  description: dim,
  scrollInfo: dim,
  noMatch: dim,
  symbols,
};

export const markdownTheme: MarkdownTheme = {
  heading: bold,
  link: cyan,
  linkUrl: dim,
  code: yellow,
  codeBlock: yellow,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic: (s) => `\x1b[3m${s}\x1b[0m`,
  strikethrough: dim,
  underline: (s) => `\x1b[4m${s}\x1b[0m`,
  highlightCode: (code) => [yellow(code)],
  symbols,
};

/** ANSI helpers shared by the app chrome. */
export const style = { dim, bold, cyan, yellow, green, red, blue };
