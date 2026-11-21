import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Source suffix shared by every core controller module. */
const CONTROLLER_SUFFIX = "_controller.ts";

/**
 * Returns every core controller source as a sorted, repository-relative tsup entry.
 */
export function coreControllerEntries(root: string): string[] {
  return readdirSync(join(root, "src/controllers"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(CONTROLLER_SUFFIX))
    .map((entry) => `src/controllers/${entry.name}`)
    .sort();
}

/** Public Stimulus identifiers derived from the core controller source filenames. */
export function coreControllerIdentifiers(root: string): string[] {
  return coreControllerEntries(root).map((entry) => {
    const filename = entry.slice("src/controllers/".length, -CONTROLLER_SUFFIX.length);
    return `stimeo--${filename.replaceAll("_", "-")}`;
  });
}

/**
 * Expected JavaScript and declaration artifacts for one core controller source, in
 * `distDir` (the repository's `dist/` unless another output directory is given).
 */
export function coreControllerArtifactPaths(
  root: string,
  sourceEntry: string,
  distDir: string = join(root, "dist"),
): string[] {
  const relativeSource = sourceEntry.replace(/^src\//, "").replace(/\.ts$/, "");
  return [join(distDir, `${relativeSource}.js`), join(distDir, `${relativeSource}.d.ts`)];
}

/**
 * Resolves the build output directory. Uses `dist/` by default. Pass `--dist <dir>`
 * or `--dist=<dir>` to select another directory inside the repository.
 *
 * @throws on any other argument, a missing value, or a directory outside `root` or
 *   equal to it.
 */
export function resolveDistDirectory(root: string, args: readonly string[]): string {
  let dir = "dist";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--dist") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--dist needs a directory");
      }
      dir = value;
      index += 1;
    } else if (arg.startsWith("--dist=")) {
      dir = arg.slice("--dist=".length);
    } else {
      throw new Error(`unknown argument "${arg}" (expected --dist <dir>)`);
    }
  }
  const resolved = resolve(root, dir);
  const inside = relative(root, resolved);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`--dist must name a directory inside the repository, not "${dir}"`);
  }
  return resolved;
}

/**
 * Fails when source-derived identifiers and the Core registry differ.
 *
 * `registerStimeo()` and Inspector reflection both consume this registry, so
 * exact parity prevents a filesystem-only subpath or a registry-only import.
 */
export function assertCoreControllerRegistry(root: string, registryIdentifiers: string[]): void {
  const sourceIdentifiers = coreControllerIdentifiers(root);
  const registry = [...registryIdentifiers].sort();
  const registrySet = new Set(registry);
  const sourceSet = new Set(sourceIdentifiers);
  const missingFromRegistry = sourceIdentifiers.filter(
    (identifier) => !registrySet.has(identifier),
  );
  const missingSource = registry.filter((identifier) => !sourceSet.has(identifier));

  if (missingFromRegistry.length === 0 && missingSource.length === 0) return;

  const details = [
    ...missingFromRegistry.map((identifier) => `missing from registry: ${identifier}`),
    ...missingSource.map((identifier) => `missing source controller: ${identifier}`),
  ];
  throw new Error(`Core controller source/registry mismatch:\n${details.join("\n")}`);
}

/** Fails when a source-derived core identifier is absent from a downstream catalogue. */
export function assertCoreControllerCoverage(
  root: string,
  catalogue: string,
  identifiers: string[],
): void {
  const available = new Set(identifiers);
  const missing = coreControllerIdentifiers(root).filter(
    (identifier) => !available.has(identifier),
  );
  if (missing.length > 0) {
    throw new Error(`Missing core controllers from ${catalogue}:\n${missing.join("\n")}`);
  }
}

/**
 * Fails when a public `stimeo-ui/controllers/*` source lacks a built artifact.
 *
 * This runs after tsup so the wildcard package export cannot silently point at
 * a missing JavaScript module or declaration file. `distDir` is the output directory
 * that tsup wrote, `dist/` by default.
 */
export function assertCoreControllerArtifacts(
  root: string,
  distDir: string = join(root, "dist"),
): void {
  const missing = coreControllerEntries(root)
    .flatMap((entry) => coreControllerArtifactPaths(root, entry, distDir))
    .filter((artifact) => !existsSync(artifact))
    .map((artifact) => relative(root, artifact));

  if (missing.length > 0) {
    throw new Error(`Missing core controller build artifacts:\n${missing.join("\n")}`);
  }
}
