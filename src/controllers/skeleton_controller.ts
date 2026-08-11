import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { MinDurationFloor } from "../utils/min_duration_floor";
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
 * min-duration wait is held by {@link MinDurationFloor} on a {@link SafeTimeout}
 * torn down on `disconnect()` (Turbo navigation included).
 */
export class SkeletonController extends Controller<HTMLElement> {
  static override targets = ["placeholder", "content"];
  static override values = {
    announceReadyText: { type: String, default: "" },
    minDuration: { type: Number, default: 0 },
  };
  static actions = ["ready", "reset"] as const;
  static events = ["ready"] as const;

  declare readonly placeholderTarget: HTMLElement;
  declare readonly contentTarget: HTMLElement;
  declare readonly hasPlaceholderTarget: boolean;
  declare readonly hasContentTarget: boolean;

  declare minDurationValue: number;
  declare announceReadyTextValue: string;

  readonly #timers = new SafeTimeout();
  readonly #floor = new MinDurationFloor(this.#timers);

  override connect(): void {
    if (this.#state !== "ready") {
      this.#enterLoading();
    }
  }

  override disconnect(): void {
    this.#timers.clearAll();
    this.#floor.cancel();
  }

  /** Swaps to the real content. Honors `minDuration` to prevent a flash. */
  ready(): void {
    // The first signal wins: a repeat while the floor still holds the reveal back
    // must not restart the wait, or a stream of ready events keeps postponing it.
    if (this.#state === "ready" || this.#floor.pending) return;
    this.#floor.schedule(this.minDurationValue, () => this.#reveal());
  }

  /** Returns to the loading state (e.g. a Turbo Stream re-fetch). */
  reset(): void {
    this.#floor.cancel();
    this.#enterLoading();
  }

  /** Shows the placeholder, hides content, and marks the region busy. */
  #enterLoading(): void {
    this.#floor.begin();
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
    // loading → ready is the transition; the skeleton itself carries no words.
    announce(fillTemplate(this.announceReadyTextValue, {}));
  }

  /** Current lifecycle phase as reflected on `data-state`. */
  get #state(): string {
    return this.element.getAttribute("data-state") ?? "loading";
  }
}
