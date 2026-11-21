/**
 * Builds immutable watch generations under the writer lock held by `bun run dev`.
 * Only successful builds from unchanged inputs replace the watch pointer; ordinary
 * `dist/` outputs and previously selected generations remain available to readers.
 * Declaration-emission failures fail a generation; typecheck reports plain type errors.
 */

import { watch } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { startDev } from "./dev_loop";

/**
 * The running watcher. This file only hands it the process it runs in — each adapter
 * one expression — so that what the watcher does is decided, and tested, in
 * `scripts/dev_loop.ts`.
 */
export const dev = startDev({
  root: join(import.meta.dirname, ".."),
  runtime: process.execPath,
  log: (line) => console.log(`[dev] ${line}`),
  watch: (dir, recursive, onChange, onError) =>
    watch(dir, { recursive }, onChange).on("error", onError),
  onSignal: (signal, handler) => process.on(signal, handler),
  onExit: (handler) => process.on("exit", handler),
  exit: (code) => process.exit(code),
});
