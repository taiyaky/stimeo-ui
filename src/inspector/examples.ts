import { checkSource } from "./check";
import type { Manifest } from "./types";

/**
 * Bundled example index for the MCP server (`stimeo_example` tool and
 * `stimeo://examples/*` resources).
 *
 * The examples are the official catalog's demo sidecars — the exact markup
 * shown verbatim in each demo's code tab and copy-pasted by users, so they
 * are the closest thing the project has to "verified reference markup".
 * `scripts/postbuild.ts` walks them at build time (`scripts/demo_sources.ts`
 * resolves the supply: the playground catalog in the dev monorepo,
 * `examples/` in the public mirror) and serializes the result of
 * {@link buildExamplesIndex} into `dist/inspector/examples.json`, next to
 * `manifest.json`.
 *
 * {@link buildExamplesIndex} is pure so the mapping and the verification gate
 * are unit-tested directly; the filesystem walk stays in the build scripts.
 */

/** Format version of `examples.json` (bumped on breaking shape changes). */
export const EXAMPLES_SCHEMA_VERSION = 1;

/** One bundled example: the demo markup shown verbatim in the catalog. */
export interface ExampleEntry {
  /**
   * Repo-relative provenance: `playground/.../demos/menu/_demo.html.erb` in
   * the dev monorepo, `examples/menu/_demo.html.erb` in the public mirror.
   */
  readonly file: string;
  /** The HTML/ERB source. */
  readonly source: string;
}

/** The bundled `examples.json`: verified demo markup keyed by controller id. */
export interface ExamplesIndex {
  readonly schemaVersion: number;
  /** Keyed by controller identifier, e.g. `stimeo--menu`. Keys are sorted. */
  readonly examples: Readonly<Record<string, ExampleEntry>>;
}

/** One demo sidecar as discovered on disk by the build script. */
export interface DemoSource {
  /** Demo directory basename (snake_case), e.g. `inline_combobox`. */
  readonly dir: string;
  /** Repo-relative path of the `_demo.html.erb` file. */
  readonly file: string;
  /** The file's contents. */
  readonly source: string;
}

/**
 * Maps a demo directory basename to its controller identifier. Demo dirs use
 * snake_case (`date_range_picker`); controller identifiers are the `stimeo--`
 * prefix plus the kebab-case name (`stimeo--date-range-picker`).
 * {@link buildExamplesIndex} enforces a 1:1 mapping between the demos tree and
 * the manifest.
 */
export function demoDirToControllerId(dir: string): string {
  return `stimeo--${dir.replaceAll("_", "-")}`;
}

/**
 * Controllers temporarily exempted from the demo/manifest bijection. The
 * reverse check fails when an exempted controller gains a demo, so every entry
 * must be removed as soon as its exemption is no longer needed.
 */
export const PENDING_DEMO_CONTROLLERS: ReadonlySet<string> = new Set([]);

/**
 * Builds the bundled example index from the discovered demo sidecars,
 * enforcing two invariants so "verified example" stays true:
 *
 * 1. **Bijection with the manifest.** Every demo dir must map to a known
 *    controller and every controller must have a demo — a mismatch on either
 *    side means the catalog and the library drifted, and the build must fail
 *    loudly rather than silently ship a hole. The only exception is the
 *    explicit `pendingDemos` allowlist ({@link PENDING_DEMO_CONTROLLERS}):
 *    a documented "demo not built yet" deferral, kept honest by the reverse
 *    check (an allowlisted controller acquiring a demo fails the build until
 *    the stale entry is removed).
 * 2. **Check-clean.** Every example must pass {@link checkSource} with no
 *    error-severity diagnostics against the same manifest it ships with.
 *
 * @throws Error listing every violation when an invariant is broken.
 */
export function buildExamplesIndex(
  demos: readonly DemoSource[],
  manifest: Manifest,
  pendingDemos: ReadonlySet<string> = PENDING_DEMO_CONTROLLERS,
): ExamplesIndex {
  const problems: string[] = [];
  const byId = new Map<string, DemoSource>();
  for (const demo of demos) {
    const id = demoDirToControllerId(demo.dir);
    if (!Object.hasOwn(manifest.controllers, id)) {
      problems.push(`demo "${demo.dir}" maps to unknown controller "${id}"`);
      continue;
    }
    if (byId.has(id)) {
      problems.push(`controller "${id}" has more than one demo source`);
      continue;
    }
    byId.set(id, demo);
  }
  for (const id of Object.keys(manifest.controllers)) {
    if (byId.has(id) || pendingDemos.has(id)) continue;
    problems.push(`controller "${id}" has no demo example`);
  }
  for (const id of pendingDemos) {
    if (byId.has(id)) {
      problems.push(
        `controller "${id}" is allowlisted as pending but now has a demo — ` +
          "remove it from PENDING_DEMO_CONTROLLERS",
      );
    }
  }
  for (const [id, demo] of byId) {
    const errors = checkSource(demo.source, manifest).filter((d) => d.severity === "error");
    for (const d of errors) {
      problems.push(`example for "${id}" fails check: ${d.line}:${d.column} ${d.message}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`examples index build failed:\n  - ${problems.join("\n  - ")}`);
  }
  // Null-prototype dictionary, mirroring runCatalogTool: ids derive from
  // directory names, and a hostile "__proto__" would otherwise rewrite the
  // dictionary's prototype instead of storing the entry.
  const examples: Record<string, ExampleEntry> = Object.create(null);
  for (const id of [...byId.keys()].sort()) {
    const demo = byId.get(id);
    if (!demo) continue;
    examples[id] = { file: demo.file, source: demo.source };
  }
  return { schemaVersion: EXAMPLES_SCHEMA_VERSION, examples };
}
