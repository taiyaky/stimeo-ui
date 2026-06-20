/**
 * Self-cleaning timer registries shared by Stimeo controllers.
 *
 * Stimulus controllers frequently schedule `setTimeout` / `setInterval` work
 * (auto-dismiss, debouncing, polling). When the element leaves the DOM — a
 * Turbo Drive navigation, a Turbo Stream replacement, or any `disconnect()` —
 * orphaned timers keep firing against a detached controller, leaking memory and
 * mutating stale state. {@link SafeTimeout} and {@link SafeInterval} track every
 * timer they create so a single {@link TimerRegistry.clearAll | clearAll()} call
 * in `disconnect()` tears them all down.
 *
 * These are intentionally low-level primitives: they own *registration and
 * cleanup only*. Higher-level policy (pause/resume, remaining-time accounting)
 * stays in the individual controllers so per-widget semantics are not flattened
 * into a lowest-common-denominator helper.
 */

/**
 * Shared registry bookkeeping for the timeout/interval variants.
 *
 * Subclasses provide the scheduling primitive ({@link schedule}) and its matching
 * canceller ({@link cancel}); this base owns the set of live ids plus the
 * per-id and bulk teardown shared by both.
 */
abstract class TimerRegistry {
  /** Live timer ids that have not yet been cleared (or, for timeouts, fired). */
  protected readonly ids = new Set<number>();

  /** Schedules the underlying platform timer and returns its id. */
  protected abstract schedule(callback: () => void, delay: number): number;

  /** Cancels the underlying platform timer for `id`. */
  protected abstract cancel(id: number): void;

  /**
   * Cancels a single tracked timer.
   *
   * No-ops if the id is unknown (already cleared, fired, or never owned by this
   * registry), so callers can clear defensively without guarding.
   */
  clear(id: number): void {
    if (this.ids.delete(id)) {
      this.cancel(id);
    }
  }

  /**
   * Cancels every tracked timer. Call this from a controller's `disconnect()`
   * to guarantee no timer outlives the element.
   */
  clearAll(): void {
    for (const id of this.ids) {
      this.cancel(id);
    }
    this.ids.clear();
  }

  /** Number of timers currently tracked (pending). */
  get size(): number {
    return this.ids.size;
  }
}

/**
 * `setTimeout` wrapper that auto-forgets each timer once it fires and supports
 * bulk teardown on disconnect.
 *
 * @example
 * ```ts
 * #timers = new SafeTimeout();
 *
 * connect() {
 *   this.#timers.set(() => this.dismiss(), 5000);
 * }
 *
 * disconnect() {
 *   this.#timers.clearAll();
 * }
 * ```
 */
export class SafeTimeout extends TimerRegistry {
  /**
   * Schedules `callback` after `delay` ms and returns the timer id.
   *
   * The id is removed from the registry automatically when the timeout fires,
   * so {@link TimerRegistry.size | size} reflects only still-pending timers.
   */
  set(callback: () => void, delay: number): number {
    const id = this.schedule(() => {
      this.ids.delete(id);
      callback();
    }, delay);
    this.ids.add(id);
    return id;
  }

  protected schedule(callback: () => void, delay: number): number {
    return window.setTimeout(callback, delay);
  }

  protected cancel(id: number): void {
    window.clearTimeout(id);
  }
}

/**
 * `setInterval` wrapper that tracks every interval for bulk teardown on
 * disconnect. Unlike {@link SafeTimeout}, intervals are retained until they are
 * explicitly cleared because they fire repeatedly.
 *
 * @example
 * ```ts
 * #intervals = new SafeInterval();
 *
 * connect() {
 *   this.#intervals.set(() => this.tick(), 1000);
 * }
 *
 * disconnect() {
 *   this.#intervals.clearAll();
 * }
 * ```
 */
export class SafeInterval extends TimerRegistry {
  /** Schedules a repeating `callback` every `delay` ms and returns the timer id. */
  set(callback: () => void, delay: number): number {
    const id = this.schedule(callback, delay);
    this.ids.add(id);
    return id;
  }

  protected schedule(callback: () => void, delay: number): number {
    return window.setInterval(callback, delay);
  }

  protected cancel(id: number): void {
    window.clearInterval(id);
  }
}
