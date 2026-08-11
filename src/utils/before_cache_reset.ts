/**
 * Runs a controller's "return to the initial state" pass just before Turbo
 * caches the page.
 *
 * **`disconnect()` cannot do this job, for two independent reasons.** Turbo
 * queues the clone from this event rather than taking it here, and the body swap
 * that runs the controller's `disconnect()` is queued separately — so which of
 * the two lands first is not something a controller can rely on, and a rewind
 * written in `disconnect()` may reach only the DOM being thrown away. In the
 * other direction, `disconnect()` also fires on an in-page move (Stimulus tears
 * down and reconnects the same element), where rewinding would wipe a
 * legitimately in-progress interaction — a spinner mid-load would vanish. One
 * timing is unreliable, the other is too eager; `turbo:before-cache` is the only
 * point that is exactly "the page is about to be frozen".
 *
 * Scope is the subscription only: registering on `activate()`, unregistering on
 * `deactivate()`, and one shared document listener no matter how many instances
 * are live. *What* to return to its initial state — which `data-state`, which
 * `hidden`, which `aria-busy` — stays in the controller, because no two
 * consumers answer it the same way (the `MicrotaskCoalescer` split).
 *
 * **Rewind state, not appearance.** The pass writes attributes the controller
 * itself owns; the visual result of those attributes is the consumer's CSS, and
 * a library that reached for style or class names would be guessing at markup
 * it does not own.
 *
 * Both entry points are idempotent, so the lifecycle hooks can call them
 * unconditionally: a second `activate()` does not double-subscribe and does not
 * make the callback run twice, and `deactivate()` on an instance that never
 * subscribed is a no-op.
 *
 * This file's own doc block is dropped from `dist`, but every member comment is
 * inlined into each consumer entry (`tsup` builds with `splitting: false`), so
 * rationale belongs here and only the contract belongs on the members.
 *
 * @example
 * ```ts
 * readonly #beforeCache = new BeforeCacheReset(() => this.#rewind());
 *
 * connect()    { this.#beforeCache.activate(); }
 * disconnect() { this.#beforeCache.deactivate(); }
 * ```
 */
export class BeforeCacheReset {
  /** Every subscribed instance, iterated by the one shared document listener. */
  static readonly #subscribers = new Set<BeforeCacheReset>();

  /** The shared listener; installed while at least one instance is subscribed. */
  static readonly #onBeforeCache = (): void => {
    for (const subscriber of BeforeCacheReset.#subscribers) subscriber.#rewind();
  };

  readonly #rewind: () => void;

  /** @param rewind - the pass that returns this controller's state to its initial form. */
  constructor(rewind: () => void) {
    this.#rewind = rewind;
  }

  /** Subscribes to `turbo:before-cache`; call from `connect()`. Idempotent. */
  activate(): void {
    const first = BeforeCacheReset.#subscribers.size === 0;
    BeforeCacheReset.#subscribers.add(this);
    if (first) {
      document.addEventListener("turbo:before-cache", BeforeCacheReset.#onBeforeCache);
    }
  }

  /** Unsubscribes; call from `disconnect()`. Safe when never subscribed. */
  deactivate(): void {
    BeforeCacheReset.#subscribers.delete(this);
    if (BeforeCacheReset.#subscribers.size > 0) return;
    document.removeEventListener("turbo:before-cache", BeforeCacheReset.#onBeforeCache);
  }
}
