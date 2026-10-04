import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
import { claimsWhileFocusWithin, EscapeLayer } from "../utils/escape_layer";
import { firstTabStop } from "../utils/focus_candidate";
import { observeScrollDismiss } from "../utils/scroll_dismiss";
import { type StateReason, stateReasonFor } from "../utils/state_reason";

/**
 * Headless, accessible **non-modal popover** behavior.
 *
 * Markup contract (identifier: `stimeo--popover`):
 *   <div data-controller="stimeo--popover">
 *     <button data-stimeo--popover-target="trigger"
 *             aria-haspopup="dialog" aria-expanded="false" aria-controls="pop"
 *             data-action="click->stimeo--popover#toggle">Edit profile</button>
 *     <div id="pop" data-stimeo--popover-target="panel"
 *          role="dialog" aria-label="Edit profile" hidden>…</div>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Dialog** pattern run *non-modally* (no
 * `aria-modal`, no focus trap, no `inert`/scroll lock). The background stays
 * fully interactive; this is the modeless counterpart to `stimeo--dialog`. For
 * a roving `role="menu"` of commands use `stimeo--menu`; for decorative-only
 * text use `stimeo--tooltip`.
 *
 * @remarks
 * Behavior only — static placement is the consumer's CSS, and dynamic
 * edge-collision avoidance is delegated to the opt-in `stimeo-ui/positioning`
 * module (this controller never imports it, preserving the zero-dep core). State
 * is exposed via the trigger's `aria-expanded` and the panel's `hidden`.
 *
 * Behavior provided:
 * - Click the trigger to toggle (`aria-expanded` + `hidden` reflect state).
 * - On open, focus moves to the first focusable element inside the panel (or the
 *   panel itself if it has none).
 * - `Escape` closes and restores focus to the trigger. While open the panel is a
 *   layer on the shared `EscapeLayer` stack; it claims a press only while
 *   focus is inside the controller or fell to the body (a click on non-focusable
 *   panel content), so a press aimed at another layer is never consumed here,
 *   and one keypress closes exactly one layer.
 * - An outside click (anywhere off the controller element) closes without moving
 *   focus. Focus stays at the clicked element, or falls back to the document body
 *   for a non-focusable destination.
 * - Because it is modeless, focus is *not* trapped: when `Tab` moves focus out of
 *   the controller it closes (detected via bubbling `focusout`) without yanking
 *   focus back, so forward and reverse traversal preserve their natural destination.
 *   A `focusout` with no destination is ignored because it also occurs for clicks
 *   on non-focusable content and when the browser window loses focus.
 * - Opt-in **dismiss on scroll** (`closeOnScroll`): while open, scrolling a tracked
 *   scroll-parent ancestor (or the window) closes the panel, the usual convention for
 *   anchored popups. Closes without restoring focus (like the modeless `focusout` path)
 *   so the close never fights the user's scroll. Off by default. Flipping it while the
 *   panel is open wires or releases the dismissal in place.
 * - The open panel holds its Escape layer and scroll dismissal only while it is in the
 *   DOM: once it leaves (a removal, or a morph that swaps in another panel) both are
 *   released and the trigger reads `aria-expanded="false"`. When the page hides the
 *   panel itself, the next outside click, focus leaving, Escape, dismissing scroll or
 *   `close` releases them the same way; the panel already reads closed, so nothing is
 *   reported.
 * - A trigger that takes over — in one task, or after an earlier one leaves in a later
 *   task — reads the open state, and one that stops resolving as the trigger gets back
 *   the `aria-expanded` it carried before this controller wrote on it.
 * - Each move of the open state is reported: `stimeo--popover:open` and
 *   `stimeo--popover:close` dispatch `{ reason: StateReason }`, after the state
 *   attributes are written. Both are informational, so neither is cancelable. A
 *   call that leaves the state where it already was, the normalization in
 *   {@link connect}, the open panel leaving the DOM, a trigger that takes over, and
 *   {@link disconnect} are all silent.
 */
export class PopoverController extends Controller<HTMLElement> {
  static override targets = ["trigger", "panel"];
  static override values = {
    closeOnScroll: { type: Boolean, default: false },
  };
  static actions = ["close", "open", "toggle"] as const;
  static events = ["close", "open"] as const;

