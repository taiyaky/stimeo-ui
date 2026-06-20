import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless skeleton/placeholder manager. No dedicated APG pattern; it follows
 * the `aria-busy` + show/hide practice.
 *
 * Markup contract (identifier: `stimeo--skeleton`):
 *   <div data-controller="stimeo--skeleton" aria-busy="true"
 *        data-stimeo--skeleton-min-duration-value="300"
 *        data-action="content:ready->stimeo--skeleton#ready">
 *     <div aria-hidden="true" data-stimeo--skeleton-target="placeholder"></div>
 *     <div hidden data-stimeo--skeleton-target="content"></div>
 *   </div>
 *
 * Starts in the loading state (placeholder shown, real content hidden, region
 * `aria-busy="true"`); `ready` swaps to the content and clears busy. The
 * placeholder is `aria-hidden` (decorative) so assistive tech never reads the
 * skeleton. `minDuration` keeps the placeholder up long enough to avoid a flash
 * when content arrives almost immediately.
 *
 * @remarks
 * Behavior only — skeleton shapes/animation are the consumer's. The
 * min-duration timer is owned by {@link SafeTimeout} and torn down on
 * `disconnect()` (Turbo navigation included).
 */
export class SkeletonController extends Controller<HTMLElement> {
  static override targets = ["placeholder", "content"];
  static override values = {
    minDuration: { type: Number, default: 0 },
  };
  static actions = ["ready", "reset"] as const;
  static events = ["ready"] as const;

  declare readonly placeholderTarget: HTMLElement;
  declare readonly contentTarget: HTMLElement;
  declare readonly hasPlaceholderTarget: boolean;
  declare readonly hasContentTarget: boolean;

  declare minDurationValue: number;

  readonly #timers = new SafeTimeout();

  /** Pending min-duration reveal timer id, or `null` when none is scheduled. */
  #revealTimerId: number | null = null;
  /** Epoch ms when the loading state began, used to enforce `minDuration`. */
  #loadingSince = 0;

  override connect(): void {
    if (this.#state !== "ready") {
      this.#enterLoading();
    }
  }

  override disconnect(): void {
    this.#timers.clearAll();
    this.#revealTimerId = null;
  }

  /** Swaps to the real content. Honors `minDuration` to prevent a flash. */
  ready(): void {
    if (this.#state === "ready" || this.#revealTimerId !== null) return;
    const remaining = this.minDurationValue - (Date.now() - this.#loadingSince);
    if (remaining > 0) {
      this.#revealTimerId = this.#timers.set(() => {
        this.#revealTimerId = null;
        this.#reveal();
      }, remaining);
    } else {
      this.#reveal();
    }
  }

  /** Returns to the loading state (e.g. a Turbo Stream re-fetch). */
  reset(): void {
    if (this.#revealTimerId !== null) {
      this.#timers.clear(this.#revealTimerId);
      this.#revealTimerId = null;
    }
    this.#enterLoading();
  }

  /** Shows the placeholder, hides content, and marks the region busy. */
  #enterLoading(): void {
    this.#loadingSince = Date.now();
    if (this.hasPlaceholderTarget) this.placeholderTarget.hidden = false;
    if (this.hasContentTarget) this.contentTarget.hidden = true;
    this.element.setAttribute("aria-busy", "true");
    this.element.setAttribute("data-state", "loading");
  }

  /** Hides the placeholder, shows content, and clears the busy state. */
  #reveal(): void {
    if (this.hasPlaceholderTarget) this.placeholderTarget.hidden = true;
    if (this.hasContentTarget) this.contentTarget.hidden = false;
    this.element.setAttribute("aria-busy", "false");
    this.element.setAttribute("data-state", "ready");
    this.dispatch("ready", { detail: {} });
  }

  /** Current lifecycle phase as reflected on `data-state`. */
  get #state(): string {
    return this.element.getAttribute("data-state") ?? "loading";
  }
}
