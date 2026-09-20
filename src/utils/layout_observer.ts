/**
 * Unified layout observation for Stimeo controllers.
 *
 * Widgets whose output is measured — an overflow boundary, a masonry column count,
 * an autosized textarea — have three sources that move the layout under them: their
 * *own* box changing — via {@link ResizeObserver} — the *viewport* changing — via the
 * `window` `resize` event — and a descendant *resource settling*, because an image or
 * a frame reports a height of zero until it has loaded. Wiring those three by hand in
 * every controller risks leaked listeners on `disconnect()`. {@link LayoutObserver}
 * owns all three behind one callback and one
 * {@link LayoutObserver.disconnect | disconnect()} that releases everything.
 *
 * Behavior only: the helper reports *that* layout changed; it never reads or
 * writes styles. Consumers decide what to recompute.
 */

/** Invoked whenever an observed element or the viewport changes size. */
export type LayoutCallback = () => void;

/** Constructs a {@link ResizeObserver}; injectable so tests stay deterministic. */
export type ResizeObserverFactory = (callback: ResizeObserverCallback) => ResizeObserver;

/** Options for {@link LayoutObserver}. */
export interface LayoutObserverOptions {
  /**
   * Factory for the {@link ResizeObserver} used by {@link LayoutObserver.observe}.
   * Defaults to the global constructor; override it in tests, or to no-op in
   * environments where `ResizeObserver` is unavailable.
   */
  resizeObserverFactory?: ResizeObserverFactory;
}

/**
 * Observes element resizes and/or viewport resizes through a single callback,
 * with guaranteed teardown.
 *
 * @example
 * ```ts
 * #layout = new LayoutObserver(() => this.#reposition());
 *
 * connect() {
 *   this.#layout.observe(this.panelTarget);
 *   this.#layout.observeViewport();
 *   this.#layout.observeDescendantLoads(this.panelTarget);
 * }
 *
 * disconnect() {
 *   this.#layout.disconnect();
 * }
 * ```
 */
export class LayoutObserver {
  readonly #callback: LayoutCallback;
  readonly #resizeObserverFactory: ResizeObserverFactory | null;
  #resizeObserver: ResizeObserver | null = null;
  #observingViewport = false;
  #loadContainer: Element | null = null;

  /** Stable bound handler so add/removeEventListener target the same reference. */
  readonly #handleViewportResize = (): void => {
    this.#callback();
  };

  /** Stable bound handler for the capture-phase `load`; see {@link observeDescendantLoads}. */
  readonly #handleDescendantLoad = (): void => {
    this.#callback();
  };

  constructor(callback: LayoutCallback, options: LayoutObserverOptions = {}) {
    this.#callback = callback;
    this.#resizeObserverFactory =
      options.resizeObserverFactory ??
      (typeof ResizeObserver === "undefined" ? null : (cb) => new ResizeObserver(cb));
  }

  /**
   * Starts observing an element's size. Repeated calls observe additional
   * elements through the same shared observer. No-ops when no
   * `ResizeObserver` implementation is available.
   */
  observe(element: Element): void {
    if (!this.#resizeObserverFactory) return;
    if (!this.#resizeObserver) {
      this.#resizeObserver = this.#resizeObserverFactory(() => {
        this.#callback();
      });
    }
    this.#resizeObserver.observe(element);
  }

  /** Stops observing a single element while leaving any others in place. */
  unobserve(element: Element): void {
    this.#resizeObserver?.unobserve(element);
  }

  /** Starts observing viewport resizes. Idempotent: the listener is added once. */
  observeViewport(): void {
    if (this.#observingViewport) return;
    this.#observingViewport = true;
    window.addEventListener("resize", this.#handleViewportResize);
  }

  /** Stops observing viewport resizes without affecting element observation. */
  unobserveViewport(): void {
    if (!this.#observingViewport) return;
    this.#observingViewport = false;
    window.removeEventListener("resize", this.#handleViewportResize);
  }

  /**
   * Starts reporting a `load` from anywhere inside `container` — an image or a
   * frame settling changes the box it sits in, and it measures as zero high until
   * then. `load` does not bubble, so the subscription is a capture-phase listener
   * on the container itself and nothing the caller spells.
   *
   * **One container at a time.** A further call moves the observation, so a widget
   * whose content element is swapped at runtime releases the element it let go by
   * naming the new one — there is no second place for the release to drift from.
   */
  observeDescendantLoads(container: Element): void {
    this.unobserveDescendantLoads();
    this.#loadContainer = container;
    container.addEventListener("load", this.#handleDescendantLoad, true);
  }

  /** Stops reporting descendant loads without affecting element or viewport observation. */
  unobserveDescendantLoads(): void {
    this.#loadContainer?.removeEventListener("load", this.#handleDescendantLoad, true);
    this.#loadContainer = null;
  }

  /**
   * Releases every observation: disconnects the {@link ResizeObserver} and removes
   * the viewport and descendant-load listeners. Safe to call multiple times. Call
   * this from a controller's `disconnect()`.
   */
  disconnect(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.unobserveViewport();
    this.unobserveDescendantLoads();
  }
}
