import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { stimeoControllers } from "../../src/index";
import { positioningControllers } from "../../src/positioning";

/**
 * Drift guard for the co-located public-API declarations (`static actions` /
 * `static events`) that feed the Inspector manifest.
 *
 * These are hand-written, so they can drift from the implementation. The guard
 * checks both directions:
 *
 * 1. **Forward:** every `static actions` name resolves to a real prototype
 *    method, and every `static events` name is actually `this.dispatch("…")`-ed
 *    in source (catches typos, renames, deletions).
 * 2. **Reverse:** every *public* prototype method is a declared action (catches
 *    a new public action a contributor forgot to declare). This is only sound
 *    because the controllers use ECMAScript `#private` — true privates are
 *    absent from `Object.getOwnPropertyNames(prototype)`, so the public surface
 *    *can* be reflected. (Under TypeScript `private`, internal helpers stayed on
 *    the prototype and were indistinguishable from public actions, which is why
 *    this check was impossible before the `#private` migration.)
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

/** Lifecycle methods Stimulus calls; never user actions. */
const LIFECYCLE = new Set(["connect", "disconnect", "initialize"]);

/** Stimulus callback suffixes (target/value/outlet hooks); never user actions. */
const CALLBACK_SUFFIXES = [
  "TargetConnected",
  "TargetDisconnected",
  "ValueChanged",
  "OutletConnected",
  "OutletDisconnected",
];
const isCallback = (name: string): boolean => CALLBACK_SUFFIXES.some((s) => name.endsWith(s));

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

interface DeclaringController {
  readonly actions?: readonly string[];
  readonly events?: readonly string[];
  readonly prototype: Record<string, unknown>;
}

describe("public API contract declarations (drift guard)", () => {
  // Core + opt-in positioning controllers: both are reflected into the manifest,
  // so both must keep their public surface honest.
  const allControllers = { ...stimeoControllers, ...positioningControllers };
  for (const [identifier, ctor] of Object.entries(allControllers)) {
    const klass = ctor as unknown as DeclaringController;

    describe(identifier, () => {
      it("declares static actions that resolve to real prototype methods", () => {
        for (const action of klass.actions ?? []) {
          expect(
            typeof klass.prototype[action],
            `${identifier} declares action "${action}" but has no such method`,
          ).toBe("function");
        }
      });

      it("declares static events that are dispatched in the source", () => {
        const events = klass.events ?? [];
        if (events.length === 0) return;
        const source = sourceFor(identifier);
        for (const event of events) {
          expect(
            source.includes(`this.dispatch("${event}"`),
            `${identifier} declares event "${event}" but never dispatches it`,
          ).toBe(true);
        }
      });

      it("declares every public method as an action (no undeclared public surface)", () => {
        const declared = new Set(klass.actions ?? []);
        const allowed = new Set(NON_ACTION_ALLOWLIST[identifier] ?? []);
        const proto = klass.prototype;
        for (const name of Object.getOwnPropertyNames(proto)) {
          if (name === "constructor" || LIFECYCLE.has(name) || isCallback(name)) continue;
          // Only methods are actions; skip accessors (e.g. Stimulus target/value getters).
          const descriptor = Object.getOwnPropertyDescriptor(proto, name);
          if (typeof descriptor?.value !== "function") continue;
          if (allowed.has(name)) continue;
          expect(
            declared.has(name),
            `${identifier}: public method "${name}" is not declared in static actions — declare it, make it #private, or add it to NON_ACTION_ALLOWLIST with a reason`,
          ).toBe(true);
        }
      });
    });
  }
});
