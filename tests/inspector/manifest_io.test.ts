import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest } from "../../src/inspector/manifest";
import { isCompatibleManifest, readManifestFile } from "../../src/inspector/manifest_io";

/**
 * Tests for the manifest loader the CLI, the MCP server and the editor extension
 * share. The structural guard answers `false` for any parsed JSON value the
 * bundled engine cannot iterate, and never throws on one; the file reader turns
 * that answer into a single `Error` that names the file, while a file that is
 * not JSON at all surfaces the parser's `SyntaxError`.
 */

/** A generated manifest serialized the way the build writes it to disk. */
const MANIFEST_JSON = JSON.stringify(buildManifest("1.2.3"));

/** A fresh copy of the generated manifest as a reader sees it after parsing. */
const parsedManifest = (): Record<string, unknown> =>
  JSON.parse(MANIFEST_JSON) as Record<string, unknown>;

/** One generated controller entry, as plain parsed JSON. */
const parsedEntry = (): unknown => {
  const controllers = parsedManifest().controllers as Record<string, unknown>;
  const entry = controllers["stimeo--switch"];
  if (entry === undefined) throw new Error("Missing switch manifest entry");
  return entry;
};

/** Runs `run` and returns what it threw; fails when it returns normally. */
function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Expected an Error instance, got ${String(error)}`);
  }
  throw new Error("Expected the call to throw");
}

describe("isCompatibleManifest", () => {
  it("accepts a generated manifest and a manifest with no controllers", () => {
    expect(isCompatibleManifest(parsedManifest())).toBe(true);
    expect(
      isCompatibleManifest({ schemaVersion: 1, packageVersion: "0.0.0", controllers: {} }),
    ).toBe(true);
  });

  it("returns false for a parsed value that is not a JSON object", () => {
    for (const value of [null, 14, "manifest", true, []]) {
      expect(isCompatibleManifest(value)).toBe(false);
    }
  });

  it("rejects a schemaVersion or packageVersion of the wrong type", () => {
    expect(isCompatibleManifest({ ...parsedManifest(), schemaVersion: 14 })).toBe(true);
    for (const override of [
      { schemaVersion: "14" },
      { schemaVersion: undefined },
      { packageVersion: 123 },
      { packageVersion: undefined },
    ]) {
      expect(isCompatibleManifest({ ...parsedManifest(), ...override })).toBe(false);
    }
  });

  it("returns false for a controllers field that is not a keyed object", () => {
    expect(isCompatibleManifest({ ...parsedManifest(), controllers: {} })).toBe(true);
    for (const controllers of [[], [parsedEntry()], null, undefined]) {
      expect(isCompatibleManifest({ ...parsedManifest(), controllers })).toBe(false);
    }
  });

  it("returns false for a controller entry that is null", () => {
    const withEntry = (entry: unknown) => ({
      ...parsedManifest(),
      controllers: { "stimeo--switch": entry },
    });
    expect(isCompatibleManifest(withEntry(parsedEntry()))).toBe(true);
    expect(isCompatibleManifest(withEntry(null))).toBe(false);
  });
});

describe("readManifestFile", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stimeo-manifest-io-"));
    path = join(dir, "manifest.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the parsed manifest of a compatible file", () => {
    const manifest = parsedManifest();
    writeFileSync(path, JSON.stringify(manifest));
    expect(readManifestFile(path)).toEqual(manifest);
  });

  it("throws one Error naming the file for JSON the engine cannot consume", () => {
    const incompatible = [
      null,
      [],
      { ...parsedManifest(), schemaVersion: "14" },
      { ...parsedManifest(), controllers: [] },
      { ...parsedManifest(), controllers: null },
      { ...parsedManifest(), controllers: { "stimeo--switch": null } },
    ];
    for (const content of incompatible) {
      writeFileSync(path, JSON.stringify(content));
      const error = thrownBy(() => readManifestFile(path));
      expect(error.constructor).toBe(Error);
      expect(error.message).toBe(`Incompatible or malformed manifest: ${path}`);
    }
  });

  it("surfaces the parser's SyntaxError for a file that is not JSON", () => {
    for (const content of ["not json", '{"schemaVersion": 14,']) {
      writeFileSync(path, content);
      expect(thrownBy(() => readManifestFile(path))).toBeInstanceOf(SyntaxError);
    }
  });

  it("surfaces the file system error for a missing file", () => {
    const error = thrownBy(() => readManifestFile(join(dir, "missing.json")));
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});
