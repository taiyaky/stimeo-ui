import { Controller } from "@hotwired/stimulus";
import { LayoutObserver } from "../utils/layout_observer";
import { logicalScrollMetrics } from "../utils/logical_scroll";
import { TabindexLoan } from "../utils/tabindex_loan";

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

/** `Element.checkVisibility` (widely available); absent in older engines. */
interface VisibilityCheckable {
  checkVisibility?: (options?: { visibilityProperty?: boolean }) => boolean;
}

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
 * as `--stimeo--scroll-progress` (0–1) so consumer CSS can draw scroll shadows.
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
  /** Re-checks the tab stop when the viewport's focusable content comes or goes. */
  #content: MutationObserver | null = null;
  /** Last edge reported via `reach`, so the event fires once per arrival. */
  #lastEdge: "start" | "end" | null = null;
  /** Whether this controller added `tabindex`, so teardown only removes its own. */
  readonly #tabindex = new TabindexLoan("0");
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
    // Overflow follows the box, but focusability follows the content, and the two
    // change independently: revealing a button inside a fixed-height viewport fires
    // no resize and no scroll. Without this the tab stop would be stale until the
    // next unrelated event.
    //
    // No `attributeFilter`: what makes a control appear is not confined to its own
    // attributes — a state hook on an ancestor (`[data-has-new] .jump { display: block }`)
    // flips it just as well, and that set cannot be enumerated.
    //
    // The overflow value is re-measured here rather than reused. A content change moves
    // the scroll extent without touching the viewport's own box, so a fixed-height
    // viewport fires no resize when its content shrinks — reusing a cached value would
    // hand the tab stop to a box that does not scroll. Position and `reach` are
    // deliberately left alone: the event contract is arrival at an edge, and a content
    // change is not an arrival.
    if (typeof MutationObserver !== "undefined") {
      this.#content = new MutationObserver(() => {
        if (!this.hasViewportTarget) return;
        const vp = this.viewportTarget;
        this.#syncKeyboardReach(vp, this.#syncOverflow(vp));
      });
      this.#content.observe(this.viewportTarget, {
        subtree: true,
        childList: true,
        attributes: true,
      });
    }
    this.#update();
  }

  override disconnect(): void {
    if (this.hasViewportTarget) {
      this.viewportTarget.removeEventListener("scroll", this.#onScroll);
      // Remove only the keyboard-reach attributes this controller added, so a
      // Turbo cache snapshot never preserves a controller-owned tab stop /
      // landmark (controller-added state must not outlive the controller).
      this.#clearAddedAttributes(this.viewportTarget);
    }
    this.#layout.disconnect();
    this.#content?.disconnect();
    this.#content = null;
    this.#lastEdge = null;
  }

  /** Re-measures overflow and scroll position and reflects the state hooks. */
  #update(): void {
    if (!this.hasViewportTarget) return;
    const vp = this.viewportTarget;
    const overflowing = this.#syncOverflow(vp);
    this.#syncKeyboardReach(vp, overflowing);

    const { position, progress } = this.#measurePosition(vp);
    this.element.setAttribute("data-scroll", position);
    this.element.style.setProperty("--stimeo--scroll-progress", String(progress));

    const edge = position === "start" ? "start" : position === "end" ? "end" : null;
    if (overflowing && edge && edge !== this.#lastEdge) {
      this.#lastEdge = edge;
      this.dispatch("reach", { detail: { edge } });
    } else if (!edge) {
      this.#lastEdge = null;
    }
  }

  /** Whether the viewport can scroll on the configured axis. */
  /**
   * Measures overflow and reflects the `data-overflow` hook.
   *
   * The write is skipped when the value is unchanged. An identical `setAttribute` still
   * queues a MutationRecord, and markup that puts the viewport target on the controller
   * element itself would then have the content observer trigger its own next callback.
   */
  #syncOverflow(vp: HTMLElement): boolean {
    const overflowing = this.#measureOverflow(vp);
    const next = overflowing ? "true" : "false";
    if (this.element.getAttribute("data-overflow") !== next) {
      this.element.setAttribute("data-overflow", next);
    }
    return overflowing;
  }

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

    const { position: scrollPos, max: maxScroll } = logicalScrollMetrics(vp, horizontalPrimary);

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
      this.#tabindex.lend(vp);
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
    this.#tabindex.returnAll();
    if (this.#addedRole) {
      vp.removeAttribute("role");
      this.#addedRole = false;
    }
  }

  /**
   * Whether the viewport owns something the user can Tab to *right now*.
   *
   * The selector alone is not enough: a `display: none` button still matches it,
   * so a viewport whose only control is revealed on demand would never get a tab
   * stop — leaving it unreachable by keyboard exactly while it has nothing else to
   * offer. Only rendered candidates count.
   */
  #hasFocusableContent(vp: HTMLElement): boolean {
    return Array.from(vp.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).some((el) =>
      this.#isRendered(el),
    );
  }

  /**
   * Whether `el` is actually rendered, and so can hold focus.
   *
   * `checkVisibility()` answers this for every way CSS can remove a box, including
   * a class-driven `display: none` that no attribute reveals. The `hidden` walk in
   * front of it is not redundant: it is the one case a DOM-only environment with no
   * layout engine has to be told about explicitly.
   */
  #isRendered(el: HTMLElement): boolean {
    if (el.closest("[hidden]") !== null) return false;
    const check = (el as HTMLElement & VisibilityCheckable).checkVisibility;
    return typeof check === "function" ? check.call(el, { visibilityProperty: true }) : true;
  }

  #hasAccessibleName(vp: HTMLElement): boolean {
    return vp.hasAttribute("aria-label") || vp.hasAttribute("aria-labelledby");
  }
}
