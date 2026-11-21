import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import process from "node:process";

/** The persistent watch output, separate from the ordinary shipping build. */
export const WATCH_DIRECTORY = ".stimeo-watch";

/** One immutable output and the private directory its build writes. */
export interface WatchStage {
  readonly generation: string;
  readonly store: string;
  readonly staging: string;
  readonly path: string;
}

/** A reader's fixed generation; its path never follows a later publication. */
export interface WatchGeneration {
  readonly generation: string;
  readonly path: string;
}

/** Accepts only the UUID names generated for watch outputs. */
function validGeneration(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}

/** Creates the directories readers and bind mounts keep open, without replacing them. */
export function initializeWatchStore(root: string): string {
  const store = join(root, WATCH_DIRECTORY);
  mkdirSync(join(store, "staging"), { recursive: true });
  mkdirSync(join(store, "generations"), { recursive: true });
  return store;
}

/** Resolves the writer's lock on the shared Linux filesystem, keyed by the stable store identity. */
export function watchWriterLock(
  root: string,
  lockRoot: string | undefined = process.env.STIMEO_WATCH_LOCK_ROOT,
): string {
  if (lockRoot === undefined || !isAbsolute(lockRoot)) {
    throw new Error(
      "STIMEO_WATCH_LOCK_ROOT must name an absolute shared lock directory on a Linux filesystem. " +
        "All writers and cleanup processes for this checkout must use the same directory.",
    );
  }
  const store = initializeWatchStore(root);
  const { dev, ino } = statSync(store, { bigint: true });
  mkdirSync(lockRoot, { recursive: true });
  return join(lockRoot, `${dev}-${ino}.lock`);
}

/** Allocates a fresh, empty private output for one build. */
export function createWatchStage(root: string): WatchStage {
  const store = initializeWatchStore(root);
  const generation = randomUUID();
  const staging = join(store, "staging", generation);
  const path = join(store, "generations", generation);
  mkdirSync(staging);
  return { generation, store, staging, path };
}

/**
 * Makes a complete output visible, then commits its name with one pointer rename.
 * A failure before the pointer rename leaves the previous reader selection intact.
 * Published outputs and abandoned stages remain until an explicit clean.
 */
export function publishWatchStage(stage: WatchStage): void {
  if (existsSync(stage.path)) throw new Error(`Watch generation already exists: ${stage.path}`);
  renameSync(stage.staging, stage.path);
  const pointer = join(stage.store, `.current-${stage.generation}`);
  writeFileSync(pointer, `${JSON.stringify({ generation: stage.generation })}\n`, { flag: "wx" });
  renameSync(pointer, join(stage.store, "current"));
}

/** Reads the pointer once and returns the concrete output directory it selected. */
export function readWatchGeneration(root: string): WatchGeneration | undefined {
  const store = join(root, WATCH_DIRECTORY);
  let text: string;
  try {
    text = readFileSync(join(store, "current"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const current = JSON.parse(text) as { readonly generation?: unknown } | null;
  if (!validGeneration(current?.generation)) throw new Error("Invalid watch generation pointer");
  const path = join(store, "generations", current.generation);
  if (!statSync(path).isDirectory())
    throw new Error(`Watch generation is not a directory: ${path}`);
  return { generation: current.generation, path };
}

/** Removes watch outputs explicitly, preserving the store identity and mounted directories. */
export function cleanWatchStore(root: string): void {
  const store = initializeWatchStore(root);
  for (const directory of ["staging", "generations"]) {
    const path = join(store, directory);
    for (const entry of readdirSync(path))
      rmSync(join(path, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(store)) {
    if (entry === "current" || entry.startsWith(".current-"))
      rmSync(join(store, entry), { force: true });
  }
}
