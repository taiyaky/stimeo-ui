/**
 * Runs whole watch builds from unchanged inputs and publishes immutable generations.
 * Each step has its own process group. On interruption the loop signals any active
 * group and waits for the step to settle before the next generation starts. Readers
 * select a completed output with one pointer read.
 */

import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { resolveDemosRoot } from "./demo_sources";
import {
  createWatchStage,
  publishWatchStage,
  readWatchGeneration,
  type WatchStage,
} from "./dev_store";
import { killActiveGroups, runInGroup, type StepHandle, type StepOutcome } from "./process_group";

export {
  type GroupOptions,
  groupGone,
  killActiveGroups,
  runInGroup,
  type StepHandle,
  type StepOutcome,
} from "./process_group";

/** The modules the build starts from: the tsup configuration and the postbuild step. */
export const BUILD_SCRIPTS: readonly string[] = ["tsup.config.ts", join("scripts", "postbuild.ts")];

/** Files whose imports are followed when collecting the build inputs. */
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** The relative (`./`, `../`) module specifiers a source names, dynamic imports included. */
export function localImports(source: string): string[] {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map((imported) => imported.fileName)
    .filter((name) => name.startsWith("./") || name.startsWith("../"));
}

/**
 * Reads a file's local import specifiers, parsing it again only when its size, mtime or
 * ctime moved. The ctime covers what the other two miss: a write that keeps the size and
 * puts the mtime back, and a rename that brings an earlier file back into place. An
 * entry for a file that is gone is never matched again, because a file created in its
 * place has a new ctime.
 */
export class ImportScanner {
  readonly #cache = new Map<string, { readonly key: string; readonly specifiers: string[] }>();
  readonly #parse: (source: string) => string[];

  constructor(parse: (source: string) => string[] = localImports) {
    this.#parse = parse;
  }

  /** Returns the local module specifiers in `file`, or an empty list if `stat` fails. */
  specifiers(file: string): readonly string[] {
    let key: string;
    try {
      const stat = statSync(file, { bigint: true });
      key = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
      return [];
    }
    const cached = this.#cache.get(file);
    if (cached?.key === key) return cached.specifiers;
    const specifiers = this.#parse(readFileSync(file, "utf8"));
    this.#cache.set(file, { key, specifiers });
    return specifiers;
  }
}

/** Whether `path` names a regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The repository-relative file a local import in `from` resolves to, the way the
 * bundler resolves it: the path itself, with a TypeScript extension, a `.js` specifier
 * naming its `.ts` source, or the directory's `index.ts`. An import that resolves to
 * nothing yet is reported as the file that would satisfy it, so creating that file
 * counts as a change. Package imports and anything outside `root` or inside
 * `node_modules` are not build inputs here and give `undefined`.
 */
export function resolveImport(root: string, from: string, specifier: string): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const base = resolve(root, dirname(from), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    base.replace(/\.([cm]?)js$/, ".$1ts"),
    join(base, "index.ts"),
  ];
  const found = candidates.find(isFile) ?? (extname(base) === "" ? `${base}.ts` : base);
  const path = relative(root, found);
  if (path.startsWith("..") || isAbsolute(path) || path.split(sep).includes("node_modules")) {
    return undefined;
  }
  return path;
}

/**
 * `file` and every local configuration it extends, repository-relative. A package
 * named in `extends` lives in `node_modules` and is not followed.
 */
export function tsconfigChain(root: string, file = "tsconfig.json"): string[] {
  const chain: string[] = [];
  const pending = [file];
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    if (chain.includes(next)) continue;
    chain.push(next);
    let text: string;
    try {
      text = readFileSync(join(root, next), "utf8");
    } catch {
      continue;
    }
    // TypeScript gives an object for any text, `{}` for text that is not JSON.
    const config = ts.parseConfigFileTextToJson(next, text).config as
      | { readonly extends?: unknown }
      | undefined;
    const extended = config?.extends;
    const specifiers = Array.isArray(extended) ? extended : [extended];
    for (const specifier of specifiers) {
      if (typeof specifier !== "string" || !specifier.startsWith(".")) continue;
      const target = join(dirname(next), specifier);
      const path = relative(
        root,
        resolve(root, target.endsWith(".json") ? target : `${target}.json`),
      );
      if (!path.startsWith("..") && !isAbsolute(path)) pending.push(path);
    }
  }
  return chain;
}

