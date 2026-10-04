import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLES_SCHEMA_VERSION } from "../../src/inspector/examples";

const realReadFileSync = fs.readFileSync;
const realStatSync = fs.statSync;

/** Answers reads of the example index bundled next to the CLI with `json`. */
function serveBundledIndex(json: string): void {
  vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) =>
    String(args[0]).endsWith(join("inspector", "examples.json"))
      ? json
      : realReadFileSync(...args)) as typeof fs.readFileSync);
}

/** Makes `stat` of exactly `path` fail with `error`. */
function failStat(path: string, error: NodeJS.ErrnoException): void {
  vi.spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
    if (args[0] === path) throw error;
    return realStatSync(...args);
  }) as typeof fs.statSync);
}

/**
 * Loads the CLI after the filesystem is patched. The CLI imports its `node:fs`
 * functions by name, so the patched module object is republished to named
 * imports and the CLI module is evaluated afresh, which binds whichever the
 * runtime hands out.
 */
async function freshCli(): Promise<typeof import("../../src/inspector/cli")> {
  syncBuiltinESMExports();
  vi.resetModules();
  return await import("../../src/inspector/cli");
}

/**
 * CLI behaviour that depends on what the filesystem hands back: the example
 * index bundled next to the CLI (absent from a source checkout), and an access
 * error a test run as root cannot provoke for real, since root bypasses
 * permission bits.
 */
describe("CLI filesystem answers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it("loads the bundled example index when its format version matches this build", async () => {
    const index = {
      schemaVersion: EXAMPLES_SCHEMA_VERSION,
      examples: {
        "stimeo--demo": {
          file: "app/views/components/demos/demo/_demo.html.erb",
          source: "<div></div>",
        },
      },
    };
    serveBundledIndex(JSON.stringify(index));
    const { loadExamplesIndex } = await freshCli();
    expect(loadExamplesIndex()).toEqual(index);
  });

  it("refuses a bundled example index written for another format version", async () => {
    const foreign = EXAMPLES_SCHEMA_VERSION + 1;
    serveBundledIndex(JSON.stringify({ schemaVersion: foreign, examples: {} }));
    const { loadExamplesIndex } = await freshCli();
    expect(() => loadExamplesIndex()).toThrow(
      `examples.json schema version ${foreign} does not match this build ` +
        `(expected ${EXAMPLES_SCHEMA_VERSION}); reinstall or rebuild the package.`,
    );
  });

  it("reports a path it may not read as permission denied (exit 2)", async () => {
    failStat(
      "locked",
      Object.assign(new Error("EACCES: permission denied, stat 'locked'"), { code: "EACCES" }),
    );
    const { runCli } = await freshCli();
    const lines: string[] = [];
    const code = runCli(["check", "locked"], (line) => lines.push(line));
    expect(code).toBe(2);
    expect(lines.join("\n").split("\n")[0]).toBe('Cannot read path "locked": permission denied.');
  });
});