  declare readonly triggerTarget: HTMLButtonElement;
  declare readonly triggerTargets: HTMLButtonElement[];
  declare readonly panelTarget: HTMLElement;
  declare readonly panelTargets: HTMLElement[];
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasPanelTarget: boolean;
  declare readonly closeOnScrollValue: boolean;

  /** Cleanup for the dismiss-on-scroll listeners while open, or `null`. */
  #stopScrollDismiss: (() => void) | null = null;
  /** Escape-stack membership while open; the shared resolver dismisses via it. */
  readonly #escapeLayer = new EscapeLayer();
  /** Borrows `aria-expanded` on the trigger, to give back when an element stops being it. */
  readonly #expanded = new AttributeLease<HTMLElement>("aria-expanded", this.identifier);
  /**
   * The panel this controller opened while the Escape layer and the scroll dismissal are
   * held for it, or `null` when nothing is held.
   */
  #shownPanel: HTMLElement | null = null;

  /** Whether `connect()` has run for this connection; target callbacks arrive outside it too. */
  #connected = false;

  /** Whether state moves are reported: set once `connect()` settled the baseline. */
  #reporting = false;

  /** Starts closed and registers the standing dismissal listeners. */
  override connect(): void {
    this.#close("api");
    document.addEventListener("click", this.#onOutsideClick, true);
    this.element.addEventListener("focusout", this.#onFocusOut);
    this.#connected = true;
    this.#reporting = true;
  }

  /**
   * Removes every standing listener registered in {@link connect} plus any active
   * dismiss-on-scroll observers. `removeEventListener` is a no-op when it was
   * never added, so this is safe in the closed state too — no listener outlives
   * the element after a Turbo navigation.
   */
  override disconnect(): void {
    this.#connected = false;
    this.#reporting = false;
    this.#release();
    document.removeEventListener("click", this.#onOutsideClick, true);
    this.element.removeEventListener("focusout", this.#onFocusOut);
  }

  /**
   * Follows a runtime flip of `closeOnScroll` while the panel is open, wiring or releasing
   * the scroll dismissal in place. A closed panel holds nothing, so its next opening reads
   * the declaration as it is then; the delivery Stimulus makes ahead of `connect()` finds
   * nothing held either.
   */
  closeOnScrollValueChanged(): void {
    if (this.#shownPanel) this.#syncScrollDismiss();
  }

  /**
   * Releases what the open panel holds once it leaves the DOM — a removal, or a morph that
   * swaps in another panel — and writes the closed state onto it and onto the trigger and
   * any panel that remains. Focus is left where the removal put it. Nothing is dispatched:
   * target churn is not a state move anyone made. After {@link disconnect}, which already
   * released everything, this leaves the DOM alone.
   */
  panelTargetDisconnected(panel: HTMLElement): void {
    if (panel !== this.#shownPanel) return;
    // A panel moved within the element is disconnected and connected again as a target.
    if (this.panelTargets.includes(panel)) return;
    this.#release();
    panel.hidden = true;
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
  triggerTargetDisconnected(trigger: HTMLButtonElement): void {
    if (!this.triggerTargets.includes(trigger)) this.#expanded.return(trigger);
    if (this.#connected) this.#reflectTrigger();
  }

  /** Toggles the popover. Bound via `data-action` (click on the trigger). */
  toggle(event?: Event): void {
    if (this.#isOpen) {
      this.close(event);
    } else {
      this.open(event);
    }
  }

  /** Opens the panel, reflects state, and moves focus inside it. */
  open(event?: Event): void {
    this.#open(stateReasonFor(event));
  }

  /** Closes the panel and reflects the collapsed state. Bound via `data-action`. */
  close(event?: Event): void {
    this.#close(stateReasonFor(event));
  }

  /** Opens the panel, reflects state, reports a move, and moves focus inside it. */
  #open(reason: StateReason): void {
    if (!this.hasPanelTarget || this.#isOpen) return;
    const panel = this.panelTarget;
    panel.hidden = false;
    if (this.hasTriggerTarget) this.#expanded.write(this.triggerTarget, "true");
    this.#shownPanel = panel;
    if (this.#reporting) this.dispatch("open", { detail: { reason }, cancelable: false });
    // A subscriber may close it again or tear the controller down from the handler
    // above. Everything below applies to a panel that is open and held; run against
    // a closed one, the Escape layer and scroll dismissal it arms would outlive the
    // panel, and focus would land inside a hidden one.
    if (this.#shownPanel !== panel || !this.#isOpen) return;
    this.#escapeLayer.activate(document, {
      onDismiss: () => this.#closeAndRestore(),
      claims: claimsWhileFocusWithin(this.element),
    });
    this.#syncScrollDismiss();
    this.#focusFirst();
  }

  /** Closes the panel, reflects the collapsed state, and reports a move. */
  #close(reason: StateReason): void {
    // The layer and the scroll dismissal are released whatever the DOM holds now,
    // so a panel missing from it never keeps them.
    const was = this.#isOpen;
    this.#release();
    this.#reflectClosed();
    if (was && this.#reporting) this.dispatch("close", { detail: { reason }, cancelable: false });
  }

  /** Writes the closed state onto the trigger and the panel target, where present. */
  #reflectClosed(): void {
    if (this.hasPanelTarget) this.panelTarget.hidden = true;
    if (this.hasTriggerTarget) this.#expanded.write(this.triggerTarget, "false");
  }

  /** Writes whether the panel is open onto the trigger that is first. */
  #reflectTrigger(): void {
    if (this.hasTriggerTarget) this.#expanded.write(this.triggerTarget, String(this.#isOpen));
  }

  /** Leaves the Escape stack and drops the scroll dismissal; nothing is held afterwards. */
  #release(): void {
    this.#shownPanel = null;
    this.#escapeLayer.deactivate();
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
  }

  /**
   * Holds the scroll dismissal exactly while `closeOnScroll` is on, subscribing at most once.
   * It closes without restoring focus, so dismissing never fights the user's scroll.
   *
   * @stimeoRuntimeOnly `closeOnScroll` decides whether the open panel is dismissed on scroll;
   *   what is shown does not depend on it.
   */
  #syncScrollDismiss(): void {
    if (this.closeOnScrollValue) {
      this.#stopScrollDismiss ??= observeScrollDismiss(this.element, () => this.#close("scroll"));
      return;
    }
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
  }

  /** Moves focus to the first focusable element in the panel, or the panel itself. */
  #focusFirst(): void {
    const first = firstTabStop(this.panelTarget);
    if (first) {
      first.focus();
      return;
    }
    if (!this.panelTarget.hasAttribute("tabindex")) this.panelTarget.tabIndex = -1;
    this.panelTarget.focus();
  }

  /** Closes and restores focus to the trigger for explicit keyboard dismissal. */
  #closeAndRestore(): void {
    this.#close("escape");
    if (this.hasTriggerTarget) this.triggerTarget.focus();
  }

  /** Closes without moving focus when a click lands outside the controller element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    const target = event.target;
    if (this.#closable && target instanceof Node && !this.element.contains(target)) {
      this.#close("outside");
    }
  };

  /**
   * Closes when focus leaves the controller for a known external destination
   * (e.g. forward Tab past the panel or reverse Tab past the trigger). Focus is
   * not restored — the natural destination is kept, which is the modeless
   * contract. A null/non-Node destination is indeterminate: browsers use it for
   * clicks on non-focusable content and window deactivation, so the later outside
   * click handler decides pointer dismissal instead.
   */
  readonly #onFocusOut = (event: FocusEvent): void => {
    if (!this.#closable) return;
    const next = event.relatedTarget;
    if (!(next instanceof Node) || this.element.contains(next)) return;
    this.#close("focus");
  };

  /** Whether the panel is currently visible. */
  get #isOpen(): boolean {
    return this.hasPanelTarget && !this.panelTarget.hidden;
  }

  /**
   * Whether an outside click or focus leaving has something to close: the panel is
   * open, or the page hid it while this controller still holds what its opening took.
   */
  get #closable(): boolean {
    return this.#isOpen || this.#shownPanel !== null;
  }
}
