import { join } from "node:path";
import process from "node:process";
import { resolveDistDirectory } from "./controller_entries";
import { runPostbuild } from "./postbuild_steps";

/**
 * Post-build step for the Inspector CLI: checks the build in `dist/` against the
 * sources, writes the bundled manifest and example index, and prepares the
 * JavaScript and the CLI bin ({@link runPostbuild} has the steps).
 *
 * Run via Bun (`bun scripts/postbuild.ts`) so it can import the TypeScript
 * source directly. It works on `dist/`, or on the repository-relative directory
 * given as `--dist <dir>` when tsup was pointed at another output directory. This
 * file only hands the step its directories, so that what the step does is decided,
 * and tested, in `scripts/postbuild_steps.ts`.
 */

// Script-relative, not cwd-relative, so the step also works when invoked from
// outside the repo root (same convention as the other scripts/*.ts).
const root = join(import.meta.dirname, "..");

/** What this run wrote. */
export const summary = runPostbuild(root, resolveDistDirectory(root, process.argv.slice(2)));