/** Every file under `dir` (repository-relative), not descending into `node_modules`. */
function walkFiles(root: string, dir: string): string[] {
  const files: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...walkFiles(root, path));
    } else {
      files.push(path);
    }
  }
  return files;
}

/**
 * Every file the build reads from the working tree, repository-relative and sorted:
 * everything under `src/` (the entries are derived from the directory), the
 * `_demo.html.erb` of each demo the example index reads, `package.json`, the
 * `tsconfig.json` chain, and the build scripts with every local module they import,
 * followed transitively, including a module outside `src/` that a source imports.
 * `node_modules` is not included; changing it needs a restart.
 */
export function collectBuildInputs(root: string, scanner = new ImportScanner()): string[] {
  const inputs = new Set<string>(walkFiles(root, "src"));
  let demos: string | undefined;
  try {
    demos = resolveDemosRoot(root);
  } catch {
    demos = undefined;
  }
  if (demos !== undefined) {
    for (const entry of readdirSync(join(root, demos), { withFileTypes: true })) {
      if (entry.isDirectory()) inputs.add(join(demos, entry.name, "_demo.html.erb"));
    }
  }
  inputs.add("package.json");
  for (const config of tsconfigChain(root)) inputs.add(config);
  const pending = [...BUILD_SCRIPTS, ...[...inputs].filter((path) => SCRIPT_FILE.test(path))];
  for (const script of BUILD_SCRIPTS) inputs.add(script);
  const sources = resolve(root, "src");
  for (let file = pending.shift(); file !== undefined; file = pending.shift()) {
    for (const specifier of scanner.specifiers(join(root, file))) {
      // Every file under src/ is an input already; resolving those imports would only
      // repeat a file-system lookup per candidate extension, on every check.
      const inside = relative(sources, resolve(root, dirname(file), specifier));
      if (!inside.startsWith("..") && !isAbsolute(inside)) continue;
      const target = resolveImport(root, file, specifier);
      if (target === undefined || inputs.has(target)) continue;
      inputs.add(target);
      if (SCRIPT_FILE.test(target)) pending.push(target);
    }
  }
  return [...inputs].sort();
}

/** The size and nanosecond mtime and ctime of each input, and a digest of all of them. */
export interface Fingerprint {
  readonly digest: string;
  readonly entries: ReadonlyMap<string, string>;
}

/**
 * Fingerprints `files` by path, size, and nanosecond modification and status-change
 * times. Contents are not read. A write moves the ctime even when the size stays and the
 * mtime is set back, and a rename moves the ctime of the file it moves, so an edit undone
 * before the next fingerprint — written back, or renamed back into place with its old
 * size and mtime — still changes it. A missing file is recorded as absent.
 */
export function fingerprintFiles(root: string, files: readonly string[]): Fingerprint {
  const entries = new Map<string, string>();
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    let value: string;
    try {
      const stat = statSync(join(root, file), { bigint: true });
      value = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
      value = "absent";
    }
    entries.set(file, value);
    hash.update(`${file}\t${value}\n`);
  }
  return { digest: hash.digest("hex"), entries };
}

/** The inputs added, removed or changed between two fingerprints, sorted. */
export function changedPaths(before: Fingerprint, after: Fingerprint): string[] {
  const paths = new Set<string>();
  for (const [path, value] of after.entries) {
    if (before.entries.get(path) !== value) paths.add(path);
  }
  for (const path of before.entries.keys()) {
    if (!after.entries.has(path)) paths.add(path);
  }
  return [...paths].sort();
}

