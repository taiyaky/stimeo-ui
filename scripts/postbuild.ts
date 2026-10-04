import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stimeoControllers } from "../src";
import { buildExamplesIndex } from "../src/inspector/examples";
import { buildManifest } from "../src/inspector/manifest";
import {
  assertCoreControllerArtifacts,
  assertCoreControllerCoverage,
  assertCoreControllerRegistry,
} from "./controller_entries";
import { collectDemoSources } from "./demo_sources";
import { finalizeJavaScriptArtifact, type RawSourceMap } from "./source_map";

/**
 * Post-build step for the Inspector CLI.
 *
 * tsup builds `dist/inspector/cli_bin.js`; this script then:
 *   1. Verifies every public core source agrees with the `stimeoControllers`
 *      registry and has both JavaScript and declaration artifacts for the
 *      wildcard package export.
 *   2. Generates the bundled manifest JSON from the reflected controllers,
 *      verifies its Core coverage, and keeps the installed CLI on the exact
 *      version it ships with.
 *   3. Generates the bundled example index (`examples.json`) from the demo
 *      sidecars (`collectDemoSources` resolves their root); `buildExamplesIndex`
 *      fails the build when a demo and the manifest drift or an example stops
 *      passing the checker.
 *   4. Keeps one final source-map directive per JavaScript artifact, prepends
 *      the Node CLI shebang with its unmapped line in the map, and marks the CLI
 *      executable so the `stimeo` / `stimeo-ui` bins run directly.
 *
 * Run via Bun (`bun scripts/postbuild.ts`) so it can import the TypeScript
 * source directly.
 */

// Script-relative, not cwd-relative, so the step also works when invoked from
// outside the repo root (same convention as the other scripts/*.ts).
const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

assertCoreControllerRegistry(root, Object.keys(stimeoControllers));
assertCoreControllerArtifacts(root);

const manifest = buildManifest(pkg.version);
assertCoreControllerCoverage(root, "Inspector manifest", Object.keys(manifest.controllers));
const outDir = join(root, "dist", "inspector");
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const examples = buildExamplesIndex(collectDemoSources(root), manifest);
writeFileSync(join(outDir, "examples.json"), `${JSON.stringify(examples, null, 2)}\n`);

const cliPath = join(outDir, "cli_bin.js");
prepareJavaScript(join(root, "dist"));
chmodSync(cliPath, 0o755);

/** Finalizes emitted JavaScript without moving any mapped token except past the CLI shebang. */
function prepareJavaScript(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      prepareJavaScript(path);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      const code = readFileSync(path, "utf8");
      const mapPath = `${path}.map`;
      const map = JSON.parse(readFileSync(mapPath, "utf8")) as RawSourceMap;
      const finalized = finalizeJavaScriptArtifact(
        code,
        map,
        `${basename(path)}.map`,
        path === cliPath,
      );
      if (finalized.code !== code) writeFileSync(path, finalized.code);
      if (finalized.map !== map) writeFileSync(mapPath, JSON.stringify(finalized.map));
    }
  }
}

console.log(
  `Inspector: wrote manifest.json (${Object.keys(manifest.controllers).length} controllers), ` +
    `examples.json (${Object.keys(examples.examples).length} examples), and prepared cli_bin.js`,
);
