import { join } from "node:path";
import process from "node:process";
import { killActiveGroups, runInGroup, STOP_SIGNALS } from "./dev_loop";
import { readWatchGeneration } from "./dev_store";

/** Runs the Inspector from one concrete watch generation, including its adjacent JSON. */
const generation = readWatchGeneration(join(import.meta.dirname, ".."));
if (generation === undefined)
  throw new Error("No watch generation is available; run bun run dev first");
const step = runInGroup(
  "node",
  [join(generation.path, "inspector/cli_bin.js"), ...process.argv.slice(2)],
  {
    cwd: join(import.meta.dirname, ".."),
    input: "inherit",
    limitMs: 0,
  },
);
process.on("exit", killActiveGroups);
for (const signal of STOP_SIGNALS) process.on(signal, () => void step.stop());
const outcome = await step.done;
if (outcome.error) console.error(outcome.error);
process.exitCode = outcome.stopped ? 0 : (outcome.code ?? 1);
