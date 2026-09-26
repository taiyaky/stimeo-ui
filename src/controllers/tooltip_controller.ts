import { Controller } from "@hotwired/stimulus";
import { EscapeLayer } from "../utils/escape_layer";
import { SafeTimeout } from "../utils/safe_timeout";
import { observeScrollDismiss } from "../utils/scroll_dismiss";
import { type StateReason, stateReasonFor } from "../utils/state_reason";

/**
 * Headless, accessible **tooltip** behavior.
 *
 * Markup contract (identifier: `stimeo--tooltip`):
 *   <span data-controller="stimeo--tooltip">
 *     <button data-stimeo--tooltip-target="trigger" aria-describedby="tip"
 *             data-action="mouseenter->stimeo--tooltip#show
 *                          mouseleave->stimeo--tooltip#hide
 *                          focusin->stimeo--tooltip#show
 *                          focusout->stimeo--tooltip#hide">Save</button>
 *     <span id="tip" role="tooltip" data-stimeo--tooltip-target="content"
 *           data-action="mouseenter->stimeo--tooltip#show
 *                        mouseleave->stimeo--tooltip#hide" hidden>…</span>
 *   </span>
 *
 * Implements the WAI-ARIA APG **Tooltip** pattern and WCAG 2.2 SC 1.4.13
 * (hoverable / dismissible / persistent). The tooltip never receives focus and
 * holds no interactive content — for that use `stimeo--hover-card` or
 * `stimeo--popover`. The `aria-describedby` association is declared in the
 * consumer's markup; this controller only toggles visibility.
 *
 * @remarks
 * Behavior only — placement is the consumer's CSS (static) or the opt-in
 * `stimeo-ui/positioning` module (dynamic); this controller never imports it.
 *
 * Behavior provided:
 * - Show on `mouseenter`/`focusin`, hide on `mouseleave`/`focusout`, each gated by
 *   `showDelay`/`hideDelay` to prevent flicker.
 * - **Hoverable bridge**: binding show/hide on the content too means moving the
 *   pointer from trigger into the tooltip cancels the pending hide, so it stays up.
 * - **Persistent across input modalities**: focus and pointer presence are tracked
 *   separately, so leaving one does not hide while the other still requires the hint.
 * - **Dismissible**: while shown, the tooltip joins the shared `EscapeLayer`
 *   stack, so `Escape` dismisses it even when a hover (not focus) triggered it and
 *   focus is elsewhere. The resolver ignores an Escape already consumed by an
 *   inner handler and lets the most recently shown layer own the press, so one
 *   keypress closes exactly one layer.
 * - Visibility flips `hidden` and `data-state` (`open`/`closed`); the
 *   `aria-describedby` reference is always preserved.
 * - Opt-in **dismiss on scroll** (`closeOnScroll`): while shown, scrolling a tracked
 *   scroll-parent ancestor (or the window) hides the tooltip, the usual convention for
 *   anchored popups and useful for focus-triggered tooltips that a pointer-leave cannot
 *   dismiss. Off by default.
 * - Each move of the shown state is reported: `stimeo--tooltip:open` and
 *   `stimeo--tooltip:close` dispatch `{ reason: StateReason }`, after the state
 *   attributes are written. The reason is taken from the event that started the
 *   move and survives the delay, so a `mouseleave` that hides `hideDelay` later
 *   still reports `"pointer"`. Both are informational, so neither is
 *   cancelable. A call that leaves the state where it already was, the
 *   normalization in {@link connect}, and {@link disconnect} are all silent.
 */
export class TooltipController extends Controller<HTMLElement> {
  static override targets = ["trigger", "content"];
  static override values = {
    showDelay: { type: Number, default: 0 },
    hideDelay: { type: Number, default: 0 },
    closeOnScroll: { type: Boolean, default: false },
  };
  static actions = ["hide", "show"] as const;
  static events = ["close", "open"] as const;

  declare readonly contentTarget: HTMLElement;
  declare readonly hasContentTarget: boolean;
  declare readonly showDelayValue: number;
  declare readonly hideDelayValue: number;
  declare readonly closeOnScrollValue: boolean;

  /** Registry whose pending timers are cancelled individually with their guard ids. */
  readonly #timers = new SafeTimeout();
  /** Escape-stack membership while shown; the shared resolver dismisses via it. */
  readonly #escapeLayer = new EscapeLayer();
  /** The id of the currently pending show timer, if any. */
  #pendingShow: number | null = null;
  /** The id of the currently pending hide timer, if any. */
  #pendingHide: number | null = null;
  /** Whether focus or the pointer currently requires the tooltip to persist. */
  #focusActive = false;
  #pointerActive = false;
  /** Cleanup for the dismiss-on-scroll listeners while shown, or `null`. */
  #stopScrollDismiss: (() => void) | null = null;

  /** Whether state moves are reported: set once `connect()` settled the baseline. */
  #reporting = false;

  /** Starts hidden with no stale timer or interaction state from a prior connection. */
  override connect(): void {
    this.#cancelShow();
    this.#cancelHide();
    this.#resetInteractionState();
    this.#conceal("api");
    this.#reporting = true;
  }

