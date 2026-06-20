import { Controller } from "@hotwired/stimulus";
import { LayoutObserver } from "../utils/layout_observer";

/**
 * Headless **Overflow Indicator**: detects whether a scroll container can still
 * scroll toward its start and/or end and publishes it as `data-overflow-start` /
 * `data-overflow-end`. No APG widget — a state-detection utility. Consumers draw
 * edge shadows or arrows in CSS to signal "more content this way".
 *
 * Markup contract (identifier: `stimeo--overflow-indicator`):
 *   <div data-controller="stimeo--overflow-indicator"
 *        data-stimeo--overflow-indicator-orientation-value="horizontal">
 *     <button type="button" aria-label="Prev"
 *             data-stimeo--overflow-indicator-direction-param="start"
 *             data-action="click->stimeo--overflow-indicator#scrollByPage">‹</button>
 *     <div data-stimeo--overflow-indicator-target="viewport"
 *          data-action="scroll->stimeo--overflow-indicator#update"
 *          tabindex="0" role="region" aria-label="Products"
 *          style="overflow-x: auto;"><!-- items --></div>
 *     <button type="button" aria-label="Next"
 *             data-stimeo--overflow-indicator-direction-param="end"
 *             data-action="click->stimeo--overflow-indicator#scrollByPage">›</button>
 *   </div>
 *
 * The viewport's scroll position and size are watched (via the wired `scroll`
 * action, plus {@link LayoutObserver} for resize and a {@link MutationObserver}
 * for content changes). Optional page buttons scroll one viewport at a time and
 * have their `disabled` synced to the matching direction's remaining room.
 *
 * @remarks
 * Behavior only — shadows, arrows, and gradients are the consumer's CSS;
 * `data-overflow-*` carry no ARIA semantics. All observers/listeners are released
 * on `disconnect()` (Turbo navigation included). `scrollByPage` honors
 * `prefers-reduced-motion`.
 */
export class OverflowIndicatorController extends Controller<HTMLElement> {
  static override targets = ["viewport"];
  static override values = {
    orientation: { type: String, default: "horizontal" },
    threshold: { type: Number, default: 1 },
  };
  static actions = ["scrollByPage", "update"] as const;
  static events = ["change"] as const;

  declare readonly viewportTarget: HTMLElement;
  declare readonly hasViewportTarget: boolean;

  declare orientationValue: string;
  declare thresholdValue: number;

  readonly #layout = new LayoutObserver(() => this.update());
  #mutationObserver: MutationObserver | null = null;
  /** Last reported room, so `change` fires only on transitions. */
  #state: { start: boolean; end: boolean } | null = null;

  override connect(): void {
    if (!this.hasViewportTarget) return;
    this.#layout.observe(this.viewportTarget);
    this.#layout.observeViewport();

    if (typeof MutationObserver !== "undefined") {
      this.#mutationObserver = new MutationObserver(() => this.update());
      this.#mutationObserver.observe(this.viewportTarget, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    this.update();
  }

  override disconnect(): void {
    this.#layout.disconnect();
    this.#mutationObserver?.disconnect();
    this.#mutationObserver = null;
    this.#state = null;
  }

  /** Re-measures remaining scroll room and reflects the state hooks. Public so it can be wired to the viewport's `scroll`. */
  update(): void {
    if (!this.hasViewportTarget) return;
    const vp = this.viewportTarget;
    const horizontal = this.orientationValue !== "vertical";
    const t = this.thresholdValue;

    const scrollPos = horizontal ? vp.scrollLeft : vp.scrollTop;
    const maxScroll = horizontal
      ? vp.scrollWidth - vp.clientWidth
      : vp.scrollHeight - vp.clientHeight;

    const start = scrollPos > t;
    const end = scrollPos < maxScroll - t;

    vp.setAttribute("data-overflow-start", start ? "true" : "false");
    vp.setAttribute("data-overflow-end", end ? "true" : "false");
    this.#syncButtons(start, end);

    if (!this.#state || this.#state.start !== start || this.#state.end !== end) {
      this.#state = { start, end };
      this.dispatch("change", { detail: { start, end } });
    }
  }

  /** Scrolls one viewport page toward the `direction` param (`start`/`end`). */
  scrollByPage(event: Event): void {
    if (!this.hasViewportTarget) return;
    const direction = this.#directionFromEvent(event);
    if (!direction) return;

    const vp = this.viewportTarget;
    const horizontal = this.orientationValue !== "vertical";
    const page = horizontal ? vp.clientWidth : vp.clientHeight;
    const delta = direction === "start" ? -page : page;
    const behavior: ScrollBehavior = this.#prefersReducedMotion() ? "auto" : "smooth";

    if (horizontal) {
      vp.scrollBy({ left: delta, behavior });
    } else {
      vp.scrollBy({ top: delta, behavior });
    }
  }

  /** Mirrors remaining room onto any direction buttons by toggling `disabled`. */
  #syncButtons(start: boolean, end: boolean): void {
    const buttons = this.element.querySelectorAll<HTMLButtonElement>(
      "[data-stimeo--overflow-indicator-direction-param]",
    );
    for (const button of buttons) {
      const direction = button.getAttribute("data-stimeo--overflow-indicator-direction-param");
      if (direction === "start") this.#toggleButton(button, start);
      else if (direction === "end") this.#toggleButton(button, end);
    }
  }

  /**
   * Reflects the remaining room onto a page button's `disabled`, owning only the
   * `disabled` it sets itself via a marker (`data-overflow-indicator-disabled`,
   * like `number-input`/`conditional-fields`). An author-disabled button (e.g. the
   * whole control disabled) is therefore never blindly re-enabled.
   */
  #toggleButton(button: HTMLButtonElement, hasRoom: boolean): void {
    if (hasRoom) {
      if (button.hasAttribute("data-overflow-indicator-disabled")) {
        button.disabled = false;
        button.removeAttribute("data-overflow-indicator-disabled");
      }
      return;
    }
    if (button.disabled) return; // already disabled (possibly by the author) — leave it
    button.disabled = true;
    button.setAttribute("data-overflow-indicator-disabled", "");
  }

  #directionFromEvent(event: Event): "start" | "end" | null {
    const params = (event as Event & { params?: { direction?: unknown } }).params;
    const direction = params?.direction;
    return direction === "start" || direction === "end" ? direction : null;
  }

  #prefersReducedMotion(): boolean {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }
}
