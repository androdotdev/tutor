import type { ModuleDesc } from "@tutor/shared";

export interface TutorContext {
  courseRoot: string;
  modules: ModuleDesc[];
  /** Optional user skills dir (XDG config): enables list_skills/get_skill. */
  skillsDir?: string;
}