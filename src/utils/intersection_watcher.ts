/**
 * Shared `IntersectionObserver` plumbing for Stimeo's scroll-triggered
 * controllers (`intersection`, `scrollspy`, `sticky-observer`, `lazy-frame`).
 *
 * These controllers each grew a separate implementation of the same idea;
 * this util is that idea written once — the boilerplate every consumer
 * repeated: the `IntersectionObserver` support guard, root resolution from a
 * selector, observer creation/teardown, the **active guard** (the browser may
 * flush a final queued callback batch right after `disconnect()`, and a
 * detached controller must not mutate possibly-cached DOM), and the
 * unobserve→observe **re-arm** that re-delivers the current state (the
 * infinite-scroll "sentinel never left the viewport" fix).
 *
 * Like {@link RovingTabindex} and `FocusTrap`, this is a policy-free internal
 * util: what an intersection *means* (a spied link, a stuck header, a lazy
 * load) stays in each controller. The public `stimeo--intersection` controller
 * is its thin declarative face.
 */
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

  constructor(onEntries: (entries: IntersectionObserverEntry[]) => void) {
    this.#onEntries = onEntries;
  }

  /** Whether an observer is live (started, `IntersectionObserver` supported). */
  get active(): boolean {
    return this.#active;
  }

  /**
   * (Re)creates the observer and observes `targets`. Returns `false` — leaving
   * the watcher inert — without `IntersectionObserver` support (very old
   * browsers; the caller's no-JS fallback stays in charge) or with no targets.
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

    this.#active = true;
    this.#observer = new IntersectionObserver(
      (entries) => {
        if (this.#active) this.#onEntries(entries);
      },
      { root, rootMargin: options.rootMargin, threshold: options.threshold },
    );
    for (const target of list) this.#observer.observe(target);
    return true;
  }

  /**
   * Re-delivers `target`'s CURRENT intersection state: `IntersectionObserver`
   * only reports *changes*, but `observe()` always reports the present state,
   * so unobserve→observe turns "still intersecting" into a fresh callback.
   */
  rearm(target: Element): void {
    if (!this.#observer) return;
    this.#observer.unobserve(target);
    this.#observer.observe(target);
  }

  /** Severs the observer; late queued callbacks become no-ops via the guard. */
  stop(): void {
    this.#active = false;
    this.#observer?.disconnect();
    this.#observer = null;
  }
}
