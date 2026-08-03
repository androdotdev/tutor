export type ModuleLayout = "modern" | "legacy";

export interface ModuleDesc {
  /** directory name, e.g. "00-networking-basics" */
  dir: string;
  /** zero-padded numeric id, e.g. "00" */
  id: string;
  /** human title derived from the dir name */
  title: string;
  layout: ModuleLayout;
  /** absolute path to modules/<dir> */
  moduleDir: string;
  /** absolute path to the module README (may be null) */
  readme: string | null;
  /** absolute path to the exercise stub file (student file) */
  student: string | null;
  /** test entries to run for this module (dirs or files) */
  testTargets: string[];
  /** absolute paths that must NEVER be revealed to the model */
  solutionPaths: string[];
  /** absolute path to the project directory, if present */
  projectDir: string | null;
}

export interface Course {
  /** absolute course root */
  root: string;
  modules: ModuleDesc[];
}

/** Sentinel message when we refuse to read a spoiler file. */
export const REDACTED_MESSAGE =
  "PERMANENTLY REDACTED — that's the teacher's copy (solutions/ or project solution). Read it only after you've finished.";