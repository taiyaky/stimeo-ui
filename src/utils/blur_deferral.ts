/**
 * Shared bookkeeping for updates that must wait until an element loses focus.
 *
 * A control that becomes redundant while the user is standing on it cannot be
 * removed from the page immediately: hiding a focused element (or turning it
 * into a native `disabled` one) drops focus to `<body>`, stranding a keyboard
 * user mid-widget. The fix every affected controller reached for is the same —
 * keep the element reachable, hold the destructive update, listen for `blur`,
 * and apply it then.
 *
 * {@link BlurDeferral} owns *only* the registry part of that: which elements are
 * currently holding an update back, attaching and detaching the `blur` listener,
 * and guaranteeing teardown. It is deliberately **policy-free** — what the
 * interim state looks like (`aria-disabled`, an ownership marker, nothing at
 * all), and what the deferred update actually is, stay in the controller, which
 * receives the element back through its release callback.
 *
 * Three contracts are worth stating up front, because each one is a hazard the
 * consumers would otherwise hit:
 *
 * - **The release callback fires only on a real `blur`.** `release()` /
 *   `releaseAll()` *cancel* a deferral; they do not complete it. Conflating the
 *   two makes `overflow-indicator` disable a button that just left the boundary.
 * - **`elements` is a snapshot.** Iterating the live key set while releasing
 *   inside the loop is the failure this registry exists to prevent.
 * - **The entry is detached before the callback runs**, so a controller that
 *   decides the update is still unsafe can simply defer again.
 *
 * This file's own doc block is dropped from `dist`, but every member comment is
 * inlined into each consumer entry (`tsup` builds with `splitting: false`), so
 * rationale belongs here and contracts belong on the members.
 *
 * @example
 * ```ts
 * readonly #deferred = new BlurDeferral<HTMLElement>((trigger) => {
 *   if (this.#connected) this.#evaluate();
 * });
 *
 * #hide(trigger: HTMLElement) {
 *   if (document.activeElement === trigger) {
 *     this.#deferred.deferOnly(trigger); // stays visible until blur
 *     return;
 *   }
 *   this.#deferred.releaseAll();
 *   trigger.hidden = true;
 * }
 *
 * disconnect() {
 *   this.#deferred.releaseAll();
 * }
 * ```
 */
export class BlurDeferral<T extends HTMLElement = HTMLElement> {
  /** Elements currently holding an update back, mapped to their `blur` listener. */
  readonly #pending = new Map<T, () => void>();
  /** Called after a pending element blurs and has been detached. */
  readonly #onRelease: (element: T) => void;

  /** @param onRelease - Invoked once `element` actually blurs; never on `release`. */
  constructor(onRelease: (element: T) => void) {
    this.#onRelease = onRelease;
  }

  /** Number of elements currently holding an update back. */
  get size(): number {
    return this.#pending.size;
  }

  /** Snapshot of the pending elements, safe to iterate while releasing them. */
  get elements(): T[] {
    return [...this.#pending.keys()];
  }

  /** Whether `element` is currently holding an update back. */
  has(element: T): boolean {
    return this.#pending.has(element);
  }

  /** Holds an update back until `element` blurs. Idempotent (no stacked listeners). */
  defer(element: T): void {
    if (this.#pending.has(element)) return;
    const onBlur = (): void => {
      this.#detach(element);
      this.#onRelease(element);
    };
    this.#pending.set(element, onBlur);
    element.addEventListener("blur", onBlur);
  }

  /** Defers `element` as the only pending entry, cancelling any others. */
  deferOnly(element: T): void {
    for (const pending of this.elements) {
      if (pending !== element) this.#detach(pending);
    }
    this.defer(element);
  }

  /** Cancels `element`'s deferral without completing it; no-ops when not pending. */
  release(element: T): void {
    this.#detach(element);
  }

  /** Cancels every deferral without completing any of them. */
  releaseAll(): void {
    for (const element of this.elements) this.#detach(element);
  }

  /** Removes the `blur` listener for `element` and forgets it. */
  #detach(element: T): void {
    const onBlur = this.#pending.get(element);
    if (onBlur) element.removeEventListener("blur", onBlur);
    this.#pending.delete(element);
  }
}
