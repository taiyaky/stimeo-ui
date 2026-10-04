import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
import { EscapeLayer } from "../utils/escape_layer";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { SafeTimeout } from "../utils/safe_timeout";
import { observeScrollDismiss } from "../utils/scroll_dismiss";
import { type StateReason, stateReasonFor } from "../utils/state_reason";

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
 * - **Dismissible**: while open, the card joins the shared `EscapeLayer`
 *   stack, so `Escape` closes it regardless of where focus sits (card, trigger,
 *   or elsewhere). The resolver ignores an Escape already consumed by an inner
 *   handler and lets the most recently shown layer own the press, so one
 *   keypress closes exactly one layer.
 * - Open/closed flips the trigger's `aria-expanded`, the card's `hidden`, and a
 *   `data-state` (`open`/`closed`). Focus is never stolen on open.
 * - Opt-in **dismiss on scroll** (`closeOnScroll`): while open, scrolling a tracked
 *   scroll-parent ancestor (or the window) closes the card, the usual convention for
 *   anchored popups. Covers keyboard/programmatic scroll and scrollbar-drag, which the
 *   pointer-leave close cannot. Off by default. Flipping it while the card is open wires
 *   or releases the dismissal in place.
 * - `openDelay` and `closeDelay` are read when an open or close is requested: a pending
 *   one keeps the deadline it was scheduled with, and the next request reads the value
 *   then.
 * - The open card holds its Escape layer and scroll dismissal only while it is in the
 *   DOM: once it leaves (a removal, or a morph that swaps in another card) both are
 *   released, a pending open or close is dropped, and the trigger reads
 *   `aria-expanded="false"`. When the page hides the card itself, the next close
 *   request, Escape or dismissing scroll releases them the same way; the card already
 *   reads closed, so nothing is reported.
 * - A trigger that takes over — in one task, or after an earlier one leaves in a later
 *   task — reads the open state, and one that stops resolving as the trigger gets back
 *   the `aria-expanded` it carried before this controller wrote on it.
 * - Each move of the open state is reported: `stimeo--hover-card:open` and
 *   `stimeo--hover-card:close` dispatch `{ reason: StateReason }`, after the
 *   state attributes are written. The reason is taken from the event that
 *   started the move and survives the delay, so a `mouseleave` that closes
 *   `closeDelay` later still reports `"pointer"`. Both are informational, so
 *   neither is cancelable. A call that leaves the state where it already was,
 *   the normalization in {@link connect}, the open card leaving the DOM, a trigger
 *   that takes over, and {@link disconnect} are all silent.
 */
