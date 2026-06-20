import { Controller } from "@hotwired/stimulus";
import { LayoutObserver } from "../utils/layout_observer";

/** A CSS selector for natively focusable / author-focusable descendants. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

/** Distance from an edge (px) treated as fully reached; absorbs sub-pixel scroll. */
const EDGE_EPSILON = 1;

/**
 * Headless **Scroll Area** behavior: keyboard reachability and scroll-state hooks
 * for a natively scrolling region. No custom scrollbar — the native one is
 * respected; this only adds a11y and CSS state.
 *
 * Markup contract (identifier: `stimeo--scroll-area`):
 *   <div data-controller="stimeo--scroll-area"
 *        data-stimeo--scroll-area-orientation-value="vertical">
 *     <div data-stimeo--scroll-area-target="viewport" aria-label="Log output">
 *       <!-- long content -->
 *     </div>
 *   </div>
 *
 * When the content overflows and the viewport holds no focusable elements of its
 * own, the viewport is made keyboard-scrollable (`tabindex="0"`, plus `role="region"`
 * when it already has an accessible name). Scroll position is published as
 * `data-scroll` (`start`/`middle`/`end`), overflow as `data-overflow`, and progress
 * as `--stimeo-scroll-progress` (0–1) so consumer CSS can draw scroll shadows.
 *
 * @remarks
 * Behavior only. The `scroll` listener and {@link LayoutObserver} (element +
 * viewport resize) are torn down on `disconnect()` (Turbo navigation included).
 * `role="region"` is added only when the viewport is already named, so a scrollable
 * region never becomes an unlabeled landmark.
 */
export class ScrollAreaController extends Controller<HTMLElement> {
  static override targets = ["viewport"];
  static override values = {
    orientation: { type: String, default: "vertical" },
  };
  static events = ["reach"] as const;

  declare readonly viewportTarget: HTMLElement;
  declare readonly hasViewportTarget: boolean;

  declare orientationValue: string;

  readonly #layout = new LayoutObserver(() => this.#update());
  /** Last edge reported via `reach`, so the event fires once per arrival. */
  #lastEdge: "start" | "end" | null = null;
  /** Whether this controller added `tabindex`, so teardown only removes its own. */
  #addedTabindex = false;
  /** Whether this controller added `role="region"`, for symmetric teardown. */
  #addedRole = false;

  readonly #onScroll = (): void => {
    this.#update();
  };

  override connect(): void {
    if (!this.hasViewportTarget) return;
    this.viewportTarget.addEventListener("scroll", this.#onScroll, { passive: true });
    this.#layout.observe(this.viewportTarget);
    this.#layout.observeViewport();
    this.#update();
  }

  override disconnect(): void {
    if (this.hasViewportTarget) {
      this.viewportTarget.removeEventListener("scroll", this.#onScroll);
      // Remove only the keyboard-reach attributes this controller added, so a
      // Turbo cache snapshot never preserves a controller-owned tab stop /
      // landmark (matches the spec's Turbo-compatibility requirement).
      this.#clearAddedAttributes(this.viewportTarget);
    }
    this.#layout.disconnect();
    this.#lastEdge = null;
  }

  /** Re-measures overflow and scroll position and reflects the state hooks. */
  #update(): void {
    if (!this.hasViewportTarget) return;
    const vp = this.viewportTarget;
    const overflowing = this.#measureOverflow(vp);

    this.element.setAttribute("data-overflow", overflowing ? "true" : "false");
    this.#syncKeyboardReach(vp, overflowing);

    const { position, progress } = this.#measurePosition(vp);
    this.element.setAttribute("data-scroll", position);
    this.element.style.setProperty("--stimeo-scroll-progress", String(progress));

    const edge = position === "start" ? "start" : position === "end" ? "end" : null;
    if (overflowing && edge && edge !== this.#lastEdge) {
      this.#lastEdge = edge;
      this.dispatch("reach", { detail: { edge } });
    } else if (!edge) {
      this.#lastEdge = null;
    }
  }

  /** Whether the viewport can scroll on the configured axis. */
  #measureOverflow(vp: HTMLElement): boolean {
    const o = this.orientationValue;
    const vertical = o !== "horizontal" && vp.scrollHeight > vp.clientHeight + EDGE_EPSILON;
    const horizontal = o !== "vertical" && vp.scrollWidth > vp.clientWidth + EDGE_EPSILON;
    return vertical || horizontal;
  }

  /**
   * Reports the scroll position bucket and 0–1 progress on the primary axis. For
   * `both`, the vertical axis is used when it overflows, otherwise the horizontal.
   */
  #measurePosition(vp: HTMLElement): {
    position: "start" | "middle" | "end";
    progress: number;
  } {
    const horizontalPrimary =
      this.orientationValue === "horizontal" ||
      (this.orientationValue === "both" && vp.scrollHeight <= vp.clientHeight + EDGE_EPSILON);

    const scrollPos = horizontalPrimary ? vp.scrollLeft : vp.scrollTop;
    const maxScroll = horizontalPrimary
      ? vp.scrollWidth - vp.clientWidth
      : vp.scrollHeight - vp.clientHeight;

    if (maxScroll <= EDGE_EPSILON) return { position: "start", progress: 0 };

    const progress = Math.min(1, Math.max(0, scrollPos / maxScroll));
    if (scrollPos <= EDGE_EPSILON) return { position: "start", progress };
    if (scrollPos >= maxScroll - EDGE_EPSILON) return { position: "end", progress };
    return { position: "middle", progress };
  }

  /**
   * Makes the viewport keyboard-scrollable when it overflows and contains no
   * focusable elements of its own (avoiding a double tab stop). Adds `role="region"`
   * only when the viewport already carries an accessible name.
   */
  #syncKeyboardReach(vp: HTMLElement, overflowing: boolean): void {
    const wantsTabindex = overflowing && !this.#hasFocusableContent(vp);

    if (wantsTabindex) {
      if (!vp.hasAttribute("tabindex")) {
        vp.setAttribute("tabindex", "0");
        this.#addedTabindex = true;
      }
      if (!vp.hasAttribute("role") && this.#hasAccessibleName(vp)) {
        vp.setAttribute("role", "region");
        this.#addedRole = true;
      }
    } else {
      this.#clearAddedAttributes(vp);
    }
  }

  /** Removes (and resets the flags for) only the attributes this controller added. */
  #clearAddedAttributes(vp: HTMLElement): void {
    if (this.#addedTabindex) {
      vp.removeAttribute("tabindex");
      this.#addedTabindex = false;
    }
    if (this.#addedRole) {
      vp.removeAttribute("role");
      this.#addedRole = false;
    }
  }

  #hasFocusableContent(vp: HTMLElement): boolean {
    return vp.querySelector(FOCUSABLE_SELECTOR) !== null;
  }

  #hasAccessibleName(vp: HTMLElement): boolean {
    return vp.hasAttribute("aria-label") || vp.hasAttribute("aria-labelledby");
  }
}
