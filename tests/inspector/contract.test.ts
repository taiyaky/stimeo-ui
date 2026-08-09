import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe } from "vitest";
import { stimeoControllers } from "../../src/index";
import { positioningControllers } from "../../src/positioning";
import { describeContractGuard } from "../helpers/contract";

/**
 * Contract drift guard for the core + opt-in positioning controllers (see
 * `tests/helpers/contract.ts` for the shared checks and their rationale; other
 * registries run the same guard from their own suites, next to themselves).
 */
// Resolve from the project root (Vitest's cwd) rather than `import.meta.url`:
// under the coverage runner the module URL is not always a `file:` URL, so
// `fileURLToPath` would throw ERR_INVALID_URL_SCHEME.
const CONTROLLERS_DIR = join(process.cwd(), "src", "controllers");
const POSITIONING_DIR = join(process.cwd(), "src", "positioning");

/** Opt-in positioning controllers live outside `src/controllers/` (own subpath). */
const POSITIONING_IDS = new Set(Object.keys(positioningControllers));

/** Resolves the source file for a controller identifier (`stimeo--alert-dialog`). */
function sourceFor(identifier: string): string {
  const base = identifier.replace(/^stimeo--/, "").replace(/-/g, "_");
  const dir = POSITIONING_IDS.has(identifier) ? POSITIONING_DIR : CONTROLLERS_DIR;
  return readFileSync(`${dir}/${base}_controller.ts`, "utf8");
}

/**
 * Public, non-action methods exempt from the reverse check, with the reason.
 * These are genuine public methods that are *not* user-wired actions, so they
 * must not appear in `static actions`, yet legitimately remain public.
 *
 * - `stimeo--calendar` `render` / `selectDayElement`: internal grid mechanics
 *   kept public as a deterministic test seam — happy-dom does not reliably fire
 *   Stimulus's async value-changed / delegated-click paths, so the calendar
 *   specs drive these directly instead of synthesizing unreliable DOM events.
 * - `stimeo--toast` `enforceMaxLimit`: enforcement normally runs from
 *   `itemTargetConnected` (a MutationObserver-driven Stimulus callback happy-dom
 *   does not reliably fire), so the toast spec invokes it directly.
 */
const NON_ACTION_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "stimeo--calendar": ["render", "selectDayElement"],
  "stimeo--toast": ["enforceMaxLimit"],
};

describe("public API contract declarations (drift guard)", () => {
  // Core + opt-in positioning controllers: both are reflected into the manifest,
  // so both must keep their public surface honest.
  describeContractGuard(
    { ...stimeoControllers, ...positioningControllers },
    sourceFor,
    NON_ACTION_ALLOWLIST,
  );
});
