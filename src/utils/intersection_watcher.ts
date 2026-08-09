/**
 * Shared `IntersectionObserver` plumbing for Stimeo's scroll-triggered
 * controllers (`intersection`, `scrollspy`, `sticky-observer`, `lazy-frame`).
 *
 * It centralizes the `IntersectionObserver` support guard, root resolution from
 * a selector, observer creation/teardown, the **active guard** (the browser may
 * flush a final queued callback batch right after `disconnect()`, and a
 * detached controller must not mutate possibly-cached DOM), and the
 * unobserve→observe **re-arm** that re-delivers the current state even when the
 * target never leaves the viewport.
 *
 * Like {@link RovingTabindex} and `FocusTrap`, this is a policy-free internal
 * util: what an intersection *means* (a spied link, a stuck header, a lazy
 * load) stays in each controller. The public `stimeo--intersection` controller
 * is its thin declarative face.
 */
/**
 * Whether `entry`'s target sits entirely before the root's **start (top)** edge —
 * the "scrolled past the top" half of a non-intersecting entry, as opposed to
 * "not reached yet" below the root.
 *
 * A target with no layout box (`display: none`, a `hidden` ancestor, a collapsed
 * `<details>`) is reported with an **empty rect**, whose `bottom` of `0` would
 * otherwise satisfy `bottom <= rootTop` for a viewport root and read as "passed"
 * even though the target was never scrolled anywhere. An empty rect carries no
 * position at all, so it is deliberately never "before the edge"; what a caller
 * publishes for that case is its own policy (both consumers treat it as the
 * neutral "not passed"/"not stuck", and the real rect that arrives once the
 * target is laid out re-establishes the true state).
 */
export function isBeforeRootStart(entry: IntersectionObserverEntry): boolean {
  const rect = entry.boundingClientRect;
  if (rect.width === 0 && rect.height === 0) return false;
  // rootBounds is null for a cross-origin/removed root; fall back to the
  // viewport origin.
  const rootTop = entry.rootBounds?.top ?? 0;
  return rect.bottom <= rootTop;
}

export interface IntersectionWatchOptions {
  /**
   * The observation root. Pass an element (or `null` for the viewport) when
   * the caller already resolved it; omit to resolve from `rootSelector`.
   */
  root?: Element | null;
  /** Selector for the observation root; empty/omitted = viewport. */
  rootSelector?: string;
  rootMargin?: string;
  threshold?: number | number[];
}

export class IntersectionWatcher {
  readonly #onEntries: (entries: IntersectionObserverEntry[]) => void;
  #observer: IntersectionObserver | null = null;
  #active = false;
  #usingPlatformDefaults = false;

  constructor(onEntries: (entries: IntersectionObserverEntry[]) => void) {
    this.#onEntries = onEntries;
  }

  /** Whether an observer is live (started, `IntersectionObserver` supported). */
  get active(): boolean {
    return this.#active;
  }

  /** Whether the live observer discarded configured options after construction failed. */
  get usingPlatformDefaults(): boolean {
    return this.#usingPlatformDefaults;
  }

  /**
   * (Re)creates the observer and observes `targets`. Returns `false` — leaving
   * the watcher inert — without `IntersectionObserver` support (very old
   * browsers; the caller's no-JS fallback stays in charge) or with no targets.
   * If initial construction with the configured options fails, the watcher
   * warns and retries once with the same root and platform defaults.
   *
   * @throws The fallback constructor error if both construction attempts fail,
   *   or whatever the platform throws from `observe()`. The exception is passed
   *   through unchanged, but the watcher rolls back first: every target observed
   *   so far is released and `active` stays `false`, so a caller that retries
   *   starts from a clean slate.
   */
  start(targets: Element | readonly Element[], options: IntersectionWatchOptions = {}): boolean {
    this.stop();
    if (typeof IntersectionObserver === "undefined") return false;
    const list = Array.isArray(targets) ? (targets as readonly Element[]) : [targets as Element];
    if (list.length === 0) return false;

    const root =
      "root" in options
        ? (options.root ?? null)
        : options.rootSelector
          ? document.querySelector(options.rootSelector)
          : null;

    let observer: IntersectionObserver | null = null;
    try {
      const onEntries = (entries: IntersectionObserverEntry[]): void => {
        // Identity matters across an immediate restart: the old observer can
        // flush a queued batch after the new observer has made `active` true.
        if (this.#active && this.#observer === observer) this.#onEntries(entries);
      };
      try {
        observer = new IntersectionObserver(onEntries, {
          root,
          rootMargin: options.rootMargin,
          threshold: options.threshold,
        });
      } catch (error) {
        console.warn(
          "Stimeo UI: IntersectionObserver could not be constructed with the configured options; retrying with platform defaults.",
          error,
        );
        observer = new IntersectionObserver(onEntries, { root });
        this.#usingPlatformDefaults = true;
      }
      for (const target of list) observer.observe(target);
      this.#observer = observer;
      this.#active = true;
      return true;
    } catch (error) {
      // A constructor or partial observe failure must not leave earlier targets
      // observed or report an active watcher. Preserve the platform exception.
      observer?.disconnect();
      this.#observer = null;
      this.#active = false;
      this.#usingPlatformDefaults = false;
      throw error;
    }
  }

  /**
   * Re-delivers `target`'s CURRENT intersection state: `IntersectionObserver`
   * only reports *changes*, but `observe()` always reports the present state,
   * so unobserve→observe turns "still intersecting" into a fresh callback.
   *
   * @throws Whatever `unobserve()`/`observe()` throws. The watcher is stopped
   *   first, so it never stays live with a half-rearmed target.
   */
  rearm(target: Element): void {
    if (!this.#observer) return;
    try {
      this.#observer.unobserve(target);
      this.#observer.observe(target);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  /** Severs the observer; late queued callbacks become no-ops via the guard. */
  stop(): void {
    this.#active = false;
    this.#observer?.disconnect();
    this.#observer = null;
    this.#usingPlatformDefaults = false;
  }
}
