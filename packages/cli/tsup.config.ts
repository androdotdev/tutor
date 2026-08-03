import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  // @oh-my-pi/pi-natives is a Rust N-API addon resolved at runtime; its
  // per-platform packages are loaded dynamically by it, so it cannot be
  // bundled. Everything else (pi-tui, @cline/*, @tutor/*, commander) is
  // bundled so the published tarball is self-contained.
  external: [/^@oh-my-pi\/pi-natives/],
});
