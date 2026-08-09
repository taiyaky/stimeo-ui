import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoSource } from "../src/inspector/examples";

/**
 * Discovery of the demo sidecars that feed the bundled example index
 * (`dist/inspector/examples.json`).
 *
 * Shared by `scripts/postbuild.ts` (build-time generation) and the
 * integration contract in `tests/inspector/examples.test.ts`, so both walk
 * the tree identically. Two roots exist: the sidecars live under `playground/`
 * when that directory is present and under `examples/` otherwise, and
 * {@link resolveDemosRoot} picks whichever exists.
 */

/** Demo sidecar root under `playground/`, when that directory is present. */
export const DEV_DEMOS_DIR = join("playground", "app", "views", "components", "demos");
/** Demo sidecar root used when `playground/` is absent. */
export const PUBLIC_DEMOS_DIR = "examples";

/**
 * Resolves the repo-relative demo root for the tree at `root`, preferring
 * {@link DEV_DEMOS_DIR} and falling back to {@link PUBLIC_DEMOS_DIR}.
 *
 * @throws Error when neither root exists — the example index cannot be built
 *   without a demo supply, so callers must fail loudly.
 */
export function resolveDemosRoot(root: string): string {
  for (const candidate of [DEV_DEMOS_DIR, PUBLIC_DEMOS_DIR]) {
    if (existsSync(join(root, candidate))) return candidate;
  }
  throw new Error(
    `no demo sidecar root under "${root}" (looked for "${DEV_DEMOS_DIR}" and "${PUBLIC_DEMOS_DIR}")`,
  );
}

/**
 * Reads every demo sidecar under the resolved demo root: one subdirectory per
 * demo, each holding a `_demo.html.erb` file. The returned `file` provenance
 * stays repo-relative so it is meaningful in the bundled `examples.json`.
 */
export function collectDemoSources(
  root: string,
  demosDir: string = resolveDemosRoot(root),
): DemoSource[] {
  return readdirSync(join(root, demosDir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = join(demosDir, entry.name, "_demo.html.erb");
      return { dir: entry.name, file, source: readFileSync(join(root, file), "utf8") };
    });
}
