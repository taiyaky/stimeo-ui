import { Controller } from "@hotwired/stimulus";
import { IntersectionWatcher, isBeforeRootStart } from "../utils/intersection_watcher";

/**
 * Headless **Sticky State Observer**: detects whether a `position: sticky`
 * element is currently stuck and publishes it as `data-stuck`. No APG widget — a
 * pure state-detection utility. Detection uses an {@link IntersectionObserver}
 * and a sentinel placed just before the sticky element, avoiding per-frame scroll
 * math.
 *
 * Markup contract (identifier: `stimeo--sticky-observer`):
 *   <div data-controller="stimeo--sticky-observer">
 *     <div data-stimeo--sticky-observer-target="sentinel"
 *          aria-hidden="true" style="height: 1px;"></div>
 *     <header data-stimeo--sticky-observer-target="element"
 *             style="position: sticky; top: 0;">Site heading</header>
 *     <main>…</main>
 *   </div>
 *
 * When the sentinel scrolls out past the top of the viewport (or `rootSelector`
 * container), the sticky element is considered stuck and `data-stuck="true"` is
 * set; otherwise `false`. The observer's initial snapshot dispatches `change`
 * once with the current state, including after a Turbo reconnect; subsequent
 * notifications dispatch only when that state changes.
 *
 * @remarks
 * Behavior only — `position: sticky`, shadows, and shrink effects are the
 * consumer's CSS (`[data-stuck="true"] { … }`). `data-stuck` is a visual hook
 * only: it carries no ARIA role/state. `offset` is negated numerically for the
 * top `rootMargin` (so negative offsets remain valid) and must match the sticky
 * element's CSS `top`. The observer follows dynamic sentinel targets and value
 * changes, and is disconnected on `disconnect()` (Turbo navigation included).
 */
export class StickyObserverController extends Controller<HTMLElement> {
  static override targets = ["sentinel", "element"];
  static override values = {
    rootSelector: { type: String, default: "" },
    offset: { type: Number, default: 0 },
  };
  static events = ["change"] as const;

  declare readonly sentinelTarget: HTMLElement;
  declare readonly elementTarget: HTMLElement;
  declare readonly hasSentinelTarget: boolean;
  declare readonly hasElementTarget: boolean;

  declare rootSelectorValue: string;
  declare offsetValue: number;

  /** Shared IO plumbing (support guard, root resolution, active guard). */
  readonly #watcher = new IntersectionWatcher((entries) => this.#onIntersect(entries));
  /** Last reported stuck state, so `change` fires only on transitions. */
  #stuck: boolean | null = null;
  /** Target currently owned by the watcher; comparing it avoids duplicate restarts. */
  #observedSentinel: HTMLElement | null = null;
  #connected = false;

  #onIntersect(entries: IntersectionObserverEntry[]): void {
    // Delivery can batch multiple transitions after a fast scroll. Process
    // every snapshot in order so an above→visible pair is not collapsed.
    for (const entry of entries) {
      if (!this.#connected || !this.#watcher.active) return;
      // A sentinel with no layout box (hidden tab panel, collapsed section, an
      // undisplayed Turbo Frame) reports an empty rect that the shared edge test
      // deliberately refuses, so an unrendered sticky element is never published
      // as stuck; the state stays put until the sentinel is actually laid out.
      this.#setStuck(!entry.isIntersecting && isBeforeRootStart(entry));
    }
  }

  override connect(): void {
    this.#connected = true;
    this.#stuck = null;
    this.#syncObserver();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#watcher.stop();
    this.#observedSentinel = null;
    this.#stuck = null;
  }

  /** Starts observation when a sentinel is inserted after connection. */
  sentinelTargetConnected(): void {
    if (this.#connected) this.#syncObserver();
  }

  /** Stops or transfers observation when the current sentinel is removed. */
  sentinelTargetDisconnected(): void {
    if (this.#connected) this.#syncObserver();
  }

  /** Reflects the last snapshot onto an element inserted after that snapshot. */
  elementTargetConnected(element: HTMLElement): void {
    if (this.#stuck !== null) {
      element.setAttribute("data-stuck", this.#stuck ? "true" : "false");
    }
  }

  /** Rebuilds the observer when Turbo morphs the configured root. */
  rootSelectorValueChanged(): void {
    if (this.#connected) this.#syncObserver(true);
  }

  /** Rebuilds the observer when Turbo morphs the configured top offset. */
  offsetValueChanged(): void {
    if (this.#connected) this.#syncObserver(true);
  }

  #syncObserver(force = false): void {
    const sentinel = this.hasSentinelTarget ? this.sentinelTarget : null;
    if (!force && sentinel === this.#observedSentinel && this.#watcher.active) return;

    this.#watcher.stop();
    this.#observedSentinel = null;
    if (!sentinel) return;

    const configuredOffset = this.offsetValue;
    const offset = Number.isFinite(configuredOffset) ? configuredOffset : 0;
    const started = this.#watcher.start(sentinel, {
      rootSelector: this.rootSelectorValue,
      rootMargin: `${-offset}px 0px 0px 0px`,
      threshold: [0],
    });
    if (started) this.#observedSentinel = sentinel;
  }

  /** Reflects the stuck state onto the sticky element and emits `change`. */
  #setStuck(next: boolean): void {
    if (next === this.#stuck) return;
    this.#stuck = next;
    if (this.hasElementTarget) {
      this.elementTarget.setAttribute("data-stuck", next ? "true" : "false");
    }
    this.dispatch("change", { detail: { stuck: next } });
  }
}
