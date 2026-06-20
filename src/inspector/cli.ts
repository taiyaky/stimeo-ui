import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkSource } from "./check";
import type { CheckReport, Diagnostic, FileReport, Manifest } from "./types";

/**
 * `stimeo check <path...>` / `stimeo catalog` — static checker and catalog
 * for `stimeo--*` markup.
 *
 * This is the executable entry point bundled as the `stimeo` npm bin. It is a
 * thin shell around {@link checkSource} and the bundled manifest: discover
 * files, run the engine, format the report, and set the exit code. All checking
 * logic lives in the engine so the CLI and internal CI use exactly the same
 * code path. Both commands accept `--json` to emit machine-readable output for
 * editor tooling and CI.
 */

const FILE_EXTENSIONS = new Set([".erb", ".html", ".htm"]);

/** Loads the manifest bundled next to this file (`dist/inspector/manifest.json`). */
function loadManifest(): Manifest {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(here, "manifest.json");
  const raw = readFileSync(manifestPath, "utf8");
  return JSON.parse(raw) as Manifest;
}

/** Recursively collects checkable files under the given path. */
function collectFiles(target: string, out: string[]): void {
  const stat = statSync(target);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(target)) {
      collectFiles(join(target, entry), out);
    }
    return;
  }
  // `.html.erb` ends with `.erb`; `extname` returns the final extension only.
  if (FILE_EXTENSIONS.has(extname(target))) out.push(target);
}

/** Builds a report for a single file. */
function checkFile(file: string, manifest: Manifest): FileReport {
  const source = readFileSync(file, "utf8");
  return { file, diagnostics: checkSource(source, manifest) };
}

/**
 * Formats one diagnostic, e.g. `  13:5  error  message  [code]`. A stage-4
 * suggestion, when present, is appended on its own indented `→` line.
 */
function formatDiagnostic(d: Diagnostic): string {
  const where = `${d.line}:${d.column}`.padEnd(7);
  const head = `  ${where} ${d.severity.padEnd(7)} ${d.message} [${d.code}]`;
  return d.suggestion ? `${head}\n          → ${d.suggestion}` : head;
}

/**
 * Aggregates per-file reports into the structured {@link CheckReport}, keeping
 * only files that produced diagnostics and tallying severities. Pure (no I/O),
 * so the JSON output contract is unit-tested directly.
 */
export function buildCheckReport(
  reports: readonly FileReport[],
  checkedFiles: number,
): CheckReport {
  let errorCount = 0;
  let warningCount = 0;
  const files: FileReport[] = [];
  for (const report of reports) {
    if (report.diagnostics.length === 0) continue;
    files.push(report);
    for (const d of report.diagnostics) {
      if (d.severity === "error") errorCount++;
      else warningCount++;
    }
  }
  return { ok: errorCount === 0, checkedFiles, errorCount, warningCount, files };
}

/**
 * Renders the manifest as a human-readable catalog: one block per controller
 * listing its non-empty target/value/action/event names. `--json` emits the
 * raw manifest instead, for machine consumption.
 */
export function catalogSummary(manifest: Manifest): string[] {
  const ids = Object.keys(manifest.controllers).sort();
  const lines = [
    `Stimeo UI catalog — ${ids.length} controller(s) (schema v${manifest.schemaVersion}, package ${manifest.packageVersion})`,
    "",
  ];
  for (const id of ids) {
    const c = manifest.controllers[id];
    if (!c) continue;
    lines.push(id);
    if (c.targets.length > 0) lines.push(`  targets:  ${c.targets.join(", ")}`);
    if (c.values.length > 0) lines.push(`  values:   ${c.values.join(", ")}`);
    if (c.actions.length > 0) lines.push(`  actions:  ${c.actions.join(", ")}`);
    if (c.events.length > 0) lines.push(`  events:   ${c.events.join(", ")}`);
  }
  return lines;
}

const USAGE = `stimeo — static checker and catalog for Stimeo UI markup

Usage:
  stimeo check [--json] <path...>   Check HTML/ERB files (or directories) for
                                     unknown or misused stimeo--* controllers,
                                     targets, values and action methods.
  stimeo catalog [--json]           Print the official controller catalog
                                     (identifiers, targets, values, actions,
                                     events).

--json makes either command emit machine-readable JSON (for tooling / MCP):
check prints a CheckReport, catalog prints the raw manifest.
Exit code is 1 when any error is found.`;

/**
 * Runs the CLI.
 *
 * @param argv - Arguments after the node executable and script (`process.argv.slice(2)`).
 * @param write - Output sink (defaults to stdout); injectable for tests.
 * @param load - Manifest loader (defaults to the bundled manifest); injectable for tests.
 * @returns Process exit code (0 = clean, 1 = errors found, 2 = usage error).
 */
export function runCli(
  argv: readonly string[],
  write: (line: string) => void = console.log,
  load: () => Manifest = loadManifest,
): number {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    write(USAGE);
    return command === undefined ? 2 : 0;
  }

  const json = rest.includes("--json");

  if (command === "catalog") {
    const manifest = load();
    if (json) {
      write(JSON.stringify(manifest, null, 2));
    } else {
      for (const line of catalogSummary(manifest)) write(line);
    }
    return 0;
  }

  if (command !== "check") {
    write(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }

  const paths = rest.filter((arg) => !arg.startsWith("-"));
  if (paths.length === 0) {
    write(`No paths given.\n\n${USAGE}`);
    return 2;
  }

  const files: string[] = [];
  for (const path of paths) {
    try {
      collectFiles(path, files);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const reason =
        code === "ENOENT"
          ? "no such file or directory"
          : code === "EACCES"
            ? "permission denied"
            : ((err as Error).message ?? "cannot access path");
      write(`Cannot read path "${path}": ${reason}.\n\n${USAGE}`);
      return 2;
    }
  }

  const manifest = load();
  const cwd = process.cwd();
  const reports: FileReport[] = [];
  for (const file of files.sort()) {
    reports.push({
      file: relative(cwd, file) || file,
      diagnostics: checkFile(file, manifest).diagnostics,
    });
  }
  const summary = buildCheckReport(reports, files.length);

  if (json) {
    write(JSON.stringify(summary, null, 2));
    return summary.errorCount > 0 ? 1 : 0;
  }

  for (const report of summary.files) {
    write(report.file);
    for (const d of report.diagnostics) write(formatDiagnostic(d));
    write("");
  }

  const total = summary.errorCount + summary.warningCount;
  if (total === 0) {
    write(`✓ Checked ${summary.checkedFiles} file(s); no problems found.`);
    return 0;
  }
  write(
    `✖ ${total} problem(s) (${summary.errorCount} error(s), ${summary.warningCount} warning(s)).`,
  );
  return summary.errorCount > 0 ? 1 : 0;
}
