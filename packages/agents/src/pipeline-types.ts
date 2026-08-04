// Shared types for the `lyceum new "<prompt>"` pipeline. Single source of
// truth for cross-stage contracts (Researcher -> Planner -> Course-Builder ->
// checkpoint file). Hand-rolled shape guards live next to each stage; this
// file is types only — no runtime code.

/** Researcher output: sourced claims the Planner can build the curriculum on. */
export interface ResearchFinding {
  claim: string;
  source_url: string;
  note?: string;
}

export interface ResearchReport {
  findings: ResearchFinding[];
  caveats?: string;
}

export type ModuleDifficulty = "intro" | "core" | "capstone";

export interface PlannedModule {
  id: string;
  title: string;
  concepts: string[];
  difficulty: ModuleDifficulty;
  /** source urls from the research report backing this module's topic */
  sources?: string[];
}

export interface CourseOutline {
  name: string;
  topic: string;
  modules: PlannedModule[];
}

export type ModuleBuildStatus = "pending" | "drafted" | "failed";

export interface CoursePlanModule {
  id: string;
  title: string;
  status: ModuleBuildStatus;
  error?: string;
  dir?: string;
}

/** Resumable checkpoint at <courseRoot>/.lyceum/plan.json. */
export interface CoursePlanFile {
  version: 1;
  courseRoot: string;
  prompt: string;
  createdAt: number;
  outline: CourseOutline;
  modules: CoursePlanModule[];
}
