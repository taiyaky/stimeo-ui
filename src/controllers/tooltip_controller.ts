import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";
import { observeScrollDismiss } from "../utils/scroll_dismiss";

/**
 * Headless, accessible **tooltip** behavior.
 *
 * Markup contract (identifier: `stimeo--tooltip`):
 *   <span data-controller="stimeo--tooltip">
 *     <button data-stimeo--tooltip-target="trigger" aria-describedby="tip"
 *             data-action="mouseenter->stimeo--tooltip#show
 *                          mouseleave->stimeo--tooltip#hide
 *                          focusin->stimeo--tooltip#show
 *                          focusout->stimeo--tooltip#hide
 *                          keydown->stimeo--tooltip#onKeydown">Save</button>
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
 * - **Dismissible**: while shown, `Escape` is watched at the `document` level so it
 *   dismisses even when a hover (not focus) triggered it and focus is elsewhere.
 * - Visibility flips `hidden` and `data-state` (`open`/`closed`); the
 *   `aria-describedby` reference is always preserved.
 * - Opt-in **dismiss on scroll** (`closeOnScroll`): while shown, scrolling a tracked
 *   scroll-parent ancestor (or the window) hides the tooltip — the Radix / floating-ui
 *   convention, useful for focus-triggered tooltips that a pointer-leave cannot
 *   dismiss. Off by default.
 */
export class TooltipController extends Controller<HTMLElement> {
  static override targets = ["trigger", "content"];
  static override values = {
    showDelay: { type: Number, default: 0 },
    hideDelay: { type: Number, default: 0 },
    closeOnScroll: { type: Boolean, default: false },
  };
  static actions = ["hide", "onKeydown", "show"] as const;

  declare readonly contentTarget: HTMLElement;
  declare readonly hasContentTarget: boolean;
  declare readonly showDelayValue: number;
  declare readonly hideDelayValue: number;
  declare readonly closeOnScrollValue: boolean;

  /** Pending show/hide timers, torn down together on disconnect. */
  readonly #timers = new SafeTimeout();
  /** The id of the currently pending show or hide timer, if any. */
  #pendingShow: number | null = null;
  #pendingHide: number | null = null;
  /** Cleanup for the dismiss-on-scroll listeners while shown, or `null`. */
  #stopScrollDismiss: (() => void) | null = null;

  /** Starts hidden. */
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

  /** Shows the tooltip, after `showDelay` ms (or immediately at 0). Cancels a pending hide. */
  show(): void {
    this.#cancelHide();
    if (this.#isVisible || this.#pendingShow !== null) return;
    if (this.showDelayValue <= 0) {
      this.#reveal();
      return;
    }
    this.#pendingShow = this.#timers.set(() => {
      this.#pendingShow = null;
      this.#reveal();
    }, this.showDelayValue);
  }

  /** Hides the tooltip, after `hideDelay` ms (or immediately at 0). Cancels a pending show. */
  hide(): void {
    this.#cancelShow();
    if (!this.#isVisible || this.#pendingHide !== null) return;
    if (this.hideDelayValue <= 0) {
      this.#conceal();
      return;
    }
    this.#pendingHide = this.#timers.set(() => {
      this.#pendingHide = null;
      this.#conceal();
    }, this.hideDelayValue);
  }

  /**
   * Dismisses the tooltip on `Escape` from the trigger. The authoritative
   * dismissal path is the document-level listener (added while shown) so a
   * hover-triggered tooltip is dismissible regardless of focus; this handler
   * keeps the documented `keydown->#onKeydown` binding meaningful too.
   */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && this.#isVisible) {
      event.preventDefault();
      this.#cancelShow();
      this.#cancelHide();
      this.#conceal();
    }
  }

  /** Reveals the content and starts watching for a dismissing `Escape`/scroll. */
  #reveal(): void {
    if (!this.hasContentTarget) return;
    this.contentTarget.hidden = false;
    this.contentTarget.setAttribute("data-state", "open");
    document.addEventListener("keydown", this.#onDocumentKeydown);
    if (this.closeOnScrollValue && !this.#stopScrollDismiss) {
      this.#stopScrollDismiss = observeScrollDismiss(this.element, () => {
        this.#cancelShow();
        this.#cancelHide();
        this.#conceal();
      });
    }
  }

  /** Hides the content and stops watching for `Escape`/scroll. */
  #conceal(): void {
    // Release listeners first, unconditionally: if the content target was removed
    // from the DOM while shown, an early return would leak the document keydown
    // and scroll-dismiss listeners.
    document.removeEventListener("keydown", this.#onDocumentKeydown);
    this.#stopScrollDismiss?.();
    this.#stopScrollDismiss = null;
    if (!this.hasContentTarget) return;
    this.contentTarget.hidden = true;
    this.contentTarget.setAttribute("data-state", "closed");
  }

  /** Document-level `Escape` watcher (active only while shown). */
  readonly #onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.#cancelShow();
      this.#cancelHide();
      this.#conceal();
    }
  };

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
