import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Source suffix shared by every public core controller module. */
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

/** Expected JavaScript and declaration artifacts for one core controller source. */
export function coreControllerArtifactPaths(root: string, sourceEntry: string): string[] {
  const relativeSource = sourceEntry.replace(/^src\//, "").replace(/\.ts$/, "");
  return [join(root, "dist", `${relativeSource}.js`), join(root, "dist", `${relativeSource}.d.ts`)];
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
 * a missing JavaScript module or declaration file.
 */
export function assertCoreControllerArtifacts(root: string): void {
  const missing = coreControllerEntries(root)
    .flatMap((entry) => coreControllerArtifactPaths(root, entry))
    .filter((artifact) => !existsSync(artifact))
    .map((artifact) => relative(root, artifact));

  if (missing.length > 0) {
    throw new Error(`Missing core controller build artifacts:\n${missing.join("\n")}`);
  }
}
