import type { ModuleDesc } from "@tutor/shared";

export interface TutorContext {
  courseRoot: string;
  modules: ModuleDesc[];
}