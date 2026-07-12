import { readFileSync } from "node:fs";
import type { Manifest } from "./types";

/**
 * Loading and shape-validation of `manifest.json` files, shared by every
 * consumer that reads a manifest from disk: the CLI (the copy bundled next to
 * `cli_bin.js`), the VS Code extension (a workspace's installed copy or its
 * bundled snapshot), and any future server (MCP) doing the same. Keeping the
 * guard in one place means a corrupt or cross-version manifest degrades the
 * same way everywhere instead of crashing one surface and passing another.
 */

/** Array-typed fields the schema-v5 engine iterates on every controller entry. */
const CONTROLLER_ARRAY_FIELDS = [
  "targets",
  "values",
  "actions",
  "events",
  "requiredTargets",
  "a11y",
  "keyboard",
  "managedAria",
  "compositions",
] as const;

/**
 * Structural guard for a parsed manifest. A reader bundles the engine of one
 * schema version but may load a manifest written by another (e.g. an app
 * installing a package whose manifest predates `keyboard`/`managedAria`), and
 * the engine iterates those arrays unconditionally — an unvalidated manifest
 * would crash every check instead of failing cleanly. Shape-based rather than
 * a strict `schemaVersion` equality so additive future versions keep working.
 */
export function isCompatibleManifest(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.schemaVersion !== "number" || typeof record.packageVersion !== "string") {
    return false;
  }
  const controllers = record.controllers;
  if (typeof controllers !== "object" || controllers === null || Array.isArray(controllers)) {
    return false;
  }
  for (const entry of Object.values(controllers as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) return false;
    for (const field of CONTROLLER_ARRAY_FIELDS) {
      if (!Array.isArray((entry as Record<string, unknown>)[field])) return false;
    }
  }
  return true;
}

/**
 * Reads and parses one manifest file; throws on missing/corrupt files and on
 * manifests whose shape the bundled engine cannot consume.
 */
export function readManifestFile(path: string): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isCompatibleManifest(parsed)) {
    throw new Error(`Incompatible or malformed manifest: ${path}`);
  }
  return parsed;
}
