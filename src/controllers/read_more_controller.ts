import { Controller } from "@hotwired/stimulus";
import { LayoutObserver } from "../utils/layout_observer";

/**
 * Headless "read more / truncate" behavior for visually clamped text.
 *
 * Markup contract (identifier: `stimeo--read-more`):
 *   <div data-controller="stimeo--read-more">
 *     <p id="bio" data-stimeo--read-more-target="content" data-state="collapsed">…</p>
 *     <button data-stimeo--read-more-target="trigger"
 *             data-action="stimeo--read-more#toggle"
 *             aria-expanded="false" aria-controls="bio" hidden>Read more</button>
 *   </div>
 *
 * There is no dedicated APG widget; the toggle borrows the **Disclosure**
 * convention (`aria-expanded`). The visual clamp itself (`-webkit-line-clamp`
 * etc.) is the consumer's CSS, keyed off `data-state`.
 *
 * @remarks
 * Behavior only. The full text always stays in the DOM — the clamp is purely
 * visual, so assistive technology reads everything regardless of state; here
 * `aria-expanded` therefore signals the *visual* expansion, not content hidden
 * from AT. The controller's extra job is **overflow detection**: when the
 * content is not actually clamped (it fits), the toggle is `hidden` so no
 * pointless "read more" is offered. This is re-evaluated on resize.
 */
export class ReadMoreController extends Controller<HTMLElement> {
  static override targets = ["content", "trigger"];
  static override values = {
    collapsed: { type: Boolean, default: true },
  };
  static actions = ["toggle"] as const;

  declare readonly contentTarget: HTMLElement;
  declare readonly triggerTarget: HTMLElement;
  declare readonly hasContentTarget: boolean;
  declare readonly hasTriggerTarget: boolean;

  declare collapsedValue: boolean;

  /** Re-checks overflow when the content box or the viewport resizes. */
  readonly #layout = new LayoutObserver(() => this.#evaluateOverflow());

  override connect(): void {
    // The DOM is the source of truth on reconnect (Turbo cache restore / morph): an
    // explicit `data-state="expanded"`/`"collapsed"` is honored verbatim so a block
    // the user expanded *or* collapsed survives a back-navigation, even when the
    // declarative `collapsed` Value disagrees. The Value seeds only a genuinely fresh
    // render (no `data-state` yet). Mirrors `sidebar`'s `#restoreCollapsed`.
    this.#reflect(this.#initialCollapsed());
    this.#evaluateOverflow();
    if (this.hasContentTarget) {
      this.#layout.observe(this.contentTarget);
      this.#layout.observeViewport();
    }
  }

  override disconnect(): void {
    this.#layout.disconnect();
  }

  /** Toggles between the collapsed (clamped) and expanded states. */
  toggle(): void {
    this.#reflect(!this.#isCollapsed);
    this.#evaluateOverflow();
  }

  /** Whether the content is currently collapsed (clamped). */
  get #isCollapsed(): boolean {
    return this.hasContentTarget
      ? this.contentTarget.getAttribute("data-state") !== "expanded"
      : this.collapsedValue;
  }

  /** Connect-time state: an explicit `data-state` wins, else the `collapsed` Value. */
  #initialCollapsed(): boolean {
    if (this.hasContentTarget) {
      const state = this.contentTarget.getAttribute("data-state");
      if (state === "expanded") return false;
      if (state === "collapsed") return true;
    }
    return this.collapsedValue;
  }

  /** Writes the collapsed/expanded state onto the content and trigger. */
  #reflect(collapsed: boolean): void {
    if (this.hasContentTarget) {
      this.contentTarget.setAttribute("data-state", collapsed ? "collapsed" : "expanded");
    }
    if (this.hasTriggerTarget) {
      this.triggerTarget.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
  }

  /**
   * Shows the toggle only when it is useful: while expanded it is always shown
   * (the user needs a way back), and while collapsed it is shown only if the
   * text actually overflows its clamp (`scrollHeight > clientHeight`).
   */
  #evaluateOverflow(): void {
    if (!this.hasTriggerTarget || !this.hasContentTarget) return;

    if (!this.#isCollapsed) {
      this.triggerTarget.hidden = false;
      return;
    }
    const content = this.contentTarget;
    const overflowing = content.scrollHeight > content.clientHeight;
    this.triggerTarget.hidden = !overflowing;
  }
}
