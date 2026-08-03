import { defineConfig } from "tsup";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL(".", import.meta.url));

// Bundle the workspace packages from source so the build does not depend on
// per-package node_modules links (bun creates them for declared deps only;
// @tutor/* are intentionally not declared — they don't exist on npm).
const workspaceAlias = {
  "@tutor/shared": `${pkgDir}../shared/src/index.ts`,
  "@tutor/core": `${pkgDir}../core/src/index.ts`,
  "@tutor/llms": `${pkgDir}../llms/src/index.ts`,
  "@tutor/agents": `${pkgDir}../agents/src/index.ts`,
};

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  alias: workspaceAlias,
  // @oh-my-pi/pi-natives is a Rust N-API addon resolved at runtime; its
  // per-platform packages are loaded dynamically by it, so it cannot be
  // bundled. Everything else (pi-tui, @cline/*, @tutor/*, commander) is
  // bundled so the published tarball is self-contained.
  external: [/^@oh-my-pi\/pi-natives/],
});
