import { Controller } from "@hotwired/stimulus";
import { BlurDeferral } from "../utils/blur_deferral";
import { LayoutObserver } from "../utils/layout_observer";
import { logicalScrollMetrics, physicalScrollDelta } from "../utils/logical_scroll";
import { prefersReducedMotion } from "../utils/reduced_motion";

const DIRECTION_BUTTON_SELECTOR = "[data-stimeo--overflow-indicator-direction-param]";

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
 * action, plus {@link LayoutObserver} for viewport/content resize, a
 * {@link MutationObserver}, and descendant load events). Optional page buttons
 * scroll one logical viewport page at a time (including RTL) and have their
 * disabled state synced to the matching direction's remaining room.
 *
 * @remarks
 * Behavior only — shadows, arrows, and gradients are the consumer's CSS;
 * `data-overflow-*` carry no ARIA semantics. All observers/listeners are released
 * on `disconnect()` (Turbo navigation included). `scrollByPage` scrolls smoothly
 * by default and forces an instant jump under `prefers-reduced-motion`, regardless
 * of the consumer's CSS `scroll-behavior`.
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

  readonly #layout = new LayoutObserver(() => {
    if (this.#connected) this.update();
  });
  #connected = false;
  #observedViewport: HTMLElement | null = null;
  readonly #observedContent = new Set<Element>();
  #mutationObserver: MutationObserver | null = null;
  /**
   * Boundary buttons whose native `disabled` is held back while they hold focus.
   *
   * Completing the deferral is what actually disables the button, so the release
   * callback — unlike {@link #cancelPendingButtonDisable} — applies it.
   */
  readonly #pendingButtonDisables = new BlurDeferral<HTMLButtonElement>((button) => {
    this.#restorePendingMarkers(button);
    // If the author disabled it while focus was pending, do not claim ownership.
    if (!button.disabled) this.#disableButton(button);
  });
  /** Last reported room, so `change` fires only on transitions. */
  #state: { start: boolean; end: boolean } | null = null;

  override connect(): void {
    this.#connected = true;
    this.#syncViewport();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#stopObservingViewport();
    this.#layout.disconnect();
    this.#clearPendingButtonDisables();
    this.#state = null;
  }

  viewportTargetConnected(): void {
    this.#syncViewport();
  }

  viewportTargetDisconnected(viewport: HTMLElement): void {
    if (this.#observedViewport === viewport) this.#stopObservingViewport();
    this.#syncViewport();
  }

  orientationValueChanged(): void {
    if (this.#connected) this.update();
  }

  thresholdValueChanged(): void {
    if (this.#connected) this.update();
  }

  /**
   * Re-measures remaining scroll room and reflects the state hooks.
   * Public so it can be wired to the viewport's `scroll`.
   */
  update(): void {
    if (!this.hasViewportTarget) return;
    const vp = this.viewportTarget;
    const horizontal = this.orientationValue !== "vertical";
    const t = this.#threshold;
    const { position: scrollPos, max: maxScroll } = logicalScrollMetrics(vp, horizontal);

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
    if (this.#state && !this.#state[direction]) return;

    const vp = this.viewportTarget;
    const horizontal = this.orientationValue !== "vertical";
    const page = horizontal ? vp.clientWidth : vp.clientHeight;
    const logicalDelta = direction === "start" ? -page : page;
    const delta = physicalScrollDelta(vp, horizontal, logicalDelta);
    const behavior: ScrollBehavior = prefersReducedMotion() ? "instant" : "smooth";

    if (horizontal) {
      vp.scrollBy({ left: delta, behavior });
    } else {
      vp.scrollBy({ top: delta, behavior });
    }
  }

  /** Mirrors remaining room onto any direction buttons by toggling `disabled`. */
  #syncButtons(start: boolean, end: boolean): void {
    for (const button of this.#pendingButtonDisables.elements) {
      if (
        !button.isConnected ||
        button.closest("[data-controller~='stimeo--overflow-indicator']") !== this.element
      ) {
        this.#cancelPendingButtonDisable(button);
      }
    }
    const buttons = this.element.querySelectorAll<HTMLButtonElement>(DIRECTION_BUTTON_SELECTOR);
    for (const button of buttons) {
      if (button.closest("[data-controller~='stimeo--overflow-indicator']") !== this.element) {
        continue;
      }
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
    // A restored Turbo snapshot can carry pending markers from the previous visit
    // that this instance never created; release them from the DOM record before
    // deciding, or the displaced `aria-disabled` would never be given back.
    if (
      !this.#pendingButtonDisables.has(button) &&
      button.hasAttribute("data-overflow-indicator-pending-disabled")
    ) {
      this.#cancelPendingButtonDisable(button);
    }
    if (hasRoom) {
      this.#cancelPendingButtonDisable(button);
      if (button.hasAttribute("data-overflow-indicator-disabled")) {
        button.disabled = false;
        button.removeAttribute("data-overflow-indicator-disabled");
      }
      return;
    }
    if (button.disabled) return; // already disabled (possibly by the author) — leave it
    if (document.activeElement === button) {
      this.#deferButtonDisable(button);
    } else {
      this.#disableButton(button);
    }
  }

  /**
   * Keeps a boundary button focusable until native blur, exposing its temporary
   * inoperability with `aria-disabled` and making its action a no-op meanwhile.
   */
  #deferButtonDisable(button: HTMLButtonElement): void {
    if (this.#pendingButtonDisables.has(button)) return;
    button.setAttribute("data-overflow-indicator-pending-disabled", "");
    // The ownership marker carries the value we displace, so the DOM alone is
    // enough to undo it. A Turbo snapshot is cloned before `disconnect()` runs,
    // so a restored page arrives with these markers while the new instance has
    // no in-memory record of them — an empty marker means "there was none".
    button.setAttribute(
      "data-overflow-indicator-aria-disabled",
      button.getAttribute("aria-disabled") ?? "",
    );
    button.setAttribute("aria-disabled", "true");
    this.#pendingButtonDisables.defer(button);
  }

  #disableButton(button: HTMLButtonElement): void {
    button.disabled = true;
    button.setAttribute("data-overflow-indicator-disabled", "");
  }

  /** Cancels a pending disable without applying it, restoring the displaced state. */
  #cancelPendingButtonDisable(button: HTMLButtonElement): void {
    this.#pendingButtonDisables.release(button);
    this.#restorePendingMarkers(button);
  }

  /**
   * Drops the pending marker and gives back the `aria-disabled` it displaced.
   *
   * Reads the displaced value from the DOM rather than memory: a Turbo snapshot is
   * cloned before `disconnect()` runs, so a restored page can arrive with markers
   * this instance never wrote.
   */
  #restorePendingMarkers(button: HTMLButtonElement): void {
    button.removeAttribute("data-overflow-indicator-pending-disabled");
    const displaced = button.getAttribute("data-overflow-indicator-aria-disabled");
    if (displaced !== null) {
      button.removeAttribute("data-overflow-indicator-aria-disabled");
      if (button.getAttribute("aria-disabled") === "true") {
        if (displaced === "") button.removeAttribute("aria-disabled");
        else button.setAttribute("aria-disabled", displaced);
      }
    }
  }

  #clearPendingButtonDisables(): void {
    for (const button of this.#pendingButtonDisables.elements) {
      this.#cancelPendingButtonDisable(button);
    }
  }

  /** Moves resize/mutation/load observation to the current viewport target. */
  #syncViewport(): void {
    if (!this.#connected) return;
    const next = this.hasViewportTarget ? this.viewportTarget : null;
    if (next === this.#observedViewport) return;
    this.#stopObservingViewport();
    if (!next) return;

    this.#observedViewport = next;
    this.#layout.observe(next);
    this.#layout.observeViewport();
    next.addEventListener("load", this.#onContentLoad, true);
    this.#syncContentObservation();

    if (typeof MutationObserver !== "undefined") {
      this.#mutationObserver = new MutationObserver(() => {
        if (!this.#connected || this.#observedViewport !== next) return;
        this.#syncContentObservation();
        this.update();
      });
      this.#mutationObserver.observe(this.element, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden"],
      });
    }
    this.#state = null;
    this.update();
  }

  /** Observes direct content boxes whose resize can change the viewport's scroll extent. */
  #syncContentObservation(): void {
    const next = new Set<Element>(this.#observedViewport?.children ?? []);
    for (const content of this.#observedContent) {
      if (!next.has(content)) {
        this.#layout.unobserve(content);
        this.#observedContent.delete(content);
      }
    }
    for (const content of next) {
      if (!this.#observedContent.has(content)) {
        this.#observedContent.add(content);
        this.#layout.observe(content);
      }
    }
  }

  #stopObservingViewport(): void {
    this.#mutationObserver?.disconnect();
    this.#mutationObserver = null;
    this.#observedViewport?.removeEventListener("load", this.#onContentLoad, true);
    if (this.#observedViewport) this.#layout.unobserve(this.#observedViewport);
    for (const content of this.#observedContent) this.#layout.unobserve(content);
    this.#observedContent.clear();
    this.#observedViewport = null;
    this.#layout.unobserveViewport();
  }

  readonly #onContentLoad = (): void => {
    if (this.#connected) this.update();
  };

  get #threshold(): number {
    const value = this.thresholdValue;
    return Number.isFinite(value) ? Math.max(0, value) : 1;
  }

  #directionFromEvent(event: Event): "start" | "end" | null {
    const params = (event as Event & { params?: { direction?: unknown } }).params;
    const direction = params?.direction;
    return direction === "start" || direction === "end" ? direction : null;
  }
}
