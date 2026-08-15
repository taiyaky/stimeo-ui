import { Controller } from "@hotwired/stimulus";
import { EscapeLayer } from "../utils/escape_layer";
import { SafeTimeout } from "../utils/safe_timeout";
import { observeScrollDismiss } from "../utils/scroll_dismiss";

/**
 * Headless, accessible **hover card** behavior.
 *
 * Markup contract (identifier: `stimeo--hover-card`):
 *   <span data-controller="stimeo--hover-card">
 *     <a href="/users/jane" data-stimeo--hover-card-target="trigger"
 *        aria-expanded="false" aria-controls="hc"
 *        data-action="mouseenter->stimeo--hover-card#open
 *                     mouseleave->stimeo--hover-card#close
 *                     focusin->stimeo--hover-card#open
 *                     focusout->stimeo--hover-card#close">@jane</a>
 *     <div id="hc" data-stimeo--hover-card-target="card"
 *          data-action="mouseenter->stimeo--hover-card#open
 *                       mouseleave->stimeo--hover-card#close
 *                       focusin->stimeo--hover-card#open
 *                       focusout->stimeo--hover-card#close" hidden>…</div>
 *   </span>
 *
 * There is no dedicated APG pattern; this follows the **Disclosure** convention
 * (`aria-expanded`) for a hover/focus-opened, non-modal popover that *may* hold
 * interactive content (unlike a tooltip). The card is **not** a `role="dialog"`:
 * it is supplementary, so its content must also be reachable from the trigger
 * itself. For a short text hint use `stimeo--tooltip`; for a click-opened
 * action panel use `stimeo--popover`.
 *
 * @remarks
 * Behavior only — placement is the consumer's CSS (static) or the opt-in
 * `stimeo-ui/positioning` module (dynamic); this controller never imports it.
 *
 * Behavior provided:
 * - Open on `mouseenter`/`focusin`, close on `mouseleave`/`focusout`, each gated by
 *   `openDelay`/`closeDelay` to prevent accidental flicker.
 * - **Hoverable bridge**: binding open/close on the card cancels a pending close
 *   when the pointer crosses into it. Matching focus actions on the card cancel
 *   the trigger's pending close while focus is inside, then schedule close once
 *   focus leaves the whole controller.
 * - **Dismissible**: while open, the card joins the shared {@link EscapeLayer}
 *   stack, so `Escape` closes it regardless of where focus sits (card, trigger,
 *   or elsewhere). The resolver ignores an Escape already consumed by an inner
 *   handler and lets the most recently shown layer own the press, so one
 *   keypress closes exactly one layer.
 * - Open/closed flips the trigger's `aria-expanded`, the card's `hidden`, and a
 *   `data-state` (`open`/`closed`). Focus is never stolen on open.
 * - Opt-in **dismiss on scroll** (`closeOnScroll`): while open, scrolling a tracked
 *   scroll-parent ancestor (or the window) closes the card, the usual convention for
 *   anchored popups. Covers keyboard/programmatic scroll and scrollbar-drag, which the
 *   pointer-leave close cannot. Off by default.
 */
export class HoverCardController extends Controller<HTMLElement> {
  static override targets = ["trigger", "card"];
  static override values = {
    openDelay: { type: Number, default: 300 },
    closeDelay: { type: Number, default: 200 },
    closeOnScroll: { type: Boolean, default: false },
  };
  static actions = ["close", "open"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly cardTarget: HTMLElement;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasCardTarget: boolean;
  declare readonly openDelayValue: number;
  declare readonly closeDelayValue: number;
  declare readonly closeOnScrollValue: boolean;

  /** Pending open/close timers, with their IDs reset on every lifecycle boundary. */
  readonly #timers = new SafeTimeout();
  /** Escape-stack membership while open; the shared resolver dismisses via it. */
  readonly #escapeLayer = new EscapeLayer();
  #pendingOpen: number | null = null;
  #pendingClose: number | null = null;
  /** Cleanup for the dismiss-on-scroll listeners while open, or `null`. */
  #stopScrollDismiss: (() => void) | null = null;

  /** Starts closed and discards any stale pending state from a prior connection. */
  override connect(): void {
    this.#cancelOpen();
    this.#cancelClose();
    this.#conceal();
  }

  /** Clears timers, the Escape-stack membership, and scroll listeners so nothing outlives the element. */
  override disconnect(): void {
    this.#cancelOpen();
    this.#cancelClose();
    this.#escapeLayer.deactivate();
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
  }

  /** Opens the card, after `openDelay` ms (or immediately at 0). Cancels a pending close. */
  open(): void {
    this.#cancelClose();
    if (this.#isOpen || this.#pendingOpen !== null) return;
    if (this.openDelayValue <= 0) {
      this.#reveal();
      return;
    }
    this.#pendingOpen = this.#timers.set(() => {
      this.#pendingOpen = null;
      this.#reveal();
    }, this.openDelayValue);
  }

  /**
   * Schedules the card to close after `closeDelay`. Cancels a pending open. The
   * delayed callback re-checks whether focus has landed inside the controller
   * (e.g. a link in the card) and, if so, aborts the close — covering keyboard
   * traversal that the pointer-only hoverable bridge cannot.
   */
  close(): void {
    this.#cancelOpen();
    if (!this.#isOpen || this.#pendingClose !== null) return;
    this.#pendingClose = this.#timers.set(() => {
      this.#pendingClose = null;
      if (this.element.contains(document.activeElement)) return;
      this.#conceal();
    }, this.closeDelayValue);
  }

  /** Reveals the card, reflects state, and joins the Escape stack / scroll watcher. */
  #reveal(): void {
    if (!this.hasCardTarget) return;
    this.cardTarget.hidden = false;
    this.cardTarget.setAttribute("data-state", "open");
    if (this.hasTriggerTarget) this.triggerTarget.setAttribute("aria-expanded", "true");
    // No claims predicate: hover-revealed content is dismissible regardless of
    // where focus sits (WCAG 2.2 SC 1.4.13), so it always claims while open.
    this.#escapeLayer.activate(document, { onDismiss: () => this.#dismiss() });
    if (this.closeOnScrollValue && !this.#stopScrollDismiss) {
      this.#stopScrollDismiss = observeScrollDismiss(this.element, () => this.#dismiss());
    }
  }

  /** Hides the card, reflects state, and leaves the Escape stack / scroll watcher. */
  #conceal(): void {
    // Release the layer and observers first, unconditionally: if the card
    // target was removed from the DOM while open, an early return would leak
    // the stack entry and the scroll-dismiss listeners.
    this.#escapeLayer.deactivate();
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
    if (this.hasCardTarget) {
      this.cardTarget.hidden = true;
      this.cardTarget.setAttribute("data-state", "closed");
    }
    if (this.hasTriggerTarget) this.triggerTarget.setAttribute("aria-expanded", "false");
  }

  /** Cancels pending timers and conceals immediately (shared Escape path). */
  #dismiss(): void {
    this.#cancelOpen();
    this.#cancelClose();
    this.#conceal();
  }

  /** Cancels any pending open timer. */
  #cancelOpen(): void {
    if (this.#pendingOpen !== null) {
      this.#timers.clear(this.#pendingOpen);
      this.#pendingOpen = null;
    }
  }

  /** Cancels any pending close timer. */
  #cancelClose(): void {
    if (this.#pendingClose !== null) {
      this.#timers.clear(this.#pendingClose);
      this.#pendingClose = null;
    }
  }

  /** Whether the card is currently visible. */
  get #isOpen(): boolean {
    return this.hasCardTarget && !this.cardTarget.hidden;
  }
}
