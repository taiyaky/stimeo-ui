import { Controller } from "@hotwired/stimulus";

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
 * while scrolling up. Visibility is reflected through the `hidden` attribute (so a
 * hidden control also leaves the focus order) and `data-state`.
 *
 * By default the **window** is the scroll source. When the page itself does not
 * scroll — e.g. a fixed-height app shell whose main column scrolls in a container
 * (`overflow: auto`) — point `root` at that container (a CSS selector) so the
 * controller observes the element's scroll instead of the (never-scrolling)
 * window. `toTop` then scrolls that same container.
 *
 * @remarks
 * Behavior only — the look and any transition are the consumer's CSS. The scroll
 * listener is `passive`, coalesced through `requestAnimationFrame`, and removed on
 * `disconnect()` (Turbo navigation included). `toTop` honors
 * `prefers-reduced-motion` by falling back to an instant jump, and can move focus
 * to a `focusSelector` target (given `tabindex="-1"` if needed) to keep keyboard
 * users oriented after the scroll.
 */
export class ScrollVisibilityController extends Controller<HTMLElement> {
  static override targets = ["element"];
  static override values = {
    offset: { type: Number, default: 400 },
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

  /** Pending rAF id used to coalesce scroll bursts into one measurement. */
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
    this.#evaluate();
  }

  override disconnect(): void {
    this.#scrollSource.removeEventListener("scroll", this.#onScroll);
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    this.#visible = null;
  }

  /** Scrolls the source to the top and, optionally, moves focus to a safe target. */
  toTop(): void {
    const behavior: ScrollBehavior = this.#prefersReducedMotion() ? "auto" : "smooth";
    this.#scrollSource.scrollTo({ top: 0, behavior });
    if (this.focusSelectorValue) {
      const target = document.querySelector<HTMLElement>(this.focusSelectorValue);
      if (target) {
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus();
      }
    }
  }

  /** Decides the next visibility from the current scroll state and applies it. */
  #evaluate(): void {
    const y = this.#scrollY();
    let nextVisible: boolean;
    if (this.modeValue === "direction") {
      // Near the very top, always reveal so a hide-on-scroll header is never
      // stranded off-screen when the page cannot scroll up any further.
      if (y <= this.offsetValue) {
        nextVisible = true;
      } else {
        nextVisible = y < this.#lastScrollY; // scrolling up reveals, down hides
      }
    } else {
      nextVisible = y > this.offsetValue;
    }
    this.#lastScrollY = y;
    this.#setVisible(nextVisible);
  }

  /** Applies visibility to the target, syncing `hidden`, `data-state`, `change`. */
  #setVisible(next: boolean): void {
    if (next === this.#visible) return;
    this.#visible = next;
    if (this.hasElementTarget) this.elementTarget.hidden = !next;
    this.element.setAttribute("data-state", next ? "visible" : "hidden");
    this.dispatch("change", { detail: { visible: next } });
  }

  /** Resolves the scroll source from `root` (falling back to the window). */
  #resolveScrollSource(): HTMLElement | Window {
    if (this.rootValue) {
      const root = document.querySelector<HTMLElement>(this.rootValue);
      if (root) return root;
    }
    return window;
  }

  #scrollY(): number {
    if (this.#scrollSource === window) {
      return window.scrollY ?? window.pageYOffset ?? 0;
    }
    return (this.#scrollSource as HTMLElement).scrollTop;
  }

  #prefersReducedMotion(): boolean {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }
}
