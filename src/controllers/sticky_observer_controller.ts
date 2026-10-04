import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
import { IntersectionWatcher, isBeforeRootStart } from "../utils/intersection_watcher";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";

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
 * `change` dispatches `{ stuck: boolean }`.
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
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["sentinel", "element"];
  static override values = {
    rootSelector: { type: String, default: "" },
    offset: { type: Number, default: 0 },
  };

  static valueConstraints = {
    offset: NUMBER_BOUNDS.finite,
  } satisfies NumberValueConstraints<typeof StickyObserverController.values>;
  static events = ["change"] as const;

  declare readonly sentinelTarget: HTMLElement;
  declare readonly elementTarget: HTMLElement;
  declare readonly elementTargets: HTMLElement[];
  declare readonly hasSentinelTarget: boolean;
  declare readonly hasElementTarget: boolean;

  declare rootSelectorValue: string;
  declare offsetValue: number;

  /** Shared IO plumbing (support guard, root resolution, active guard). */
  readonly #watcher = new IntersectionWatcher((entries) => this.#onIntersect(entries));
  /** Owns each sticky element's `data-stuck`, so one that departs gets its own back. */
  readonly #stuckLease = new AttributeLease<HTMLElement>("data-stuck", this.identifier);
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
      // as stuck; the state is not-stuck until the sentinel is actually laid out.
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
    if (this.#stuck !== null) this.#stuckLease.write(element, String(this.#stuck));
  }

  /**
   * Gives a sticky element that no longer resolves its own `data-stuck` back, even after
   * `disconnect()`, and while connected reflects the last snapshot onto the one that stays.
   */
  elementTargetDisconnected(element: HTMLElement): void {
    if (!this.elementTargets.includes(element)) this.#stuckLease.return(element);
    if (this.#connected && this.#stuck !== null && this.hasElementTarget) {
      this.#stuckLease.write(this.elementTarget, String(this.#stuck));
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

    const configuredOffset = this.#safeOffset;
    const offset = configuredOffset;
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
    if (this.hasElementTarget) this.#stuckLease.write(this.elementTarget, String(next));
    this.dispatch("change", { detail: { stuck: next } });
  }
  /** Current `offset` declaration resolved against its numeric contract. */
  get #safeOffset(): number {
    return this.#numbers.read(
      this,
      "offset",
      this.offsetValue,
      StickyObserverController.values.offset.default,
      StickyObserverController.valueConstraints.offset,
    );
  }
}
