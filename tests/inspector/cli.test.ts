import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCheckReport, runCli } from "../../src/inspector/cli";
import type { FileReport, Manifest } from "../../src/inspector/types";

/** Collects CLI output for assertions, optionally with an injected manifest. */
function capture(argv: string[], load?: () => Manifest): { code: number; output: string } {
  const lines: string[] = [];
  const code = runCli(argv, (line) => lines.push(line), load);
  return { code, output: lines.join("\n") };
}

/** A minimal manifest for commands that read it without the post-build bundle. */
const fakeManifest: Manifest = {
  schemaVersion: 2,
  packageVersion: "9.9.9",
  controllers: {
    "stimeo--demo": {
      targets: ["panel"],
      values: ["open"],
      actions: ["toggle"],
      events: ["changed"],
      requiredTargets: ["panel"],
      a11y: [],
    },
  },
};

/**
 * Tests for CLI argument handling. The actual checking pipeline is covered by
 * `check.test.ts`; here we verify usage/exit-code behavior that returns before
 * the bundled manifest is loaded (which only exists post-build).
 */
describe("runCli", () => {
  it("prints usage and exits 2 when no command is given", () => {
    const { code, output } = capture([]);
    expect(code).toBe(2);
    expect(output).toContain("Usage:");
  });

  it("prints usage and exits 0 for --help", () => {
    const { code, output } = capture(["--help"]);
    expect(code).toBe(0);
    expect(output).toContain("stimeo check");
    expect(output).toContain("stimeo catalog");
  });

  it("rejects an unknown command with exit 2", () => {
    const { code, output } = capture(["frobnicate"]);
    expect(code).toBe(2);
    expect(output).toContain('Unknown command "frobnicate"');
  });

  it("requires at least one path for check", () => {
    const { code, output } = capture(["check"]);
    expect(code).toBe(2);
    expect(output).toContain("No paths given");
  });

  it("reports a usage error (exit 2) for a nonexistent path", () => {
    const { code, output } = capture(["check", "no/such/path-xyz"]);
    expect(code).toBe(2);
    expect(output).toContain('Cannot read path "no/such/path-xyz"');
    expect(output).toContain("no such file or directory");
  });

  it("still requires a path for check even with --json", () => {
    const { code, output } = capture(["check", "--json"]);
    expect(code).toBe(2);
    expect(output).toContain("No paths given");
  });

  it("catalog prints a human-readable controller catalog", () => {
    const { code, output } = capture(["catalog"], () => fakeManifest);
    expect(code).toBe(0);
    expect(output).toContain("stimeo--demo");
    expect(output).toContain("actions:  toggle");
    expect(output).toContain("schema v2");
  });

  it("catalog --json prints the raw manifest as parseable JSON", () => {
    const { code, output } = capture(["catalog", "--json"], () => fakeManifest);
    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual(fakeManifest);
  });

  it("check reports diagnostics for a file and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "stimeo-cli-"));
    const file = join(dir, "bad.html");
    writeFileSync(
      file,
      `<div data-controller="stimeo--demo"><span data-stimeo--demo-target="bogus"></span></div>`,
    );
    try {
      const { code, output } = capture(["check", file], () => fakeManifest);
      expect(code).toBe(1);
      expect(output).toContain("unknown-target");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders a stage-4 fix suggestion on its own line", () => {
    const dir = mkdtempSync(join(tmpdir(), "stimeo-cli-"));
    const file = join(dir, "typo.html");
    writeFileSync(
      file,
      `<div data-controller="stimeo--demo"><span data-stimeo--demo-target="panl"></span></div>`,
    );
    try {
      const { output } = capture(["check", file], () => fakeManifest);
      expect(output).toContain("unknown-target");
      expect(output).toContain('→ Did you mean "panel"?');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("check --json emits a CheckReport for a checked file", () => {
    const dir = mkdtempSync(join(tmpdir(), "stimeo-cli-"));
    const file = join(dir, "ok.html");
    writeFileSync(
      file,
      `<div data-controller="stimeo--demo"><span data-stimeo--demo-target="panel"></span></div>`,
    );
    try {
      const { code, output } = capture(["check", "--json", file], () => fakeManifest);
      const report = JSON.parse(output);
      expect(report.checkedFiles).toBe(1);
      expect(report.ok).toBe(true);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildCheckReport", () => {
  it("tallies severities and keeps only files with diagnostics", () => {
    const reports: FileReport[] = [
      {
        file: "bad.erb",
        diagnostics: [
          { code: "unknown-action-method", severity: "error", message: "m", line: 1, column: 2 },
          { code: "orphan-target", severity: "warning", message: "n", line: 3, column: 4 },
        ],
      },
      { file: "clean.erb", diagnostics: [] },
    ];
    const report = buildCheckReport(reports, 5);
    expect(report).toEqual({
      ok: false,
      checkedFiles: 5,
      errorCount: 1,
      warningCount: 1,
      files: [reports[0]],
    });
  });

  it("is ok with empty input", () => {
    expect(buildCheckReport([], 3)).toEqual({
      ok: true,
      checkedFiles: 3,
      errorCount: 0,
      warningCount: 0,
      files: [],
    });
  });
});
