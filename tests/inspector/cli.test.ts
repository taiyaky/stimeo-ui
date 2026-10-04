import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { buildCheckReport, formatGithubAnnotation, runCli } from "../../src/inspector/cli";
import type { ControllerManifest, FileReport, Manifest } from "../../src/inspector/types";

/** Collects CLI output for assertions, optionally with an injected manifest. */
function capture(argv: string[], load?: () => Manifest): { code: number; output: string } {
  const lines: string[] = [];
  const code = runCli(argv, (line) => lines.push(line), load);
  return { code, output: lines.join("\n") };
}

/** A controller entry that declares nothing and requires nothing. */
const emptyController: ControllerManifest = {
  targets: [],
  values: [],
  valueConstraints: [],
  valueRelations: [],
  actionParams: [],
  actions: [],
  events: [],
  requiredTargets: [],
  conditionalTargets: [],
  templateRoots: [],
  requiredActions: [],
  actionCompletion: [],
  a11y: [],
  keyboard: [],
  hosts: [],
  managedAria: [],
  compositions: [],
  companions: [],
  targetDeclarations: [],
  cardinality: [],
  forbiddenAria: [],
};

/** A minimal manifest for commands that read it without the post-build bundle. */
const fakeManifest: Manifest = {
  schemaVersion: 5,
  packageVersion: "9.9.9",
  controllers: {
    "stimeo--demo": {
      ...emptyController,
      targets: ["panel"],
      values: ["open"],
      actions: ["toggle"],
      events: ["changed"],
      requiredTargets: ["panel"],
    },
  },
};

