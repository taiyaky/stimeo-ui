import { defineConfig } from "tsup";
import { coreControllerEntries } from "./scripts/controller_entries";

/**
 * Every core controller is a public `stimeo-ui/controllers/*` subpath.
 *
 * Deriving the entries from source prevents a new barrel-registered controller
 * from silently shipping without its individual JavaScript and declaration
 * files. The postbuild step verifies the resulting artifacts as a second guard.
 */
const coreEntries = coreControllerEntries(import.meta.dirname);

// Builds standard ESM + .d.ts so the library is consumable BOTH ways:
//   - importmap-rails: pin the emitted dist/index.js directly
//   - jsbundling-rails (esbuild/bun): `bun link` + `import "stimeo-ui"`
// @hotwired/stimulus is kept external; the consuming Rails app provides it.
export default defineConfig({
  entry: [
    "src/index.ts",
    ...coreEntries,
    "src/positioning/index.ts",
    "src/cable/index.ts",
    "src/inspector/cli.ts",
    "src/inspector/cli_bin.ts",
  ],
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  // @floating-ui/dom stays external: it is an OPTIONAL peer pulled in only by the
  // opt-in `stimeo-ui/positioning` subpath, never by the core. The audit allows
  // this bare import solely under `positioning/` so the core stays zero-dep.
  external: ["@hotwired/stimulus", "@floating-ui/dom", "@rails/actioncable"],
  outDir: "dist",
});