export class HoverCardController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["trigger", "card"];
  static override values = {
    openDelay: { type: Number, default: 300 },
    closeDelay: { type: Number, default: 200 },
    closeOnScroll: { type: Boolean, default: false },
  };

  static valueConstraints = {
    openDelay: NUMBER_BOUNDS.timer,
    closeDelay: NUMBER_BOUNDS.timer,
  } satisfies NumberValueConstraints<typeof HoverCardController.values>;
  static actions = ["close", "open"] as const;
  static events = ["close", "open"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly triggerTargets: HTMLElement[];
  declare readonly cardTarget: HTMLElement;
  declare readonly cardTargets: HTMLElement[];
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasCardTarget: boolean;
  declare readonly openDelayValue: number;
  declare readonly closeDelayValue: number;
  declare readonly closeOnScrollValue: boolean;

  /** Pending open/close timers, with their IDs reset on every lifecycle boundary. */
  readonly #timers = new SafeTimeout();
  /** Escape-stack membership while open; the shared resolver dismisses via it. */
  readonly #escapeLayer = new EscapeLayer();
  /** Borrows `aria-expanded` on the trigger, to give back when an element stops being it. */
  readonly #expanded = new AttributeLease<HTMLElement>("aria-expanded", this.identifier);
  #pendingOpen: number | null = null;
  #pendingClose: number | null = null;
  /** Cleanup for the dismiss-on-scroll listeners while open, or `null`. */
  #stopScrollDismiss: (() => void) | null = null;
  /**
   * The card this controller revealed while the Escape layer and the scroll dismissal are
   * held for it, or `null` when nothing is held.
   */
  #shownCard: HTMLElement | null = null;

  /** Whether `connect()` has run for this connection; target callbacks arrive outside it too. */
  #connected = false;

  /** Whether state moves are reported: set once `connect()` settled the baseline. */
  #reporting = false;

  /** Starts closed and discards any stale pending state from a prior connection. */
  override connect(): void {
    this.#cancelTimers();
    this.#conceal("api");
    this.#connected = true;
    this.#reporting = true;
  }

  /** Clears timers, the Escape-stack membership, and scroll listeners so nothing outlives the element. */
  override disconnect(): void {
    this.#connected = false;
    this.#reporting = false;
    this.#cancelTimers();
    this.#release();
  }

  /**
   * Follows a runtime flip of `closeOnScroll` while the card is shown, wiring or releasing
   * the scroll dismissal in place. A closed card holds nothing, so its next reveal reads the
   * declaration as it is then; the delivery Stimulus makes ahead of `connect()` finds nothing
   * held either.
   */
  closeOnScrollValueChanged(): void {
    if (this.#shownCard) this.#syncScrollDismiss();
  }

  /**
   * Releases what the shown card holds once it leaves the DOM — a removal, or a morph that
   * swaps in another card — and writes the closed state onto it and onto the trigger and
   * any card that remains. Pending open and close timers are dropped with it. Nothing is
   * dispatched: target churn is not a state move anyone made. After {@link disconnect},
   * which already released everything, this leaves the DOM alone.
   */
  cardTargetDisconnected(card: HTMLElement): void {
    if (card !== this.#shownCard) return;
    // A card moved within the element is disconnected and connected again as a target.
    if (this.cardTargets.includes(card)) return;
    this.#cancelTimers();
    this.#release();
    card.hidden = true;
    card.setAttribute("data-state", "closed");
    this.#reflectClosed();
  }

  /** Brings a trigger that arrives after connect to the open state. */
  triggerTargetConnected(): void {
    if (this.#connected) this.#reflectTrigger();
  }

  /**
   * Gives a trigger that no longer resolves as one its own `aria-expanded` back — after
   * `disconnect()` too, since dropping the identifier leaves the element on the page — and
   * brings the trigger that stays to the open state.
   */
  triggerTargetDisconnected(trigger: HTMLElement): void {
    if (!this.triggerTargets.includes(trigger)) this.#expanded.return(trigger);
    if (this.#connected) this.#reflectTrigger();
  }

  /** Opens the card, after `openDelay` ms (or immediately at 0). Cancels a pending close. */
  open(event?: Event): void {
    const reason = stateReasonFor(event);
    this.#cancelClose();
    if (this.#isOpen || this.#pendingOpen !== null) return;
    if (this.#safeOpenDelay <= 0) {
      this.#reveal(reason);
      return;
    }
    this.#pendingOpen = this.#timers.set(() => {
      this.#pendingOpen = null;
      this.#reveal(reason);
    }, this.#safeOpenDelay);
  }

  /**
   * Schedules the card to close after `closeDelay`. Cancels a pending open. The
   * delayed callback re-checks whether focus has landed inside the controller
   * (e.g. a link in the card) and, if so, aborts the close — covering keyboard
   * traversal that the pointer-only hoverable bridge cannot. A card the page hid
   * itself while this controller still holds its Escape layer and scroll dismissal
   * is closed the same way, which releases them.
   */
  close(event?: Event): void {
    const reason = stateReasonFor(event);
    this.#cancelOpen();
    if (!this.#closable || this.#pendingClose !== null) return;
    this.#pendingClose = this.#timers.set(() => {
      this.#pendingClose = null;
      if (this.element.contains(document.activeElement)) return;
      this.#conceal(reason);
    }, this.#safeCloseDelay);
  }

  /** Reveals the card, reflects state, reports a move, and joins the Escape stack. */
  #reveal(reason: StateReason): void {
    if (!this.hasCardTarget) return;
    const card = this.cardTarget;
    const was = this.#isOpen;
    card.hidden = false;
    card.setAttribute("data-state", "open");
    if (this.hasTriggerTarget) this.#expanded.write(this.triggerTarget, "true");
    this.#shownCard = card;
    if (!was && this.#reporting) this.dispatch("open", { detail: { reason }, cancelable: false });
    // A subscriber may close the card or tear the controller down from the handler
    // above, and both release it; a layer or a scroll dismissal taken after that
    // would belong to nothing shown.
    if (this.#shownCard !== card) return;
    // No claims predicate: hover-revealed content is dismissible regardless of
    // where focus sits (WCAG 2.2 SC 1.4.13), so it always claims while open.
    this.#escapeLayer.activate(document, { onDismiss: () => this.#dismiss("escape") });
    this.#syncScrollDismiss();
  }

  /** Hides the card, reflects state, reports a move, and leaves the Escape stack. */
  #conceal(reason: StateReason): void {
    // The layer and the scroll dismissal are released whatever the DOM holds now,
    // so a card missing from it never keeps them.
    const was = this.#isOpen;
    this.#release();
    this.#reflectClosed();
    if (was && this.#reporting) this.dispatch("close", { detail: { reason }, cancelable: false });
  }

  /** Writes the closed state onto the trigger and the card target, where present. */
  #reflectClosed(): void {
    if (this.hasCardTarget) {
      this.cardTarget.hidden = true;
      this.cardTarget.setAttribute("data-state", "closed");
    }
    if (this.hasTriggerTarget) this.#expanded.write(this.triggerTarget, "false");
  }

  /** Writes whether the card is shown onto the trigger that is first. */
  #reflectTrigger(): void {
    if (this.hasTriggerTarget) this.#expanded.write(this.triggerTarget, String(this.#isOpen));
  }

  /** Leaves the Escape stack and drops the scroll dismissal; nothing is held afterwards. */
  #release(): void {
    this.#shownCard = null;
    this.#escapeLayer.deactivate();
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
  }

  /**
   * Holds the scroll dismissal exactly while `closeOnScroll` is on, subscribing at most once.
   *
   * @stimeoRuntimeOnly `closeOnScroll` decides whether the shown card is dismissed on scroll;
   *   what is shown does not depend on it.
   */
  #syncScrollDismiss(): void {
    if (this.closeOnScrollValue) {
      this.#stopScrollDismiss ??= observeScrollDismiss(this.element, () => this.#dismiss("scroll"));
      return;
    }
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
  }

  /** Cancels pending timers and conceals immediately (shared Escape path). */
  #dismiss(reason: StateReason): void {
    this.#cancelTimers();
    this.#conceal(reason);
  }

  /** Cancels the pending open and close timers. */
  #cancelTimers(): void {
    this.#cancelOpen();
    this.#cancelClose();
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

  /**
   * Whether a close has something to act on: the card is shown, or the page hid it
   * while this controller still holds what its reveal took.
   */
  get #closable(): boolean {
    return this.#isOpen || this.#shownCard !== null;
  }
  /** Current `openDelay` declaration resolved against its numeric contract. */
  get #safeOpenDelay(): number {
    return this.#numbers.read(
      this,
      "openDelay",
      this.openDelayValue,
      HoverCardController.values.openDelay.default,
      HoverCardController.valueConstraints.openDelay,
    );
  }

  /** Current `closeDelay` declaration resolved against its numeric contract. */
  get #safeCloseDelay(): number {
    return this.#numbers.read(
      this,
      "closeDelay",
      this.closeDelayValue,
      HoverCardController.values.closeDelay.default,
      HoverCardController.valueConstraints.closeDelay,
    );
  }
}
