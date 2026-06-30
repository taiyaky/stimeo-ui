import { Controller } from "@hotwired/stimulus";
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
 *                     focusout->stimeo--hover-card#close
 *                     keydown->stimeo--hover-card#onKeydown">@jane</a>
 *     <div id="hc" data-stimeo--hover-card-target="card"
 *          data-action="mouseenter->stimeo--hover-card#open
 *                       mouseleave->stimeo--hover-card#close" hidden>…</div>
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
 *   when the pointer crosses into it; the delayed close also re-checks focus, so
 *   tabbing into a link inside the card keeps it open.
 * - **Dismissible**: while open, `Escape` is watched at the `document` level, so it
 *   closes regardless of where focus sits (card, trigger, or elsewhere).
 * - Open/closed flips the trigger's `aria-expanded`, the card's `hidden`, and a
 *   `data-state` (`open`/`closed`). Focus is never stolen on open.
 * - Opt-in **dismiss on scroll** (`closeOnScroll`): while open, scrolling a tracked
 *   scroll-parent ancestor (or the window) closes the card — the Radix / floating-ui
 *   convention. Covers keyboard/programmatic scroll and scrollbar-drag, which the
 *   pointer-leave close cannot. Off by default.
 */
export class HoverCardController extends Controller<HTMLElement> {
  static override targets = ["trigger", "card"];
  static override values = {
    openDelay: { type: Number, default: 300 },
    closeDelay: { type: Number, default: 200 },
    closeOnScroll: { type: Boolean, default: false },
  };
  static actions = ["close", "onKeydown", "open"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly cardTarget: HTMLElement;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasCardTarget: boolean;
  declare readonly openDelayValue: number;
  declare readonly closeDelayValue: number;
  declare readonly closeOnScrollValue: boolean;

  /** Pending open/close timers, torn down together on disconnect. */
  readonly #timers = new SafeTimeout();
  #pendingOpen: number | null = null;
  #pendingClose: number | null = null;
  /** Cleanup for the dismiss-on-scroll listeners while open, or `null`. */
  #stopScrollDismiss: (() => void) | null = null;

  /** Starts closed. */
  override connect(): void {
    this.#conceal();
  }

  /** Clears timers and the document `Escape` / scroll listeners so nothing outlives the element. */
  override disconnect(): void {
    this.#timers.clearAll();
    document.removeEventListener("keydown", this.#onDocumentKeydown);
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

  /** Closes immediately on `Escape` while open (keyboard dismissal from the trigger). */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && this.#isOpen) {
      event.preventDefault();
      this.#dismiss();
    }
  }

  /** Reveals the card, reflects state, and starts watching for a dismissing `Escape`/scroll. */
  #reveal(): void {
    if (!this.hasCardTarget) return;
    this.cardTarget.hidden = false;
    this.cardTarget.setAttribute("data-state", "open");
    if (this.hasTriggerTarget) this.triggerTarget.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", this.#onDocumentKeydown);
    if (this.closeOnScrollValue && !this.#stopScrollDismiss) {
      this.#stopScrollDismiss = observeScrollDismiss(this.element, () => this.#dismiss());
    }
  }

  /** Hides the card, reflects state, and stops watching for `Escape`/scroll. */
  #conceal(): void {
    // Release listeners first, unconditionally: if the card target was removed
    // from the DOM while open, an early return would leak the document keydown
    // and scroll-dismiss listeners.
    document.removeEventListener("keydown", this.#onDocumentKeydown);
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
    if (!this.hasCardTarget) return;
    this.cardTarget.hidden = true;
    this.cardTarget.setAttribute("data-state", "closed");
    if (this.hasTriggerTarget) this.triggerTarget.setAttribute("aria-expanded", "false");
  }

  /** Cancels pending timers and conceals immediately (shared Escape path). */
  #dismiss(): void {
    this.#cancelOpen();
    this.#cancelClose();
    this.#conceal();
  }

  /** Document-level `Escape` watcher (active only while open). */
  readonly #onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.#dismiss();
    }
  };

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
