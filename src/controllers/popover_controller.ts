import { Controller } from "@hotwired/stimulus";
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
 * - `Escape` closes and restores focus to the trigger.
 * - An outside click (anywhere off the controller element) closes and restores
 *   focus to the trigger.
 * - Because it is modeless, focus is *not* trapped: when `Tab` moves focus out of
 *   the panel it closes (detected via `focusout`) without yanking focus back, so
 *   the natural tab destination is preserved.
 * - Opt-in **dismiss on scroll** (`closeOnScroll`): while open, scrolling a tracked
 *   scroll-parent ancestor (or the window) closes the panel — the Radix / floating-ui
 *   convention. Closes without restoring focus (like the modeless `focusout` path)
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

  /** Selector for natively focusable elements used to find the first one. */
  static readonly #FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** Starts closed and registers the document-level dismissal listeners. */
  override connect(): void {
    this.close();
    document.addEventListener("click", this.#onOutsideClick);
    document.addEventListener("keydown", this.#onKeydown);
  }

  /**
   * Removes the document-level listeners registered in {@link connect}, plus the
   * panel's `focusout` listener if the popover is torn down while open (e.g. a
   * Turbo navigation). `removeEventListener` is a no-op when it was never added,
   * so this is safe in the closed state too — no listener outlives the element.
   */
  override disconnect(): void {
    document.removeEventListener("click", this.#onOutsideClick);
    document.removeEventListener("keydown", this.#onKeydown);
    if (this.hasPanelTarget) this.panelTarget.removeEventListener("focusout", this.#onFocusOut);
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
    // focusout fires as focus settles; register only once the panel is open so an
    // initial close()/connect() does not immediately re-close it.
    this.panelTarget.addEventListener("focusout", this.#onFocusOut);
    if (this.closeOnScrollValue && !this.#stopScrollDismiss) {
      // Close (no focus restore) so dismissing never fights the user's scroll.
      this.#stopScrollDismiss = observeScrollDismiss(this.element, () => this.close());
    }
    this.#focusFirst();
  }

  /** Closes the panel and reflects the collapsed state. Bound via `data-action`. */
  close(): void {
    if (!this.hasPanelTarget) return;
    this.panelTarget.removeEventListener("focusout", this.#onFocusOut);
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
    this.panelTarget.hidden = true;
    if (this.hasTriggerTarget) this.triggerTarget.setAttribute("aria-expanded", "false");
  }

  /** Moves focus to the first focusable element in the panel, or the panel itself. */
  #focusFirst(): void {
    const first = this.panelTarget.querySelector<HTMLElement>(PopoverController.#FOCUSABLE);
    if (first) {
      first.focus();
      return;
    }
    if (!this.panelTarget.hasAttribute("tabindex")) this.panelTarget.tabIndex = -1;
    this.panelTarget.focus();
  }

  /** Closes and restores focus to the trigger (shared by Escape / outside click). */
  #closeAndRestore(): void {
    this.close();
    if (this.hasTriggerTarget) this.triggerTarget.focus();
  }

  /** Closes (restoring focus) when a click lands outside the controller element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (this.#isOpen && !this.element.contains(event.target as Node)) this.#closeAndRestore();
  };

  /** Closes (restoring focus) on `Escape` while open. */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.#isOpen) {
      event.preventDefault();
      this.#closeAndRestore();
    }
  };

  /**
   * Closes when focus leaves the panel for an element outside the controller
   * (e.g. `Tab` past the last field). Focus is *not* restored — the natural
   * destination is kept, which is the modeless contract. Moves within the
   * controller (panel → trigger) keep it open.
   */
  readonly #onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget as Node | null;
    if (next && this.element.contains(next)) return;
    this.close();
  };

  /** Whether the panel is currently visible. */
  get #isOpen(): boolean {
    return this.hasPanelTarget && !this.panelTarget.hidden;
  }
}
