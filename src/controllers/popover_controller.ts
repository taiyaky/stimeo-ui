import { Controller } from "@hotwired/stimulus";
import { claimsWhileFocusWithin, EscapeLayer } from "../utils/escape_layer";
import { firstTabStop } from "../utils/focus_candidate";
import { observeScrollDismiss } from "../utils/scroll_dismiss";

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
 *   layer on the shared {@link EscapeLayer} stack; it claims a press only while
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
 *   so the close never fights the user's scroll. Off by default.
 */
export class PopoverController extends Controller<HTMLElement> {
  static override targets = ["trigger", "panel"];
  static override values = {
    closeOnScroll: { type: Boolean, default: false },
  };
  static actions = ["close", "open", "toggle"] as const;

  declare readonly triggerTarget: HTMLButtonElement;
  declare readonly panelTarget: HTMLElement;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasPanelTarget: boolean;
  declare readonly closeOnScrollValue: boolean;

  /** Cleanup for the dismiss-on-scroll listeners while open, or `null`. */
  #stopScrollDismiss: (() => void) | null = null;
  /** Escape-stack membership while open; the shared resolver dismisses via it. */
  readonly #escapeLayer = new EscapeLayer();

  /** Starts closed and registers the standing dismissal listeners. */
  override connect(): void {
    this.close();
    document.addEventListener("click", this.#onOutsideClick, true);
    this.element.addEventListener("focusout", this.#onFocusOut);
  }

  /**
   * Removes every standing listener registered in {@link connect} plus any active
   * dismiss-on-scroll observers. `removeEventListener` is a no-op when it was
   * never added, so this is safe in the closed state too — no listener outlives
   * the element after a Turbo navigation.
   */
  override disconnect(): void {
    this.#escapeLayer.deactivate();
    document.removeEventListener("click", this.#onOutsideClick, true);
    this.element.removeEventListener("focusout", this.#onFocusOut);
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
  }

  /** Toggles the popover. Bound via `data-action` (click on the trigger). */
  toggle(): void {
    if (this.#isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /** Opens the panel, reflects state, and moves focus inside it. */
  open(): void {
    if (!this.hasPanelTarget || this.#isOpen) return;
    this.panelTarget.hidden = false;
    if (this.hasTriggerTarget) this.triggerTarget.setAttribute("aria-expanded", "true");
    this.#escapeLayer.activate(document, {
      onDismiss: () => this.#closeAndRestore(),
      claims: claimsWhileFocusWithin(this.element),
    });
    if (this.closeOnScrollValue && !this.#stopScrollDismiss) {
      // Close (no focus restore) so dismissing never fights the user's scroll.
      this.#stopScrollDismiss = observeScrollDismiss(this.element, () => this.close());
    }
    this.#focusFirst();
  }

  /** Closes the panel and reflects the collapsed state. Bound via `data-action`. */
  close(): void {
    // Release listeners first, unconditionally: a consumer may remove the panel
    // target while it is open, and an early return would leak scroll observers.
    this.#escapeLayer.deactivate();
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
    if (this.hasPanelTarget) this.panelTarget.hidden = true;
    if (this.hasTriggerTarget) this.triggerTarget.setAttribute("aria-expanded", "false");
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
    this.close();
    if (this.hasTriggerTarget) this.triggerTarget.focus();
  }

  /** Closes without moving focus when a click lands outside the controller element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    const target = event.target;
    if (this.#isOpen && target instanceof Node && !this.element.contains(target)) this.close();
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
    if (!this.#isOpen) return;
    const next = event.relatedTarget;
    if (!(next instanceof Node) || this.element.contains(next)) return;
    this.close();
  };

  /** Whether the panel is currently visible. */
  get #isOpen(): boolean {
    return this.hasPanelTarget && !this.panelTarget.hidden;
  }
}
