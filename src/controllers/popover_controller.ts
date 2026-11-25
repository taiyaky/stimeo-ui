import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
import { claimsWhileFocusWithin, EscapeLayer } from "../utils/escape_layer";
import { sequentialTabStops } from "../utils/focus_candidate";
import { ListenerSet } from "../utils/listener_set";
import { observeScrollDismiss } from "../utils/scroll_dismiss";
import { type StateReason, stateReasonFor } from "../utils/state_reason";
import { TabindexLoan } from "../utils/tabindex_loan";

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
 * The controller root groups the panel and its related controls, including additional
 * `open` and `close` invokers. Unrelated page controls belong outside this root.
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
 * module. State is exposed via the trigger's `aria-expanded` and the panel's
 * `hidden`.
 *
 * Behavior provided:
 * - Click the trigger to toggle (`aria-expanded` + `hidden` reflect state).
 * - On open, focus moves to the first sequential stop inside the panel (or the
 *   panel itself if it has none), including the checked radio of a native group.
 * - `Escape` closes and restores focus to the trigger. While open the panel is a
 *   layer on the shared `EscapeLayer` stack; it claims a press only while
 *   focus is inside the controller or fell to the body (a click on non-focusable
 *   panel content), so a press aimed at another layer is never consumed here,
 *   and one keypress closes exactly one layer.
 * - An outside click (anywhere off the controller element) closes without moving
 *   focus. Focus stays at the clicked element, or falls back to the document body
 *   for a non-focusable destination.
 * - Because it is modeless, focus is *not* trapped: when `Tab` moves focus out of
 *   the controller it closes (detected via `focusout` and document `focusin`) without yanking
 *   focus back, so forward and reverse traversal preserve their natural destination.
 *   A `focusout` with no destination is ignored because it also occurs for clicks
 *   on non-focusable content and when the browser window loses focus. A later known
 *   external focus destination closes it even when focus first fell to the body.
 * - Opt-in **dismiss on scroll** (`closeOnScroll`): while open, scrolling a tracked
 *   scroll-parent ancestor (or the window) closes the panel, the usual convention for
 *   anchored popups. Closes without restoring focus (like the modeless `focusout` path)
 *   so the close never fights the user's scroll. Off by default. Flipping it while the
 *   panel is open wires or releases the dismissal in place.
 * - The open state survives panel replacements and absence. Actions resolve the first
 *   current panel before reading visibility; a replacement receives the retained state
 *   silently, without a focus move. Escape stays held while logically open, including
 *   without a panel. Scroll dismissal is held only while a panel exists.
 * - Panel visibility and a fallback `tabindex` are borrowed: a panel leaving the target
 *   scope receives its authored attributes, preserving later page writes. Same-scope
 *   moves and whole-root detaches keep them for the next connection.
 * - When the page hides the current panel itself, the next outside click, focus leaving,
 *   Escape, dismissing scroll or `close` releases what it held. The panel already reads
 *   closed, so nothing is reported.
 * - A trigger that takes over — in one task, or after an earlier one leaves in a later
 *   task — reads the open state, and one that stops resolving as the trigger gets back
 *   the `aria-expanded` it carried before this controller wrote on it.
 * - Each move of the open state is reported: `stimeo--popover:open` and
 *   `stimeo--popover:close` dispatch `{ reason: StateReason }`, after the state
 *   attributes are written. Both are informational, so neither is cancelable. A
 *   call that leaves the state where it already was, the normalization in
 *   {@link connect}, panel handoff, a trigger that takes over, and
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
  /** The logical open state, retained while its panel target is absent. */
  #openState = false;
  /** The panel the current state was last reflected onto, including a closed one. */
  #currentPanel: HTMLElement | null = null;
  /** The open operation whose continuation may acquire resources and move focus. */
  #openToken: object | null = null;
  /** Borrows authored visibility until the panel leaves the target scope. */
  readonly #hidden = new AttributeLease<HTMLElement>("hidden", this.identifier);
  /** Makes a panel with no sequential stops programmatically focusable while needed. */
  readonly #tabindex = new TabindexLoan("-1", this.identifier);

  /** Whether `connect()` has run for this connection; target callbacks arrive outside it too. */
  #connected = false;

  /** Whether state moves are reported: set once `connect()` settled the baseline. */
  #reporting = false;

  /** The listeners of one connection, released together on `disconnect()`. */
  readonly #listeners = new ListenerSet();

  /** Starts closed and registers the standing dismissal listeners. */
  override connect(): void {
    this.#reporting = false;
    this.#openState = false;
    this.#currentPanel = null;
    this.#close("api");
    this.#listeners.add(document, "click", this.#onOutsideClick, { capture: true });
    this.#listeners.add(this.element, "focusout", this.#onFocusOut);
    this.#listeners.add(document, "focusin", this.#onDocumentFocusIn, { capture: true });
    this.#connected = true;
    this.#reporting = true;
  }

  /**
   * Removes every standing listener registered in {@link connect} plus any active
   * dismiss-on-scroll observers. Releasing the set is a no-op for what it does not
   * hold, so this is safe in the closed state too — no listener outlives the
   * element after a Turbo navigation.
   */
  override disconnect(): void {
    this.#connected = false;
    this.#reporting = false;
    this.#release();
    this.#listeners.dispose();
    this.#openState = false;
    this.#currentPanel = null;
  }

  /**
   * Follows a runtime flip of `closeOnScroll` while the panel is open, wiring or releasing
   * the scroll dismissal in place. A closed panel holds nothing, so its next opening reads
   * the declaration as it is then; the delivery Stimulus makes ahead of `connect()` finds
   * nothing held either.
   */
  closeOnScrollValueChanged(): void {
    if (this.#openState) this.#syncScrollDismiss();
  }

  /** Applies the retained state to a newly available first panel target. */
  panelTargetConnected(): void {
    if (this.#connected) this.#syncPanel();
  }

  /**
   * Returns attributes when the panel leaves the target scope, including after teardown.
   * Same-scope moves and whole-root detaches keep them for the next connection.
   */
  panelTargetDisconnected(panel: HTMLElement): void {
    if (this.#connected) this.#syncPanel();
    if (!this.scope.containsElement(panel) || !this.panelTargets.includes(panel)) {
      this.#returnPanel(panel);
    }
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
    this.#reveal(stateReasonFor(event));
  }

  /** Closes the panel and reflects the collapsed state. Bound via `data-action`. */
  close(event?: Event): void {
    this.#close(stateReasonFor(event));
  }

  /** Opens the retained state, reports a move, and focuses the current panel if present. */
  #reveal(reason: StateReason): void {
    this.#syncPanel();
    if (this.#isOpen) return;
    this.#openState = true;
    const token = {};
    this.#openToken = token;
    this.#reflectPanel(this.#currentPanel, true);
    this.#reflectTrigger();
    if (this.#reporting) this.dispatch("open", { detail: { reason }, cancelable: false });
    // A subscriber may close, replace or reopen the panel, or tear its controller down.
    // Only the continuation of the current open may acquire resources and move focus.
    if (!this.#openState || !this.#reporting) return;
    this.#syncPanel();
    if (this.#openToken !== token || !this.#isOpen) return;
    this.#escapeLayer.activate(document, {
      onDismiss: () => this.#closeAndRestore(),
      claims: claimsWhileFocusWithin(this.element),
    });
    this.#syncScrollDismiss();
    this.#focusFirst();
  }

  /** Closes the current state, reflects it onto the available panel, and reports a move. */
  #close(reason: StateReason): void {
    this.#syncPanel();
    const was = this.#isOpen;
    this.#openState = false;
    this.#release();
    this.#reflectPanel(this.#currentPanel, false);
    this.#reflectTrigger();
    if (was && this.#reporting) this.dispatch("close", { detail: { reason }, cancelable: false });
  }

  /** Resolves the first current panel before an action reads visibility. */
  #syncPanel(): void {
    const next = this.hasPanelTarget ? this.panelTarget : null;
    const current = this.#currentPanel;
    if (current === next) return;
    if (current) {
      // Returning visibility can hide a departing panel, so retain its state first.
      this.#openState = !current.hidden;
      if (!this.scope.containsElement(current) || !this.panelTargets.includes(current)) {
        this.#returnPanel(current);
      } else this.#reflectPanel(current, false);
    }
    this.#currentPanel = next;
    this.#reflectPanel(next, this.#openState);
    this.#reflectTrigger();
    if (!this.#openState) this.#release();
    else this.#syncScrollDismiss();
  }

  /** Reflects visibility while retaining the panel's authored value. */
  #reflectPanel(panel: HTMLElement | null, open: boolean): void {
    if (!panel) return;
    this.#hidden.write(panel, open ? null : "");
    if (!open) this.#tabindex.return(panel);
  }

  /** Gives a departed panel back its authored visibility and borrowed tabindex. */
  #returnPanel(panel: HTMLElement): void {
    this.#hidden.return(panel);
    this.#tabindex.return(panel);
  }

  /** Writes whether the panel is open onto the trigger that is first. */
  #reflectTrigger(): void {
    if (this.hasTriggerTarget) this.#expanded.write(this.triggerTarget, String(this.#isOpen));
  }

  /** Leaves the Escape stack and drops the scroll dismissal; nothing is held afterwards. */
  #release(): void {
    this.#openToken = null;
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
    if (this.closeOnScrollValue && this.#currentPanel && this.#openState) {
      this.#stopScrollDismiss ??= observeScrollDismiss(this.element, () => {
        if (this.hasPanelTarget) this.#close("scroll");
      });
      return;
    }
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
  }

  /** Moves focus to the first focusable element in the panel, or the panel itself. */
  #focusFirst(): void {
    const panel = this.#currentPanel;
    if (!panel) return;
    const [first] = sequentialTabStops(panel);
    if (first) {
      first.focus();
      return;
    }
    this.#tabindex.lend(panel);
    panel.focus();
  }

  /** Closes and restores focus to the trigger for explicit keyboard dismissal. */
  #closeAndRestore(): void {
    this.#close("escape");
    if (this.hasTriggerTarget) this.triggerTarget.focus();
  }

  /** Closes without moving focus when a click lands outside the controller element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    this.#syncPanel();
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
   * click or known external focus destination decides dismissal instead.
   */
  readonly #onFocusOut = (event: FocusEvent): void => {
    this.#syncPanel();
    if (!this.#closable) return;
    const next = event.relatedTarget;
    if (!(next instanceof Node) || this.element.contains(next)) return;
    this.#close("focus");
  };

  /** Closes at a known external landing, including after an indeterminate blur to the body. */
  readonly #onDocumentFocusIn = (event: FocusEvent): void => {
    this.#syncPanel();
    if (!this.#closable) return;
    const target = event.target;
    if (!(target instanceof Node) || target === document.body || this.element.contains(target)) {
      return;
    }
    this.#close("focus");
  };

  /** Current panel visibility, or the retained state while its target is absent. */
  get #isOpen(): boolean {
    return this.#currentPanel ? !this.#currentPanel.hidden : this.#openState;
  }

  /**
   * Whether an outside click or focus leaving has something to close: the panel is
   * open, or its logical open state still holds Escape after a page hide or removal.
   */
  get #closable(): boolean {
    return this.#isOpen || this.#openState;
  }
}
