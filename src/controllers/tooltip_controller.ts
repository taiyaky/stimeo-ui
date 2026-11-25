import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
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
 * - The shown state survives a content replacement or absence. Actions resolve the
 *   current target before reading visibility; a replacement receives the retained state
 *   silently. Pending show/hide requests keep their deadlines across that absence.
 * - The logical shown state holds its Escape layer even without content, so Escape can
 *   close the pending surface once. Scroll dismissal is held only while content exists.
 *   When the page hides the current content itself, the next hide request, Escape or
 *   dismissing scroll releases both; content already reads hidden, so nothing is reported.
 * - Visibility and `data-state` are borrowed attributes: a content element leaving the
 *   target scope receives its authored values, preserving later page writes. Same-scope
 *   moves and whole-root detaches keep them for the next connection.
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
  /** The logical shown state, retained while its content target is absent. */
  #open = false;
  /** The reveal whose continuation may acquire Escape and scroll resources. */
  #revealToken: object | null = null;
  /** The content the shown state was last reflected onto, including a hidden one. */
  #currentContent: HTMLElement | null = null;
  /** Borrows authored visibility and state until the content leaves the target scope. */
  readonly #hidden = new AttributeLease<HTMLElement>("hidden", this.identifier);
  readonly #state = new AttributeLease<HTMLElement>("data-state", this.identifier);

  /** Whether state moves are reported: set once `connect()` settled the baseline. */
  #reporting = false;

  /** Starts hidden with no stale timer or interaction state from a prior connection. */
  override connect(): void {
    this.#reporting = false;
    this.#cancelTimers();
    this.#resetInteractionState();
    this.#open = false;
    this.#currentContent = null;
    this.#conceal("api");
    this.#reporting = true;
  }

  /**
   * Clears timers, the Escape-stack membership, and scroll listeners so nothing outlives
   * the element.
   */
  override disconnect(): void {
    this.#reporting = false;
    this.#cancelTimers();
    this.#release();
    this.#open = false;
    this.#currentContent = null;
  }

  /**
   * Follows a runtime flip of `closeOnScroll` while the tooltip is shown, wiring or
   * releasing the scroll dismissal in place. A hidden tooltip holds nothing, so its next
   * reveal reads the declaration as it is then; the delivery Stimulus makes ahead of
   * `connect()` finds nothing held either.
   */
  closeOnScrollValueChanged(): void {
    if (this.#open) this.#syncScrollDismiss();
  }

  /** Applies the retained shown state to a newly available first content target. */
  contentTargetConnected(): void {
    if (this.#reporting) this.#syncContent();
  }

  /**
   * Returns attributes only when the element leaves the target scope, including after
   * controller teardown. A same-scope move and a whole-root detach keep their leases.
   * While connected, any replacement receives the retained state without a new report.
   */
  contentTargetDisconnected(content: HTMLElement): void {
    if (this.#reporting) this.#syncContent();
    if (!this.scope.containsElement(content) || !this.contentTargets.includes(content)) {
      this.#returnContent(content);
    }
  }

  /** Shows after `showDelay`, recording the focus/pointer reason supplied by an action event. */
  show(event?: Event): void {
    this.#syncContent();
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
    this.#syncContent();
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
    this.#syncContent();
    const was = this.#isVisible;
    this.#open = true;
    const token = {};
    this.#revealToken = token;
    this.#reflectContent(this.#currentContent, true);
    if (!was && this.#reporting) this.dispatch("open", { detail: { reason }, cancelable: false });
    // A subscriber may hide the tooltip or tear the controller down from the handler
    // above, and both release it; a layer or a scroll dismissal taken after that
    // would belong to nothing shown.
    if (!this.#open || !this.#reporting) return;
    this.#syncContent();
    if (this.#revealToken !== token) return;
    // No claims predicate: a shown hover hint is dismissible regardless of
    // where focus sits (WCAG 2.2 SC 1.4.13), so it always claims while shown.
    this.#escapeLayer.activate(document, { onDismiss: () => this.#dismiss("escape") });
    this.#syncScrollDismiss();
  }

  /** Hides the content, reports a move, and leaves the Escape stack / scroll watcher. */
  #conceal(reason: StateReason): void {
    // The layer and the scroll dismissal are released whatever the DOM holds now,
    // so content missing from it never keeps them.
    this.#syncContent();
    const was = this.#isVisible;
    this.#open = false;
    this.#release();
    this.#reflectContent(this.#currentContent, false);
    if (was && this.#reporting) this.dispatch("close", { detail: { reason }, cancelable: false });
  }

  /** Moves the retained state onto the first current target before an action reads it. */
  #syncContent(): void {
    const next = this.hasContentTarget ? this.contentTarget : null;
    const current = this.#currentContent;
    if (current === next) return;
    if (current) {
      // Returning the lease can hide a departing surface, so read its state first.
      this.#open = !current.hidden;
      if (!this.scope.containsElement(current) || !this.contentTargets.includes(current)) {
        this.#returnContent(current);
      } else this.#reflectContent(current, false);
    }
    this.#currentContent = next;
    this.#reflectContent(next, this.#open);
    if (!this.#open) this.#release();
    else this.#syncScrollDismiss();
  }

  /** Reflects one content element while preserving the attributes it lends. */
  #reflectContent(content: HTMLElement | null, open: boolean): void {
    if (!content) return;
    this.#hidden.write(content, open ? null : "");
    this.#state.write(content, open ? "open" : "closed");
  }

  /** Gives an element back its authored visibility and state. */
  #returnContent(content: HTMLElement): void {
    this.#hidden.return(content);
    this.#state.return(content);
  }

  /** Leaves the Escape stack and drops the scroll dismissal; nothing is held afterwards. */
  #release(): void {
    this.#revealToken = null;
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
    if (this.closeOnScrollValue && this.#currentContent && this.#open) {
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

  /** Current surface visibility, or the retained shown state while its target is absent. */
  get #isVisible(): boolean {
    return this.#currentContent ? !this.#currentContent.hidden : this.#open;
  }

  /**
   * Whether a hide has something to act on: the surface is shown, or a shown state
   * still owns Escape while the page hides or removes its content.
   */
  get #hidable(): boolean {
    return this.#isVisible || this.#open;
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
