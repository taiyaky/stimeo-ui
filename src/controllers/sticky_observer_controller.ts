import { Controller } from "@hotwired/stimulus";

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
 * set; otherwise `false`. The `change` event fires on each transition.
 *
 * @remarks
 * Behavior only — `position: sticky`, shadows, and shrink effects are the
 * consumer's CSS (`[data-stuck="true"] { … }`). `data-stuck` is a visual hook
 * only: it carries no ARIA role/state. `offset` feeds a negative top `rootMargin`
 * and must match the sticky element's CSS `top`. The observer is disconnected on
 * `disconnect()` (Turbo navigation included).
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

  #observer: IntersectionObserver | null = null;
  /** Guards against a queued callback mutating state after teardown. */
  #active = false;
  /** Last reported stuck state, so `change` fires only on transitions. */
  #stuck: boolean | null = null;

  readonly #onIntersect = (entries: IntersectionObserverEntry[]): void => {
    if (!this.#active) return;
    const entry = entries[entries.length - 1];
    if (!entry) return;
    // The sentinel sits above the sticky element; once it is no longer
    // intersecting the (top-inset) root, the sticky element has stuck.
    this.#setStuck(!entry.isIntersecting);
  };

  override connect(): void {
    if (!this.hasSentinelTarget) return;
    this.#active = true;

    if (typeof IntersectionObserver === "undefined") return;
    const root = this.rootSelectorValue
      ? document.querySelector<HTMLElement>(this.rootSelectorValue)
      : null;

    this.#observer = new IntersectionObserver(this.#onIntersect, {
      root,
      rootMargin: `-${this.offsetValue}px 0px 0px 0px`,
      threshold: [0],
    });
    this.#observer.observe(this.sentinelTarget);
  }

  override disconnect(): void {
    this.#active = false;
    this.#observer?.disconnect();
    this.#observer = null;
    this.#stuck = null;
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
