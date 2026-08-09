import { describe, expect, it } from "vitest";

/**
 * Shared drift guard for the co-located public-API declarations
 * (`static actions` / `static events`) that feed the Inspector manifest.
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
 *    *can* be reflected. TypeScript `private` would leave internal helpers on
 *    the prototype, indistinguishable from public actions, and make the reverse
 *    direction unsound.
 *
 * Every controller registry that `buildManifest` reflects must run this guard
 * from the suite that owns that registry.
 */

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

interface DeclaringController {
  readonly actions?: readonly string[];
  readonly events?: readonly string[];
  readonly prototype: Record<string, unknown>;
}

/**
 * Registers the three contract-drift `it`s for every controller in `controllers`.
 *
 * @param controllers - Identifier → class map (a manifest-reflected registry).
 * @param sourceFor - Resolves a controller identifier to its TypeScript source
 *   (used to prove each declared event is dispatched).
 * @param nonActionAllowlist - Public, non-action methods exempt from the reverse
 *   check, keyed by identifier — each entry needs a reason at the call site.
 */
export function describeContractGuard(
  controllers: Record<string, unknown>,
  sourceFor: (identifier: string) => string,
  nonActionAllowlist: Readonly<Record<string, readonly string[]>> = {},
): void {
  for (const [identifier, ctor] of Object.entries(controllers)) {
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
        const allowed = new Set(nonActionAllowlist[identifier] ?? []);
        const proto = klass.prototype;
        for (const name of Object.getOwnPropertyNames(proto)) {
          if (name === "constructor" || LIFECYCLE.has(name) || isCallback(name)) continue;
          // Only methods are actions; skip accessors (e.g. Stimulus target/value getters).
          const descriptor = Object.getOwnPropertyDescriptor(proto, name);
          if (typeof descriptor?.value !== "function") continue;
          if (allowed.has(name)) continue;
          expect(
            declared.has(name),
            `${identifier}: public method "${name}" is not declared in static actions — declare it, make it #private, or add it to the non-action allowlist with a reason`,
          ).toBe(true);
        }
      });
    });
  }
}