/** The two steps of a generation. */
export type StepName = "tsup" | "postbuild";

/** The steps of a generation, in the order they run. */
export const GENERATION_STEPS: readonly StepName[] = ["tsup", "postbuild"];

/** One step's command line. */
export interface StepCommand {
  readonly step: StepName;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The command lines of one generation, in {@link GENERATION_STEPS} order: tsup builds
 * into `stage`, then postbuild checks and completes that same directory. Both run from
 * `root`, where tsup resolves `--out-dir` and postbuild resolves `--dist`. `runtime` is
 * the Bun executable that runs postbuild.
 */
export function generationSteps(root: string, stage: string, runtime: string): StepCommand[] {
  const commands: Record<StepName, StepCommand> = {
    tsup: {
      step: "tsup",
      cwd: root,
      command: join(root, "node_modules", ".bin", "tsup"),
      args: ["--out-dir", stage],
    },
    postbuild: {
      step: "postbuild",
      cwd: root,
      command: runtime,
      args: [join(root, "scripts", "postbuild.ts"), "--dist", stage],
    },
  };
  return GENERATION_STEPS.map((step) => commands[step]);
}

/** What the loop needs from the outside world; tests replace each of these. */
export interface LoopDependencies {
  readonly runStep: (step: StepName) => StepHandle;
  readonly fingerprint: () => Fingerprint;
  /** Allocates the empty output for this generation before its first step. */
  readonly prepareStage: () => void;
  /** Commits the finished generation by replacing its pointer. */
  readonly publish: () => void;
  readonly initialGeneration?: string;
  readonly log: (line: string) => void;
  /** Milliseconds without a change before the next generation starts. */
  readonly quietMs?: number;
  readonly now?: () => number;
}

/** Whether a step succeeded. */
function succeeded(outcome: StepOutcome): boolean {
  return outcome.code === 0 && outcome.error === undefined && !outcome.timedOut;
}

/** How a failed step ended, in words. */
function describeFailure(step: StepName, outcome: StepOutcome): string {
  if (outcome.error !== undefined) return `${step} could not start (${outcome.error})`;
  if (outcome.timedOut) return `${step} ran past its time limit`;
  if (outcome.signal !== null) return `${step} was ended by ${outcome.signal}`;
  return `${step} exited with code ${outcome.code}`;
}

/** At most three changed paths, for a log line; a change always names at least one. */
function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

/** Milliseconds as seconds with one decimal. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Runs generations one at a time. Call {@link GenerationLoop.start} once the watchers
 * are in place, to run the first generation, and {@link GenerationLoop.check} whenever
 * an input may have changed. The first generation's fingerprint is the first one
 * {@link GenerationLoop.check} compares with.
 */
export class GenerationLoop {
  readonly #deps: LoopDependencies;
  readonly #quietMs: number;
  readonly #now: () => number;
  #lastSeen: Fingerprint | undefined;
  #generation = 0;
  #published: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #rerun = false;
  #current: StepHandle | undefined;
  /** The inputs that changed while the running generation was building, once one did. */
  #changes: string[] | undefined;
  #stopping = false;

  constructor(deps: LoopDependencies) {
    this.#deps = deps;
    this.#quietMs = deps.quietMs ?? 200;
    this.#now = deps.now ?? Date.now;
  }

  /** The last build attempt published by this running loop, if any. */
  get published(): number | undefined {
    return this.#published;
  }

  /** Describes the current selection, including one retained across a watcher restart. */
  get holding(): string {
    const generation = this.#published ?? this.#deps.initialGeneration;
    return generation === undefined
      ? "nothing has been published to the watch store yet"
      : `watch store still holds generation ${generation}`;
  }

  /** Starts the first generation. */
  start(): void {
    this.#kick();
  }

