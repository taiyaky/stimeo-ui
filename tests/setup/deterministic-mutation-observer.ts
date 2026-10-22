/**
 * Pins {@link WeakRef} to a strong reference for the duration of the test process.
 *
 * happy-dom registers a MutationObserver on every node it watches as a `WeakRef` to the
 * observer's internal listener callback, and the node passes a mutation on only while
 * `callback.deref()` returns that callback (it drops the registration otherwise). In
 * happy-dom 20.14.6 the callback stays strongly reachable for as long as the observer
 * observes: the window lists every observing MutationObserver until its `disconnect()`,
 * the observer holds its listeners, and each listener holds its callback. A collection
 * therefore does not drop the records of an observer that is still observing, whether
 * or not a test or a Stimulus application keeps a reference to it, and delivery does
 * not need this file. With the swap, `deref()` always returns the callback, so delivery
 * does not depend on the collector. The swap reaches every `WeakRef` happy-dom creates
 * once this file has run, so its selector-query and computed-style caches hold their
 * results strongly as well.
 *
 * `src/` does not use `WeakRef`. A test that needs a collectable reference takes the
 * native constructor from a fresh `node:vm` context or runs in a separate process, so
 * swapping the global for a strong-holding shim leaves both alone. Test processes are
 * short-lived and each file tears its observers down, so the strong refs are reclaimed
 * at process exit rather than accumulating.
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
