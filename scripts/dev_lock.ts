import { join } from "node:path";
import { watchWriterLock } from "./dev_store";

/** Prints the lock path for the dev and clean commands to open with flock. */
console.log(watchWriterLock(join(import.meta.dirname, "..")));