  /**
   * Compares the inputs with the last fingerprint. On a change it ends the generation
   * in flight and schedules the next one after the quiet period. Before the first
   * generation it only records the fingerprint; after {@link GenerationLoop.stop} it
   * does nothing.
   */
  check(): void {
    if (this.#stopping) return;
    const next = this.#deps.fingerprint();
    const previous = this.#lastSeen;
    this.#lastSeen = next;
    if (previous === undefined || previous.digest === next.digest) return;
    if (this.#running !== undefined) {
      this.#changes ??= changedPaths(previous, next);
      void this.#current?.stop();
    }
    this.#schedule(this.#quietMs);
  }

  /** Ends the step in flight, starts no further generation, and settles once it is over. */
  async stop(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#current?.stop();
    await this.#running;
  }

  /** Settles once no generation is running or scheduled. */
  async settled(): Promise<void> {
    while (this.#timer !== undefined || this.#running !== undefined) {
      await (this.#running ?? new Promise((settle) => setTimeout(settle, this.#quietMs + 1)));
    }
  }

  #schedule(delay: number): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#kick();
    }, delay);
  }

  #kick(): void {
    if (this.#running !== undefined) {
      this.#rerun = true;
      return;
    }
    const generation = this.#generation + 1;
    this.#running = this.#runGeneration()
      .catch((error: unknown) => {
        this.#deps.log(
          `generation ${generation} failed: ${(error as Error).message}; ${this.holding}`,
        );
      })
      .finally(() => {
        this.#running = undefined;
        if (this.#rerun && !this.#stopping) {
          this.#rerun = false;
          this.#kick();
        }
      });
  }

  /** Records a change found after the fact and schedules the generation that follows it. */
  #changedDuringBuild(before: Fingerprint): boolean {
    const after = this.#deps.fingerprint();
    if (after.digest === before.digest) return false;
    this.#changes ??= changedPaths(before, after);
    this.#lastSeen = after;
    this.#schedule(this.#quietMs);
    return true;
  }

  async #runGeneration(): Promise<void> {
    const generation = ++this.#generation;
    this.#changes = undefined;
    const before = this.#deps.fingerprint();
    this.#lastSeen = before;
    const started = this.#now();
    this.#deps.prepareStage();
    this.#deps.log(`generation ${generation}: building`);
    const timings: string[] = [];
    // Nothing awaits between one step's checks below and the next step, or before the
    // first one, so a stop or a change can only have arrived while a step ran.
    for (const step of GENERATION_STEPS) {
      const stepStarted = this.#now();
      const handle = this.#deps.runStep(step);
      this.#current = handle;
      const outcome = await handle.done;
      this.#current = undefined;
      timings.push(`${step} ${seconds(this.#now() - stepStarted)}`);
      if (this.#stopping || this.#changes !== undefined) break;
      if (!succeeded(outcome)) {
        if (this.#changedDuringBuild(before)) break;
        this.#deps.log(
          `generation ${generation} failed: ${describeFailure(step, outcome)}; ${this.holding}`,
        );
        return;
      }
    }
    if (this.#stopping) {
      this.#deps.log(`generation ${generation}: stopped before publishing; ${this.holding}`);
      return;
    }
    if (this.#changes === undefined) this.#changedDuringBuild(before);
    if (this.#changes !== undefined) {
      this.#deps.log(
        `generation ${generation}: superseded by a change to ${listPaths(this.#changes)}; ` +
          this.holding,
      );
      return;
    }
    const publishing = this.#now();
    try {
      this.#deps.publish();
    } catch (error) {
      this.#deps.log(
        `generation ${generation} failed while publishing: ${(error as Error).message}; ${this.holding}`,
      );
      return;
    }
    timings.push(`publish ${this.#now() - publishing} ms`);
    this.#published = generation;
    this.#deps.log(
      `generation ${generation}: published to watch store in ${seconds(this.#now() - started)} ` +
        `(${timings.join(", ")})`,
    );
  }
}

