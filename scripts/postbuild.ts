import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { buildManifest } from "../src/inspector/manifest";

/**
 * Post-build step for the Inspector CLI.
 *
 * tsup builds `dist/inspector/cli_bin.js`; this script then:
 *   1. Generates the bundled manifest JSON from the reflected controllers, so
 *      the installed CLI checks against the exact version it ships with.
 *   2. Prepends a Node shebang to the CLI and marks it executable so the
 *      `stimeo` bin runs directly.
 *
 * Run via Bun (`bun scripts/postbuild.ts`) so it can import the TypeScript
 * source directly.
 */

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

const manifest = buildManifest(pkg.version);
const outDir = join(root, "dist", "inspector");
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const cliPath = join(outDir, "cli_bin.js");
const shebang = "#!/usr/bin/env node\n";
const cli = readFileSync(cliPath, "utf8");
if (!cli.startsWith(shebang)) writeFileSync(cliPath, shebang + cli);
chmodSync(cliPath, 0o755);

console.log(
  `Inspector: wrote manifest.json (${Object.keys(manifest.controllers).length} controllers) and prepared cli_bin.js`,
);