/** Writes the given files into a fresh temporary directory and hands its path to `body`. */
function withFiles(files: Record<string, string>, body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "stimeo-cli-"));
  try {
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Tests CLI argument handling, usage, exit codes, and command output with an
 * injected manifest. `check.test.ts` covers the checking pipeline separately.
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
    expect(output.split("\n")[0]).toBe(
      'Cannot read path "no/such/path-xyz": no such file or directory.',
    );
  });

  it("reports any other unreadable path with the platform's own reason (exit 2)", () => {
    withFiles({ "page.html": "<div></div>" }, (dir) => {
      // A path beneath a regular file fails with ENOTDIR, for which the CLI has no
      // fixed phrase and passes the platform's message through.
      const beneathFile = join(dir, "page.html", "child.html");
      let failure: NodeJS.ErrnoException | undefined;
      try {
        statSync(beneathFile);
      } catch (error) {
        failure = error as NodeJS.ErrnoException;
      }
      expect(failure?.code).toBe("ENOTDIR");
      const { code, output } = capture(["check", beneathFile], () => fakeManifest);
      expect(code).toBe(2);
      expect(output.split("\n")[0]).toBe(`Cannot read path "${beneathFile}": ${failure?.message}.`);
    });
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
    expect(output).toContain("schema v5");
  });

  it("catalog lists every non-empty name list under its controller and omits empty ones", () => {
    const manifest: Manifest = {
      ...fakeManifest,
      controllers: { ...fakeManifest.controllers, "stimeo--bare": emptyController },
    };
    const { code, output } = capture(["catalog"], () => manifest);
    expect(code).toBe(0);
    expect(output.split("\n")).toEqual([
      "Stimeo UI catalog — 2 controller(s) (schema v5, package 9.9.9)",
      "",
      "stimeo--bare",
      "stimeo--demo",
      "  targets:  panel",
      "  values:   open",
      "  actions:  toggle",
      "  events:   changed",
    ]);
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

  it("prints each file's diagnostics under its path, with a fix line only when one exists", () => {
    withFiles(
      {
        "bad.html": `<div data-controller="stimeo--demo"><span data-stimeo--demo-target="bogus"></span></div>`,
      },
      (dir) => {
        const file = join(dir, "bad.html");
        const { code, output } = capture(["check", file], () => fakeManifest);
        expect(code).toBe(1);
        const lines = output.split("\n");
        expect(lines[0]).toBe(relative(process.cwd(), file));
        expect(lines.slice(1).every((line) => !line.includes("→"))).toBe(true);
        expect(lines.at(-1)).toMatch(
          /^✖ \d+ problem\(s\) \([1-9]\d* error\(s\), \d+ warning\(s\)\)\.$/,
        );
      },
    );
  });

  it("separates each file's block from the next path and from the summary by a blank line", () => {
    const bad = `<div data-controller="stimeo--demo"><span data-stimeo--demo-target="bogus"></span></div>`;
    withFiles({ "a.html": bad, "b.html": bad }, (dir) => {
      const { output } = capture(["check", dir], () => fakeManifest);
      const lines = output.split("\n");
      const second = lines.indexOf(relative(process.cwd(), join(dir, "b.html")));
      expect(second).toBeGreaterThan(1);
      expect(lines[second - 1]).toBe("");
      expect(lines.at(-2)).toBe("");
    });
  });

  it("check prints a one-line success summary and exits 0 when no file has a problem", () => {
    withFiles(
      {
        "ok.html": `<div data-controller="stimeo--demo"><span data-stimeo--demo-target="panel"></span></div>`,
      },
      (dir) => {
        const { code, output } = capture(["check", join(dir, "ok.html")], () => fakeManifest);
        expect(output).toBe("✓ Checked 1 file(s); no problems found.");
        expect(code).toBe(0);
      },
    );
  });

  it("collects extension-matching files case-insensitively (parity with the editor)", () => {
    // The VS Code extension and the CLI share `isCheckableFile`; a file the
    // editor diagnoses must never slip past CI because of extension casing.
    const dir = mkdtempSync(join(tmpdir(), "stimeo-cli-"));
    writeFileSync(join(dir, "LEGACY.HTM"), `<div data-controller="stimeo--nope"></div>`);
    try {
      const { code, output } = capture(["check", dir], () => fakeManifest);
      expect(code).toBe(1);
      expect(output).toContain("unknown-controller");
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

  it("check --json exits 1 when the report holds an error", () => {
    withFiles(
      {
        "bad.html": `<div data-controller="stimeo--demo"><span data-stimeo--demo-target="bogus"></span></div>`,
      },
      (dir) => {
        const { code, output } = capture(
          ["check", "--json", join(dir, "bad.html")],
          () => fakeManifest,
        );
        const report = JSON.parse(output);
        expect(report.ok).toBe(false);
        expect(report.errorCount).toBeGreaterThan(0);
        expect(code).toBe(1);
      },
    );
  });

  it("attaches the missing-announcer warning to the speaking file alone and exits 0", () => {
    // A run where one file speaks through the shared announcer and no file seats
    // one: the warning belongs to the speaker, and warnings never fail the run.
    const manifest: Manifest = {
      ...fakeManifest,
      controllers: { ...fakeManifest.controllers, "stimeo--flash": emptyController },
    };
    withFiles(
      {
        "a.html": `<div data-controller="stimeo--demo"><p data-stimeo--demo-target="panel"></p></div>`,
        "b.html": `<div data-controller="stimeo--flash"></div>`,
      },
      (dir) => {
        const { code, output } = capture(["check", dir], () => manifest);
        const lines = output.split("\n");
        expect(lines.filter((line) => line.endsWith(".html"))).toEqual([
          relative(process.cwd(), join(dir, "b.html")),
        ]);
        expect(lines.filter((line) => line.includes("[missing-announcer]"))).toHaveLength(1);
        expect(lines.at(-1)).toBe("✖ 1 problem(s) (0 error(s), 1 warning(s)).");
        expect(code).toBe(0);
      },
    );
  });

  it("check --github emits workflow-command annotations", () => {
    const dir = mkdtempSync(join(tmpdir(), "stimeo-cli-"));
    const file = join(dir, "bad.html");
    writeFileSync(
      file,
      `<div data-controller="stimeo--demo"><span data-stimeo--demo-target="bogus"></span></div>`,
    );
    try {
      const { code, output } = capture(["check", "--github", file], () => fakeManifest);
      expect(code).toBe(1);
      expect(output).toContain("::error file=");
      expect(output).toContain("title=Stimeo Inspector [unknown-target]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects --json combined with --github", () => {
    const { code, output } = capture(["check", "--json", "--github", "whatever.html"]);
    expect(code).toBe(2);
    expect(output).toContain("mutually exclusive");
  });
});

describe("formatGithubAnnotation", () => {
  it("escapes message data and property values per the workflow-command rules", () => {
    const line = formatGithubAnnotation("a,b:c.erb", {
      code: "missing-aria",
      severity: "error",
      message: "50% broken\nnext",
      line: 3,
      column: 4,
    });
    expect(line).toBe(
      "::error file=a%2Cb%3Ac.erb,line=3,col=4,title=Stimeo Inspector [missing-aria]::50%25 broken%0Anext",
    );
  });

  it("maps warnings to ::warning and appends the suggestion", () => {
    const line = formatGithubAnnotation("x.erb", {
      code: "unresolved-idref",
      severity: "warning",
      message: "m",
      line: 1,
      column: 1,
      suggestion: 'Did you mean "t"?',
    });
    expect(line).toContain("::warning ");
    expect(line).toContain('m → Did you mean "t"?');
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
