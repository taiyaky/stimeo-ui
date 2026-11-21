/**
 * Shared `IntersectionObserver` plumbing for Stimeo's scroll-triggered
 * controllers (`intersection`, `scrollspy`, `sticky-observer`, `lazy-frame`).
 *
 * It centralizes the `IntersectionObserver` support guard, root resolution from
 * a selector (degrading to the viewport rather than failing), observer
 * creation/teardown, the **active guard** (the browser may
 * flush a final queued callback batch right after `disconnect()`, and a
 * detached controller must not mutate possibly-cached DOM), and the
 * unobserve→observe **re-arm** that re-delivers the current state even when the
 * target never leaves the viewport.
 *
 * Like `RovingTabindex` and `FocusTrap`, this is a policy-free internal
 * util: what an intersection *means* (a spied link, a stuck header, a lazy
 * load) stays in each controller. The public `stimeo--intersection` controller
 * is its thin declarative face.
 */

import { parseDeclared } from "./declared_value";

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

/**
 * Resolves an observation root from a selector. Every reading of "no root" ends
 * at the same place — absent, matching nothing, or not parsing at all (a typo in
 * a data attribute) — so the observation falls back to the viewport instead of
 * leaving the caller inert with no state hooks published at all.
 */
function queryRoot(selector: string | undefined): Element | null {
  if (!selector) return null;
  return parseDeclared(selector, (raw) => document.querySelector(raw), null);
}

export interface IntersectionWatchOptions {
  /**
   * The observation root. Pass an element (or `null` for the viewport) when
   * the caller already resolved it; omit to resolve from `rootSelector`.
   */
  root?: Element | null;
  /**
   * Selector for the observation root; empty/omitted = viewport. A selector
   * that matches nothing or does not parse also means the viewport.
   */
  rootSelector?: string;
  rootMargin?: string;
  threshold?: number | number[];
}

/** Observer ownership and published state for one start attempt. */
interface IntersectionSession {
  observer: IntersectionObserver | null;
  active: boolean;
  usingPlatformDefaults: boolean;
}

export class IntersectionWatcher {
  readonly #onEntries: (entries: IntersectionObserverEntry[]) => void;
  #session: IntersectionSession | null = null;

  constructor(onEntries: (entries: IntersectionObserverEntry[]) => void) {
    this.#onEntries = onEntries;
  }

  /** Whether an observer is live (started, `IntersectionObserver` supported). */
  get active(): boolean {
    return this.#session?.active ?? false;
  }

  /** Whether the live observer discarded configured options after construction failed. */
  get usingPlatformDefaults(): boolean {
    return this.#session?.usingPlatformDefaults ?? false;
  }

  /**
   * (Re)creates the observer and observes `targets`. Returns `false` — leaving
   * the watcher inert — without `IntersectionObserver` support (very old
   * browsers; the caller's no-JS fallback stays in charge) or with no targets.
   * If initial construction with the configured options fails, the watcher
   * warns and retries once with the same root and platform defaults. A
   * `rootSelector` that does not parse resolves to the viewport (see
   * {@link IntersectionWatchOptions.rootSelector}), so a typo never fails the
   * call.
   *
   * A later `start()` or `stop()` made synchronously while options, construction,
   * warnings, or observation run supersedes this attempt. An interrupted attempt
   * releases its partial observation and returns `false`; it cannot publish state
   * or roll back the later operation. Defaults remain unpublished until every
   * target has been observed.
   *
   * @throws The fallback constructor error if both construction attempts fail,
   *   or whatever the platform throws from `observe()`. The exception is passed
   *   through unchanged, but the failed attempt rolls back first: every target it
   *   observed is released. Without a later operation, `active` stays `false` and
   *   a retry starts from a clean slate; a later operation keeps its own state.
   */
  start(targets: Element | readonly Element[], options: IntersectionWatchOptions = {}): boolean {
    const previous = this.#session;
    const session: IntersectionSession = {
      observer: null,
      active: false,
      usingPlatformDefaults: false,
    };
    this.#session = session;
    let observer: IntersectionObserver | null = null;
    try {
      if (previous) this.#release(previous);
      if (this.#session !== session) return false;
      if (typeof IntersectionObserver === "undefined") return false;
      const list = Array.isArray(targets) ? (targets as readonly Element[]) : [targets as Element];
      const empty = list.length === 0;
      if (this.#session !== session) return false;
      if (empty) return false;
      const root = "root" in options ? (options.root ?? null) : queryRoot(options.rootSelector);
      if (this.#session !== session) return false;
      const onEntries = (entries: IntersectionObserverEntry[]): void => {
        if (this.#session === session && session.active) this.#onEntries(entries);
      };
      let usingPlatformDefaults = false;
      try {
        const configured = {
          root,
          rootMargin: options.rootMargin,
          threshold: options.threshold,
        };
        if (this.#session !== session) return false;
        observer = new IntersectionObserver(onEntries, configured);
      } catch (error) {
        if (this.#session !== session) return false;
        console.warn(
          "Stimeo UI: IntersectionObserver could not be constructed with the configured options; retrying with platform defaults.",
          error,
        );
        if (this.#session !== session) return false;
        observer = new IntersectionObserver(onEntries, { root });
        usingPlatformDefaults = true;
      }
      if (this.#session !== session) {
        this.#release(session, observer);
        return false;
      }
      session.observer = observer;
      for (const target of list) {
        if (this.#session !== session) return false;
        observer.observe(target);
        if (this.#session !== session) {
          this.#release(session, observer);
          return false;
        }
      }
      if (this.#session !== session) return false;
      session.usingPlatformDefaults = usingPlatformDefaults;
      session.active = true;
      return true;
    } catch (error) {
      this.#release(session, observer);
      throw error;
    }
  }

  /**
   * Re-delivers `target`'s CURRENT intersection state: `IntersectionObserver`
   * only reports *changes*, but `observe()` always reports the present state,
   * so unobserve→observe turns "still intersecting" into a fresh callback.
   *
   * A later start or stop interrupts the re-arm without changing that later
   * operation's state.
   *
   * @throws Whatever `unobserve()`/`observe()` throws. Its session is released
   *   first, so it never stays live with a half-rearmed target.
   */
  rearm(target: Element): void {
    const session = this.#session;
    const observer = session?.observer;
    if (!session?.active || !observer) return;
    try {
      observer.unobserve(target);
      if (this.#session !== session) return;
      observer.observe(target);
      if (this.#session !== session) this.#release(session, observer);
    } catch (error) {
      if (this.#session === session) this.#session = null;
      this.#release(session, observer);
      throw error;
    }
  }

  /** Severs the observer; late queued callbacks become no-ops via the guard. */
  stop(): void {
    const session = this.#session;
    this.#session = null;
    if (session) this.#release(session);
  }

  /** Releases only this session, including a constructor or observation interrupted by reentry. */
  #release(
    session: IntersectionSession,
    observer: IntersectionObserver | null = session.observer,
  ): void {
    session.observer = null;
    observer?.disconnect();
  }
}
