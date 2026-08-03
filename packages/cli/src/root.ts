import { existsSync } from "node:fs";
import { join } from "node:path";

/** Walk up from `cwd` to the first directory containing a `modules/` subdir. */
export function findCourseRoot(cwd: string): string | null {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, "modules"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}