import { Controller } from "@hotwired/stimulus";
import { EscapeLayer } from "../utils/escape_layer";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
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
 *   dismiss. Off by default. Flipping it while the tooltip is shown wires or releases the
 *   dismissal in place.
 * - `showDelay` and `hideDelay` are read when a show or hide is requested: a pending one
 *   keeps the deadline it was scheduled with, and the next request reads the value then.
 * - The shown content holds its Escape layer and scroll dismissal only while it is in
 *   the DOM: once it leaves (a removal, or a morph that swaps in other content) both are
 *   released and a pending show or hide is dropped. When the page hides the content
 *   itself, the next hide request, Escape or dismissing scroll releases them the same
 *   way; the content already reads hidden, so nothing is reported.
 * - Each move of the shown state is reported: `stimeo--tooltip:open` and
 *   `stimeo--tooltip:close` dispatch `{ reason: StateReason }`, after the state
 *   attributes are written. The reason is taken from the event that started the
 *   move and survives the delay, so a `mouseleave` that hides `hideDelay` later
 *   still reports `"pointer"`. Both are informational, so neither is
 *   cancelable. A call that leaves the state where it already was, the
 *   normalization in {@link connect}, the shown content leaving the DOM, and
 *   {@link disconnect} are all silent.
 */
export class TooltipController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["trigger", "content"];
  static override values = {
    showDelay: { type: Number, default: 0 },
    hideDelay: { type: Number, default: 0 },
    closeOnScroll: { type: Boolean, default: false },
  };

  static valueConstraints = {
    showDelay: NUMBER_BOUNDS.timer,
    hideDelay: NUMBER_BOUNDS.timer,
  } satisfies NumberValueConstraints<typeof TooltipController.values>;
  static actions = ["hide", "show"] as const;
  static events = ["close", "open"] as const;

  declare readonly contentTarget: HTMLElement;
  declare readonly contentTargets: HTMLElement[];
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
  /**
   * The content this controller revealed while the Escape layer and the scroll dismissal
   * are held for it, or `null` when nothing is held.
   */
  #shownContent: HTMLElement | null = null;

  /** Whether state moves are reported: set once `connect()` settled the baseline. */
  #reporting = false;

  /** Starts hidden with no stale timer or interaction state from a prior connection. */
  override connect(): void {
    this.#cancelTimers();
    this.#resetInteractionState();
    this.#conceal("api");
    this.#reporting = true;
  }

  /** Clears timers, the Escape-stack membership, and scroll listeners so nothing outlives the element. */
  override disconnect(): void {
    this.#reporting = false;
    this.#cancelTimers();
    this.#release();
  }

  /**
   * Follows a runtime flip of `closeOnScroll` while the tooltip is shown, wiring or
   * releasing the scroll dismissal in place. A hidden tooltip holds nothing, so its next
   * reveal reads the declaration as it is then; the delivery Stimulus makes ahead of
   * `connect()` finds nothing held either.
   */
  closeOnScrollValueChanged(): void {
    if (this.#shownContent) this.#syncScrollDismiss();
  }

  /**
   * Releases what the shown content holds once it leaves the DOM — a removal, or a morph
   * that swaps in other content — and writes the hidden state onto it and onto any content
   * that remains. Pending show and hide timers are dropped with it; the focus and pointer
   * presence stay recorded, because the trigger they describe is still there. Nothing is
   * dispatched: target churn is not a state move anyone made. After {@link disconnect},
   * which already released everything, this leaves the DOM alone.
   */
  contentTargetDisconnected(content: HTMLElement): void {
    if (content !== this.#shownContent) return;
    // Content moved within the element is disconnected and connected again as a target.
    if (this.contentTargets.includes(content)) return;
    this.#cancelTimers();
    this.#release();
    content.hidden = true;
    content.setAttribute("data-state", "closed");
    this.#reflectHidden();
  }

  /** Shows after `showDelay`, recording the focus/pointer reason supplied by an action event. */
  show(event?: Event): void {
    const reason = stateReasonFor(event);
    this.#activateInteraction(event);
    this.#cancelHide();
    if (this.#isVisible || this.#pendingShow !== null) return;
    if (this.#safeShowDelay <= 0) {
      this.#reveal(reason);
      return;
    }
    this.#pendingShow = this.#timers.set(() => {
      this.#pendingShow = null;
      this.#reveal(reason);
    }, this.#safeShowDelay);
  }

  /**
   * Hides after `hideDelay` once no focus/pointer reason remains; eventless calls are
   * explicit. Content the page hid itself while this controller still holds its Escape
   * layer and scroll dismissal is hidden the same way, which releases them.
   */
  hide(event?: Event): void {
    const reason = stateReasonFor(event);
    const interactionEnded = this.#deactivateInteraction(event);
    if (interactionEnded && this.#hasActiveInteraction) return;
    this.#cancelShow();
    if (!this.#hidable || this.#pendingHide !== null) return;
    if (this.#safeHideDelay <= 0) {
      this.#conceal(reason);
      return;
    }
    this.#pendingHide = this.#timers.set(() => {
      this.#pendingHide = null;
      this.#conceal(reason);
    }, this.#safeHideDelay);
  }

  /** Reveals the content, reports a move, and joins the Escape stack / scroll watcher. */
  #reveal(reason: StateReason): void {
    if (!this.hasContentTarget) return;
    const content = this.contentTarget;
    const was = this.#isVisible;
    content.hidden = false;
    content.setAttribute("data-state", "open");
    this.#shownContent = content;
    if (!was && this.#reporting) this.dispatch("open", { detail: { reason }, cancelable: false });
    // A subscriber may hide the tooltip or tear the controller down from the handler
    // above, and both release it; a layer or a scroll dismissal taken after that
    // would belong to nothing shown.
    if (this.#shownContent !== content) return;
    // No claims predicate: a shown hover hint is dismissible regardless of
    // where focus sits (WCAG 2.2 SC 1.4.13), so it always claims while shown.
    this.#escapeLayer.activate(document, { onDismiss: () => this.#dismiss("escape") });
    this.#syncScrollDismiss();
  }

  /** Hides the content, reports a move, and leaves the Escape stack / scroll watcher. */
  #conceal(reason: StateReason): void {
    // The layer and the scroll dismissal are released whatever the DOM holds now,
    // so content missing from it never keeps them.
    const was = this.#isVisible;
    this.#release();
    this.#reflectHidden();
    if (was && this.#reporting) this.dispatch("close", { detail: { reason }, cancelable: false });
  }

  /** Writes the hidden state onto the content target, where present. */
  #reflectHidden(): void {
    if (!this.hasContentTarget) return;
    this.contentTarget.hidden = true;
    this.contentTarget.setAttribute("data-state", "closed");
  }

  /** Leaves the Escape stack and drops the scroll dismissal; nothing is held afterwards. */
  #release(): void {
    this.#shownContent = null;
    this.#escapeLayer.deactivate();
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
  }

  /**
   * Holds the scroll dismissal exactly while `closeOnScroll` is on, subscribing at most once.
   *
   * @stimeoRuntimeOnly `closeOnScroll` decides whether the shown tooltip is dismissed on scroll;
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

  /** Cancels pending timers and conceals immediately (shared Escape / scroll path). */
  #dismiss(reason: StateReason): void {
    this.#cancelTimers();
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

  /** Cancels the pending show and hide timers. */
  #cancelTimers(): void {
    this.#cancelShow();
    this.#cancelHide();
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

  /**
   * Whether a hide has something to act on: the content is shown, or the page hid it
   * while this controller still holds what its reveal took.
   */
  get #hidable(): boolean {
    return this.#isVisible || this.#shownContent !== null;
  }
  /** Current `showDelay` declaration resolved against its numeric contract. */
  get #safeShowDelay(): number {
    return this.#numbers.read(
      this,
      "showDelay",
      this.showDelayValue,
      TooltipController.values.showDelay.default,
      TooltipController.valueConstraints.showDelay,
    );
  }

  /** Current `hideDelay` declaration resolved against its numeric contract. */
  get #safeHideDelay(): number {
    return this.#numbers.read(
      this,
      "hideDelay",
      this.hideDelayValue,
      TooltipController.values.hideDelay.default,
      TooltipController.valueConstraints.hideDelay,
    );
  }
}
