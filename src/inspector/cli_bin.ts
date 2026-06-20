import process from "node:process";
import { runCli } from "./cli";

/**
 * Executable entry point for the `stimeo` bin. Kept separate from {@link runCli}
 * so the CLI logic can be imported by tests without triggering `process.exit`.
 * A Node shebang is prepended to the built file by `scripts/postbuild.ts`.
 */
process.exit(runCli(process.argv.slice(2)));
