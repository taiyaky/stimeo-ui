import process from "node:process";
import { loadExamplesIndex, loadManifest, runCli } from "./cli";
import { runMcpServer } from "./mcp/server";

/**
 * Executable entry point for the `stimeo` bin. Kept separate from {@link runCli}
 * so the CLI logic can be imported by tests without triggering `process.exit`.
 * A Node shebang is prepended to the built file by `scripts/postbuild.ts`.
 *
 * `stimeo mcp` is dispatched here rather than inside {@link runCli} because it
 * is not a run-to-completion command: it starts a resident stdio server that
 * only exits when the client closes stdin. Everything else keeps the original
 * synchronous exit-code contract.
 */
const argv = process.argv.slice(2);

if (argv[0] === "mcp") {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.exit(runCli(["--help"]));
  }
  // A disappearing client closes our stdout pipe; exit quietly on EPIPE
  // instead of crashing with an unhandled stream error.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    process.exit(error.code === "EPIPE" ? 0 : 1);
  });
  runMcpServer({
    input: process.stdin,
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    load: () => ({ manifest: loadManifest(), examples: loadExamplesIndex() }),
    logError: (message) => {
      process.stderr.write(`stimeo mcp: ${message}\n`);
    },
  }).then(
    // Set the exit code instead of calling process.exit so any buffered
    // stdout responses are flushed before the process ends.
    () => {
      process.exitCode = 0;
    },
    (error: unknown) => {
      process.stderr.write(
        `stimeo mcp: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
} else {
  process.exit(runCli(argv));
}
