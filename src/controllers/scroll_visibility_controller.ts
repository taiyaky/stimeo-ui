import { Controller } from "@hotwired/stimulus";
import { BlurDeferral } from "../utils/blur_deferral";
import { prefersReducedMotion } from "../utils/reduced_motion";
import { TabindexLoan } from "../utils/tabindex_loan";

/** Default scroll threshold in px, and what a non-finite declaration falls back to. */
const DEFAULT_OFFSET = 400;

/**
 * Headless **Scroll Visibility** behavior: shows or hides an element based on
 * scroll amount or direction (back-to-top buttons, hide-on-scroll headers). No
 * dedicated APG pattern; when the element is a button it follows the Button
 * practice.
 *
 * Markup contract (identifier: `stimeo--scroll-visibility`):
 *   <div data-controller="stimeo--scroll-visibility"
 *        data-stimeo--scroll-visibility-offset-value="400"
 *        data-stimeo--scroll-visibility-mode-value="offset">
 *     <button type="button" hidden
 *             data-stimeo--scroll-visibility-target="element"
 *             data-action="stimeo--scroll-visibility#toTop">Back to top</button>
 *   </div>
 *
 * In `offset` mode the element is shown once the scroll source is scrolled past
 * `offset` px; in `direction` mode it is hidden while scrolling down and shown
 * while scrolling up. A `scroll` that carries no vertical movement — a
 * horizontal scroll, an overscroll bounce — has no direction, so `direction`
 * mode leaves the current visibility alone. Visibility is reflected through the
 * `hidden` attribute (so a hidden control also leaves the focus order) and
 * `data-state`.
 *
 * By default the **window** is the scroll source. When the page itself does not
 * scroll — e.g. a fixed-height app shell whose main column scrolls in a container
 * (`overflow: auto`) — point `root` at that container (a CSS selector) so the
 * controller observes the element's scroll instead of the (never-scrolling)
 * window. `toTop` then scrolls that same container.
 *
 * `change` dispatches `{ visible: boolean }` on transitions only: connecting
 * reflects the current scroll state onto the hooks without announcing it, so a
 * Turbo restore does not replay the state the snapshot already carries.
 *
 * @remarks
 * Behavior only — the look and any transition are the consumer's CSS. The scroll
 * listener is `passive`, coalesced through `requestAnimationFrame`, and removed on
 * `disconnect()` (Turbo navigation included). `offset` / `mode` are re-read at
 * runtime, so a Turbo morph that swaps either attribute is followed without
 * waiting for the next scroll; a selector (`root`, `focusSelector`) or a
 * threshold that cannot be parsed reads as its default, keeping the rest of the
 * element alive. **A scroll never hides the control while it owns focus**: that
 * hide waits for it to blur and is decided again from the scroll position at that
 * moment. `toTop` honors `prefers-reduced-motion` by forcing an
 * instant jump independently of the consumer's CSS `scroll-behavior`, and can
 * move focus to a `focusSelector` target (given `tabindex="-1"` if needed, and
 * focused without scrolling so the smooth scroll survives) to keep keyboard
 * users oriented after the scroll. A live disconnect removes only a
 * `tabindex="-1"` this controller instance added; authored tabindex values
 * remain. This teardown does not claim to rewrite a Turbo cache snapshot that
 * was cloned before disconnect.
 */
export class ScrollVisibilityController extends Controller<HTMLElement> {
  static override targets = ["element"];
  static override values = {
    offset: { type: Number, default: DEFAULT_OFFSET },
    mode: { type: String, default: "offset" },
    focusSelector: { type: String, default: "" },
    root: { type: String, default: "" },
  };
  static actions = ["toTop"] as const;
  static events = ["change"] as const;

  declare readonly elementTarget: HTMLElement;
  declare readonly hasElementTarget: boolean;

  declare offsetValue: number;
  declare modeValue: string;
  declare focusSelectorValue: string;
  declare rootValue: string;

