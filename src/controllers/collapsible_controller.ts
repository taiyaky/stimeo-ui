import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible single-disclosure (collapsible) behavior.
 *
 * Markup contract (identifier: `stimeo--collapsible`):
 *   <div data-controller="stimeo--collapsible">
 *     <button data-stimeo--collapsible-target="trigger"
 *             data-action="stimeo--collapsible#toggle"
 *             aria-expanded="false" aria-controls="more">Show details</button>
 *     <div id="more" data-stimeo--collapsible-target="content"
 *          data-state="closed" hidden>…</div>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Disclosure** pattern for a single inline region.
 * Unlike {@link AccordionController} it manages exactly one trigger/content pair
 * with no sibling coordination, and unlike a dropdown the content expands in
 * flow and never closes on an outside click.
 *
 * @remarks
 * Behavior only — the consumer owns the height transition and all decoration.
 * The controller keeps the open lifecycle ordered so `hidden` (effectively
 * `display:none`) never blocks measurement or the transition:
 * - **Open**: drop `hidden` → measure the natural height into
 *   `--stimeo-collapsible-content-height` → set `data-state="open"`.
 * - **Close**: set `data-state="closed"` (CSS shrinks the height) → re-apply
 *   `hidden` after `transitionend`. With no transition (or reduced motion, which
 *   the consumer's CSS expresses as a zero duration) it is applied immediately.
 */
export class CollapsibleController extends Controller<HTMLElement> {
  static override targets = ["trigger", "content"];
  static override values = {
    open: { type: Boolean, default: false },
  };
  static actions = ["toggle"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly contentTarget: HTMLElement;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasContentTarget: boolean;

  declare openValue: boolean;

  /**
   * The pending `transitionend` handler that re-applies `hidden` after a close.
   * Tracked so {@link disconnect} can detach it and a reopen can supersede it.
   */
  #pendingTransitionEnd: ((event: Event) => void) | null = null;

  /**
   * Establishes the initial open/closed state without animating.
   *
   * The DOM is the source of truth on reconnect (Turbo cache restore / morph): an
   * **explicit** state attribute — `aria-expanded="true"`/`"false"` (or, with no
   * trigger, `data-state="open"`/`"closed"`) — is honored verbatim so a region the
   * user opened *or* closed survives a back-navigation, even when the declarative
   * `open` Value disagrees. The Value only seeds a genuinely fresh render where no
   * state attribute is present yet. Mirrors `sidebar`'s `#restoreCollapsed`.
   */
  override connect(): void {
    this.#apply(this.#initialOpen(), false);
  }

  /** Resolves the connect-time state: explicit DOM state wins, else the `open` Value. */
  #initialOpen(): boolean {
    if (this.hasTriggerTarget) {
      const expanded = this.triggerTarget.getAttribute("aria-expanded");
      if (expanded === "true") return true;
      if (expanded === "false") return false;
    } else if (this.hasContentTarget) {
      const state = this.contentTarget.getAttribute("data-state");
      if (state === "open") return true;
      if (state === "closed") return false;
    }
    return this.openValue;
  }

  override disconnect(): void {
    this.#detachTransitionEnd();
  }

  /** Toggles the region open/closed. Bound via `data-action` (click). */
  toggle(): void {
    this.#apply(!this.#isOpen, true);
  }

  /**
   * Whether the region is logically open. Read from `aria-expanded` (not the
   * content's `hidden`) so a click *during* a close transition — when `hidden`
   * is still deferred — correctly reopens instead of re-closing.
   */
  get #isOpen(): boolean {
    if (this.hasTriggerTarget) {
      return this.triggerTarget.getAttribute("aria-expanded") === "true";
    }
    return this.hasContentTarget && this.contentTarget.getAttribute("data-state") === "open";
  }

  /**
   * Drives the disclosure to `open`, syncing the trigger's `aria-expanded` and
   * the content's `hidden` / `data-state` / height variable in the order the
   * spec requires.
   *
   * @param open - Target state.
   * @param animate - When `false` (initial `connect`) the close path applies
   *   `hidden` immediately instead of waiting for a transition.
   */
  #apply(open: boolean, animate: boolean): void {
    if (this.hasTriggerTarget) {
      this.triggerTarget.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (!this.hasContentTarget) return;

    const content = this.contentTarget;
    this.#detachTransitionEnd();

    if (open) {
      content.hidden = false;
      // Measure the natural height only once it is laid out (hidden removed) so
      // the consumer's `height` transition has a concrete target to animate to.
      content.style.setProperty("--stimeo-collapsible-content-height", `${content.scrollHeight}px`);
      content.setAttribute("data-state", "open");
      return;
    }

    content.setAttribute("data-state", "closed");
    if (animate && this.#transitionMs(content) > 0) {
      this.#applyHiddenAfterTransition(content);
    } else {
      content.hidden = true;
    }
  }

  /**
   * Re-applies `hidden` once the close transition finishes. Guarded against a
   * reopen mid-transition: if the region is open again by the time the
   * transition ends, `hidden` is left off.
   */
  #applyHiddenAfterTransition(content: HTMLElement): void {
    const handler = (event: Event): void => {
      if (event.target !== content) return;
      this.#detachTransitionEnd();
      if (content.getAttribute("data-state") === "closed") {
        content.hidden = true;
      }
    };
    this.#pendingTransitionEnd = handler;
    content.addEventListener("transitionend", handler);
  }

  #detachTransitionEnd(): void {
    if (this.#pendingTransitionEnd && this.hasContentTarget) {
      this.contentTarget.removeEventListener("transitionend", this.#pendingTransitionEnd);
    }
    this.#pendingTransitionEnd = null;
  }

  /**
   * First `transition-duration` of `element` in milliseconds. Browsers normalize
   * computed `<time>` to seconds (`0.2s`), but `ms` is parsed defensively. A zero
   * here — including the consumer's reduced-motion CSS — takes the immediate path.
   */
  #transitionMs(element: HTMLElement): number {
    const first = window.getComputedStyle(element).transitionDuration.split(",")[0]?.trim() ?? "";
    const amount = Number.parseFloat(first);
    if (Number.isNaN(amount)) return 0;
    return first.endsWith("ms") ? amount : amount * 1000;
  }
}