  /** Clears timers, the Escape-stack membership, and scroll listeners so nothing outlives the element. */
  override disconnect(): void {
    this.#reporting = false;
    this.#cancelShow();
    this.#cancelHide();
    this.#resetInteractionState();
    this.#escapeLayer.deactivate();
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
  }

  /** Shows after `showDelay`, recording the focus/pointer reason supplied by an action event. */
  show(event?: Event): void {
    const reason = stateReasonFor(event);
    this.#activateInteraction(event);
    this.#cancelHide();
    if (this.#isVisible || this.#pendingShow !== null) return;
    if (this.showDelayValue <= 0) {
      this.#reveal(reason);
      return;
    }
    this.#pendingShow = this.#timers.set(() => {
      this.#pendingShow = null;
      this.#reveal(reason);
    }, this.showDelayValue);
  }

  /** Hides after `hideDelay` once no focus/pointer reason remains; eventless calls are explicit. */
  hide(event?: Event): void {
    const reason = stateReasonFor(event);
    const interactionEnded = this.#deactivateInteraction(event);
    if (interactionEnded && this.#hasActiveInteraction) {
      this.#cancelHide();
      return;
    }
    this.#cancelShow();
    if (!this.#isVisible || this.#pendingHide !== null) return;
    if (this.hideDelayValue <= 0) {
      this.#conceal(reason);
      return;
    }
    this.#pendingHide = this.#timers.set(() => {
      this.#pendingHide = null;
      this.#conceal(reason);
    }, this.hideDelayValue);
  }

  /**
   * Reveals the content, reports a move, and joins the Escape stack / scroll watcher.
   *
   * @stimeoRuntimeOnly `closeOnScroll` decides whether this reveal wires the scroll dismissal; what
   *   is shown does not depend on it.
   */
  #reveal(reason: StateReason): void {
    if (!this.hasContentTarget) return;
    const was = this.#isVisible;
    this.contentTarget.hidden = false;
    this.contentTarget.setAttribute("data-state", "open");
    if (!was && this.#reporting) this.dispatch("open", { detail: { reason }, cancelable: false });
    // No claims predicate: a shown hover hint is dismissible regardless of
    // where focus sits (WCAG 2.2 SC 1.4.13), so it always claims while shown.
    this.#escapeLayer.activate(document, { onDismiss: () => this.#dismiss("escape") });
    if (this.closeOnScrollValue && !this.#stopScrollDismiss) {
      this.#stopScrollDismiss = observeScrollDismiss(this.element, () => this.#dismiss("scroll"));
    }
  }

  /** Hides the content, reports a move, and leaves the Escape stack / scroll watcher. */
  #conceal(reason: StateReason): void {
    // Release the layer and observers first, unconditionally: if the content
    // target was removed from the DOM while shown, an early return would leak
    // the stack entry and the scroll-dismiss listeners.
    const was = this.#isVisible;
    this.#escapeLayer.deactivate();
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
    if (!this.hasContentTarget) return;
    this.contentTarget.hidden = true;
    this.contentTarget.setAttribute("data-state", "closed");
    if (was && this.#reporting) this.dispatch("close", { detail: { reason }, cancelable: false });
  }

  /** Cancels pending timers and conceals immediately (shared Escape / scroll path). */
  #dismiss(reason: StateReason): void {
    this.#cancelShow();
    this.#cancelHide();
    this.#conceal(reason);
  }

  /** Records the modality whose enter/focus event requires the tooltip to stay visible. */
  #activateInteraction(event?: Event): void {
    if (event?.type === "mouseenter") this.#pointerActive = true;
    if (event?.type === "focusin") this.#focusActive = true;
  }

  /** Clears a modality on leave/blur and reports whether the event represented such a change. */
  #deactivateInteraction(event?: Event): boolean {
    if (event?.type === "mouseleave") {
      this.#pointerActive = false;
      return true;
    }
    if (event?.type === "focusout") {
      this.#focusActive = false;
      return true;
    }
    return false;
  }

  /** Discards interaction reasons at a lifecycle boundary. */
  #resetInteractionState(): void {
    this.#focusActive = false;
    this.#pointerActive = false;
  }

  /** Whether focus or pointer presence still requires a persistent tooltip. */
  get #hasActiveInteraction(): boolean {
    return this.#focusActive || this.#pointerActive;
  }

  /** Cancels any pending show timer. */
  #cancelShow(): void {
    if (this.#pendingShow !== null) {
      this.#timers.clear(this.#pendingShow);
      this.#pendingShow = null;
    }
  }

  /** Cancels any pending hide timer. */
  #cancelHide(): void {
    if (this.#pendingHide !== null) {
      this.#timers.clear(this.#pendingHide);
      this.#pendingHide = null;
    }
  }

  /** Whether the tooltip is currently shown. */
  get #isVisible(): boolean {
    return this.hasContentTarget && !this.contentTarget.hidden;
  }
}
