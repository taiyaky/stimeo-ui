import { join } from "node:path";
import { cleanWatchStore } from "./dev_store";

/** Explicitly ends the retention of watch generations while the writer lock is held. */
cleanWatchStore(join(import.meta.dirname, ".."));
