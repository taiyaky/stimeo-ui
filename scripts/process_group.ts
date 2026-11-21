/** Owns command process groups without importing build or product modules. */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import process from "node:process";

/** How one step of a generation ended. */
export interface StepOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Why the step could not start, when it could not. */
  readonly error: string | undefined;
  /** Whether {@link StepHandle.stop} was called before the step ended. */
  readonly stopped: boolean;
  readonly timedOut: boolean;
}

/** A running step. */
export interface StepHandle {
  /**
   * Settles once the step's process has exited and its group is gone, or the settle
   * period has passed with a process of the group still there.
   */
  readonly done: Promise<StepOutcome>;
  /** Signals the step's group and returns its completion promise. */
  stop(): Promise<StepOutcome>;
}

/** Where a step runs and how long it may take. */
export interface GroupOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Milliseconds between SIGTERM and SIGKILL when the step is stopped. */
  readonly graceMs?: number;
  /** Milliseconds before the step is stopped as timed out; zero disables the limit. */
  readonly limitMs?: number;
  /** Milliseconds to wait for the group to disappear once its leader has exited. */
  readonly settleMs?: number;
  /** Whether the step writes to this process's output or nowhere. */
  readonly output?: "inherit" | "ignore";
  /** Whether the command receives the caller's stdin, as a resident Inspector does. */
  readonly input?: "inherit" | "ignore";
  /** Starts the process; `node:child_process` `spawn` unless a test replaces it. */
  readonly spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/** Process groups of the steps in flight, each named by its leader's pid. */
const activeGroups = new Set<number>();

/** Sends `signal` to every process in the group; `false` when there is no such group. */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    // EPERM: the group exists but a member belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Waits until no process of the group is left; `false` when `ms` passed first. */
export async function groupGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (signalGroup(pgid, 0)) {
    if (Date.now() >= deadline) return false;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  return true;
}

/** SIGKILLs every step group still running; for an exit path that cannot wait. */
export function killActiveGroups(): void {
  for (const pgid of activeGroups) signalGroup(pgid, "SIGKILL");
}

/**
 * Signals the step's group, or only its leader where process groups do not exist or
 * the process never started.
 */
function signalStep(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || !signalGroup(child.pid, signal)) child.kill(signal);
}

/**
 * Runs `command` as the leader of a new process group. A stop or time limit sends
 * SIGTERM to the group, with SIGKILL after the grace period if the leader is still running.
 * After the leader exits, sends SIGKILL to any remaining group members and waits up to
 * `settleMs` for the group to disappear.
 */
export function runInGroup(
  command: string,
  args: readonly string[],
  options: GroupOptions,
): StepHandle {
  const {
    cwd,
    env = process.env,
    graceMs = 5_000,
    limitMs = 600_000,
    settleMs = 2_000,
    output = "inherit",
    input = "ignore",
    spawn: start = spawn,
  } = options;
  let stopped = false;
  let timedOut = false;
  let exited = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const child = start(command, [...args], {
    cwd,
    env,
    stdio: [input, output, output],
    detached: true,
  });
  const pgid = child.pid;
  if (pgid !== undefined) activeGroups.add(pgid);
  const terminate = (): void => {
    if (exited) return;
    signalStep(child, "SIGTERM");
    escalation ??= setTimeout(() => signalStep(child, "SIGKILL"), graceMs);
  };
  const limit =
    limitMs === 0
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          terminate();
        }, limitMs);
  const done = new Promise<StepOutcome>((settle) => {
    let finished = false;
    const finish = async (
      code: number | null,
      signal: NodeJS.Signals | null,
      error: string | undefined,
    ): Promise<void> => {
      if (finished) return;
      finished = true;
      exited = true;
      clearTimeout(limit);
      clearTimeout(escalation);
      if (pgid !== undefined) {
        signalGroup(pgid, "SIGKILL");
        await groupGone(pgid, settleMs);
        activeGroups.delete(pgid);
      }
      settle({ code, signal, error, stopped, timedOut });
    };
    child.once("error", (error) => void finish(null, null, error.message));
    child.once("exit", (code, signal) => void finish(code, signal, undefined));
  });
  return {
    done,
    stop(): Promise<StepOutcome> {
      stopped = true;
      terminate();
      return done;
    },
  };
}