/** Runs one step's command line from its directory, in a process group of its own. */
export function runStepCommand(command: StepCommand): StepHandle {
  return runInGroup(command.command, command.args, { cwd: command.cwd });
}

/** What {@link startDev} needs from the process it runs in; tests replace each of these. */
export interface DevEnvironment {
  readonly root: string;
  /** The Bun executable that runs postbuild. */
  readonly runtime: string;
  readonly log: (line: string) => void;
  /**
   * Watches `dir`, calling `onChange` on each event and `onError` when watching stops.
   * Throws when watching cannot start.
   */
  readonly watch: (
    dir: string,
    recursive: boolean,
    onChange: () => void,
    onError: (error: Error) => void,
  ) => { close(): void };
  readonly onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  readonly onExit: (handler: () => void) => void;
  readonly exit: (code: number) => void;
  /** Runs one step's command line; {@link runInGroup} unless a test replaces it. */
  readonly runStep?: (command: StepCommand) => StepHandle;
  /** Milliseconds between checks of the inputs when no watcher reported a change. */
  readonly pollMs?: number;
  /** Milliseconds without a change before the next generation starts. */
  readonly quietMs?: number;
}

/** The signals that stop `bun run dev`. */
export const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Starts `bun run dev` in `env`. It watches `src/` and the demo sidecars recursively
 * and `scripts/` and the root directly, with an input check every `pollMs` in case a
 * watcher misses an event. Watchers are installed before the first generation starts;
 * each generation fingerprints its inputs before preparing its fresh watch output.
 * A stop signal closes the watchers, requests that the active step stop, and exits 0
 * after the loop settles.
 */
export function startDev(env: DevEnvironment): GenerationLoop {
  const { root, log, pollMs = 1_000 } = env;
  const scanner = new ImportScanner();
  const inputs = (): string[] => collectBuildInputs(root, scanner);
  const runStep = env.runStep ?? runStepCommand;
  let stage: WatchStage;
  const loop = new GenerationLoop({
    prepareStage: () => {
      stage = createWatchStage(root);
    },
    runStep: (step) => {
      const commands = generationSteps(root, relative(root, stage.staging), env.runtime);
      return runStep(commands.find((command) => command.step === step) as StepCommand);
    },
    fingerprint: () => fingerprintFiles(root, inputs()),
    publish: () => publishWatchStage(stage),
    initialGeneration: readWatchGeneration(root)?.generation,
    log,
    quietMs: env.quietMs,
  });
  env.onExit(killActiveGroups);

  let demos: string | undefined;
  try {
    demos = resolveDemosRoot(root);
  } catch {
    log("no demo sidecar root found; postbuild reports it when it runs");
  }
  const targets: ReadonlyArray<readonly [string, boolean]> = [
    ["src", true],
    ...(demos === undefined ? [] : [[demos, true] as const]),
    ["scripts", false],
    [".", false],
  ];
  const watchers: { close(): void }[] = [];
  for (const [dir, recursive] of targets) {
    try {
      watchers.push(
        env.watch(
          join(root, dir),
          recursive,
          () => loop.check(),
          (error) =>
            log(
              `watching ${dir} stopped (${error.message}); the periodic check still sees changes`,
            ),
        ),
      );
    } catch (error) {
      log(
        `cannot watch ${dir} (${(error as Error).message}); the periodic check still sees changes`,
      );
    }
  }
  const poll = setInterval(() => loop.check(), pollMs);
  log(
    `watching ${inputs().length} build inputs; the watch pointer changes only when a whole generation ` +
      "has been built from unchanged sources",
  );
  loop.start();

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping`);
    clearInterval(poll);
    for (const watcher of watchers) watcher.close();
    await loop.stop();
    log(`stopped; ${loop.holding}`);
    env.exit(0);
  };
  for (const signal of STOP_SIGNALS) env.onSignal(signal, () => void shutdown(signal));
  return loop;
}