  /** Pending rAF id that coalesces scroll bursts into one measurement. */
  #rafId: number | null = null;
  /** Previous scroll position, for `direction` mode delta detection. */
  #lastScrollY = 0;
  /** Current visibility, tracked to dispatch `change` only on real transitions. */
  #visible: boolean | null = null;
  /**
   * The observed scroll source: a container element when `root` resolves, else
   * the window. Captured on connect so teardown detaches from the same source.
   */
  #scrollSource: HTMLElement | Window = window;
  /**
   * Gates the declaration callbacks to the connected window.
   *
   * Stimulus delivers a Value callback ahead of `connect()` and again for every
   * runtime change; without the gate, merely connecting would evaluate — and
   * announce — before `connect()` runs its own first reflection.
   */
  #connected = false;
  /** Validated threshold; a non-finite declaration reads as the default. */
  #offset = DEFAULT_OFFSET;
  /** Validated `root` selector; an unparsable declaration reads as absent. */
  #rootSelector = "";
  /** Validated `focusSelector`; an unparsable declaration reads as absent. */
  #focusSelector = "";
  /** Focus targets this instance lent a `tabindex` to. */
  readonly #tabindex = new TabindexLoan();
  /**
   * The hide held back while the control itself owns focus.
   *
   * Completing the deferral re-runs the ordinary evaluation rather than applying
   * the stale decision: by the time focus leaves, the scroll position may have
   * moved back past the threshold.
   */
  readonly #pendingHide = new BlurDeferral((): void => {
    if (this.#connected) this.#evaluate();
  });

  readonly #onScroll = (): void => {
    if (this.#rafId !== null) return;
    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = null;
      this.#evaluate();
    });
  };

  override connect(): void {
    this.#scrollSource = this.#resolveScrollSource();
    this.#lastScrollY = this.#scrollY();
    this.#scrollSource.addEventListener("scroll", this.#onScroll, { passive: true });
    this.#evaluate(false);
    this.#connected = true;
  }

  override disconnect(): void {
    this.#connected = false;
    this.#scrollSource.removeEventListener("scroll", this.#onScroll);
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    this.#pendingHide.releaseAll();
    this.#tabindex.returnAll();
    this.#visible = null;
  }

  /** Writes the current visibility onto a control that arrives after connect. */
  elementTargetConnected(element: HTMLElement): void {
    if (this.#visible !== null) element.hidden = !this.#visible;
  }

  /** Drops a held-back hide together with the control it was waiting on. */
  elementTargetDisconnected(): void {
    // At most one hide is ever held back, and it rides an element inside the
    // target — the focus owner, which may be a descendant rather than the
    // target itself. Losing the target ends that wait either way.
    this.#pendingHide.releaseAll();
  }

  /**
   * Validates `offset` once, then re-renders.
   *
   * Re-renders when application code (or a Turbo morph) changes `offset` at
   * runtime. A declaration that is not a finite number reads as the default, so
   * the comparison path never sees `NaN` — which would answer `false` to every
   * comparison and strand the element (in `direction` mode, even the guarantee
   * that the very top always reveals).
   */
  offsetValueChanged(): void {
    this.#offset = Number.isFinite(this.offsetValue) ? this.offsetValue : DEFAULT_OFFSET;
    if (this.#connected) this.#evaluate();
  }

  /** Re-renders when application code (or a Turbo morph) changes `mode` at runtime. */
  modeValueChanged(): void {
    if (this.#connected) this.#evaluate();
  }

  /** Validates `root` once so connect never parses a selector that throws. */
  rootValueChanged(): void {
    this.#rootSelector = this.#validSelector(this.rootValue);
  }

  /** Validates `focusSelector` once so `toTop` never parses a selector that throws. */
  focusSelectorValueChanged(): void {
    this.#focusSelector = this.#validSelector(this.focusSelectorValue);
  }

  /** Scrolls the source to the top and, optionally, moves focus to a safe target. */
  toTop(): void {
    const behavior: ScrollBehavior = prefersReducedMotion() ? "instant" : "smooth";
    this.#scrollSource.scrollTo({ top: 0, behavior });
    if (this.#focusSelector) {
      const target = document.querySelector<HTMLElement>(this.#focusSelector);
      if (target) {
        this.#tabindex.lend(target);
        // Focusing scrolls the target into view by default, which lands the page
        // instantly and discards the scroll above.
        target.focus({ preventScroll: true });
      }
    }
  }

  /**
   * Decides the next visibility from the current scroll state and applies it.
   *
   * @param notify - whether a transition announces itself. The reflection
   *   `connect()` performs is the current state, not a change.
   *
   * @stimeoRenderRoot
   */
  #evaluate(notify = true): void {
    const y = this.#scrollY();
    let nextVisible: boolean;
    if (this.modeValue === "direction") {
      // Near the very top, always reveal so a hide-on-scroll header is never
      // stranded off-screen when the page cannot scroll up any further.
      if (y <= this.#offset) {
        nextVisible = true;
      } else if (y === this.#lastScrollY) {
        // No vertical movement carries no direction, so it decides nothing.
        return;
      } else {
        nextVisible = y < this.#lastScrollY; // scrolling up reveals, down hides
      }
    } else {
      nextVisible = y > this.#offset;
    }
    this.#lastScrollY = y;
    this.#setVisible(nextVisible, notify);
  }

  /** Applies visibility to the target, syncing `hidden`, `data-state`, `change`. */
  #setVisible(next: boolean, notify: boolean): void {
    if (next === this.#visible) return;
    const focused = !next && this.hasElementTarget ? this.#focusedWithin() : null;
    if (focused) {
      // Hiding the element that holds focus drops it to the document body,
      // stranding a keyboard user mid-interaction (WCAG 2.4.7 / 2.4.11). Hold
      // the hide until it blurs; the state stays what the user can still see.
      this.#pendingHide.deferOnly(focused);
      return;
    }
    this.#visible = next;
    if (this.hasElementTarget) this.elementTarget.hidden = !next;
    this.element.setAttribute("data-state", next ? "visible" : "hidden");
    if (notify) this.dispatch("change", { detail: { visible: next } });
  }

  /** Resolves the scroll source from `root` (falling back to the window). */
  #resolveScrollSource(): HTMLElement | Window {
    if (this.#rootSelector) {
      const root = document.querySelector<HTMLElement>(this.#rootSelector);
      if (root) return root;
    }
    return window;
  }

  /**
   * The focus owner inside the target, or `null` when focus is elsewhere.
   *
   * `blur` does not bubble, so the deferral has to ride the focused element
   * itself: waiting on a container that never receives the event would hold the
   * hide forever.
   */
  #focusedWithin(): HTMLElement | null {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.elementTarget.contains(focused)) return focused;
    return null;
  }

  /** Returns `declared` when it parses as a selector, and `""` when it does not. */
  #validSelector(declared: string): string {
    if (declared.length > 0) {
      try {
        this.element.matches(declared);
        return declared;
      } catch {
        // Unparsable selector: fall through to the default below.
      }
    }
    return "";
  }

  #scrollY(): number {
    if (this.#scrollSource === window) {
      return window.scrollY ?? window.pageYOffset ?? 0;
    }
    return (this.#scrollSource as HTMLElement).scrollTop;
  }
}
