/**
 * Pins {@link WeakRef} to a strong reference for the duration of the test process.
 *
 * happy-dom holds each MutationObserver's callback through a `WeakRef` and, when it
 * dispatches mutations, only delivers them while `callback.deref()` is still live
 * (its Node mutation path bails out otherwise). Nothing else strongly references
 * that callback, so under GC pressure — which the parallel, istanbul-instrumented
 * coverage run produces in abundance — the `WeakRef` is reclaimed and mutation
 * records are silently dropped. Every test that depends on a MutationObserver then
 * flakes: Stimulus's disconnect-on-removal never fires (leaking window/document
 * guards, timers, and the controllers' own observers), and controllers that watch
 * the DOM for dynamic inserts miss them. The drop is non-recoverable, so extra
 * flushing cannot recover it — only deterministic delivery can.
 *
 * Neither `src/` nor the tests use `WeakRef`, so swapping it for a strong-holding
 * shim is side-effect free here and simply makes MutationObserver delivery
 * deterministic. Test processes are short-lived and each file tears its observers
 * down, so the strong refs are reclaimed at process exit rather than accumulating.
 */
class StrongRef<T extends object> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  deref(): T {
    return this.#value;
  }
}

globalThis.WeakRef = StrongRef as unknown as typeof WeakRef;

// Make this side-effect-only setup an explicit module so `StrongRef` stays
// file-scoped; under `isolatedModules` a script's declarations would otherwise
// leak into the global namespace.
export {};
