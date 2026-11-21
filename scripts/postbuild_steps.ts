import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stimeoControllers } from "../src";
import { buildExamplesIndex } from "../src/inspector/examples";
import { buildManifest } from "../src/inspector/manifest";
import type { Manifest } from "../src/inspector/types";
import {
  assertCoreControllerArtifacts,
  assertCoreControllerCoverage,
  assertCoreControllerRegistry,
} from "./controller_entries";
import { collectDemoSources } from "./demo_sources";
import { finalizeJavaScriptArtifact, type RawSourceMap } from "./source_map";

/** What a post-build run wrote. */
export interface PostbuildSummary {
  readonly controllers: number;
  readonly examples: number;
}

/** Finalizes emitted JavaScript without moving any mapped token except past the CLI shebang. */
function prepareJavaScript(directory: string, cliPath: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      prepareJavaScript(path, cliPath);
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

/**
 * Completes the build in `distDir`:
 *   1. Verifies every core controller source agrees with the `stimeoControllers`
 *      registry and has both JavaScript and declaration artifacts in `distDir`
 *      for the wildcard package export.
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
 * @param manifestOf - builds the manifest for a package version; the reflected
 *   controllers unless a test replaces it.
 * @throws when a check fails. The registry, artifact and coverage checks fail before
 *   anything is written; the example index is checked after `manifest.json` is written,
 *   so its failure leaves that file behind.
 */
export function runPostbuild(
  root: string,
  distDir: string,
  log: (line: string) => void = console.log,
  manifestOf: (version: string) => Manifest = buildManifest,
): PostbuildSummary {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  assertCoreControllerRegistry(root, Object.keys(stimeoControllers));
  assertCoreControllerArtifacts(root, distDir);

  const manifest = manifestOf(pkg.version);
  assertCoreControllerCoverage(root, "Inspector manifest", Object.keys(manifest.controllers));
  const outDir = join(distDir, "inspector");
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const examples = buildExamplesIndex(collectDemoSources(root), manifest);
  writeFileSync(join(outDir, "examples.json"), `${JSON.stringify(examples, null, 2)}\n`);

  const cliPath = join(outDir, "cli_bin.js");
  prepareJavaScript(distDir, cliPath);
  chmodSync(cliPath, 0o755);

  const summary = {
    controllers: Object.keys(manifest.controllers).length,
    examples: Object.keys(examples.examples).length,
  };
  log(
    `Inspector: wrote manifest.json (${summary.controllers} controllers), ` +
      `examples.json (${summary.examples} examples), and prepared cli_bin.js`,
  );
  return summary;
}
