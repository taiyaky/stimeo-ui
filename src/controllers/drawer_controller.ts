import { Controller } from "@hotwired/stimulus";
import { FocusTrap } from "../utils/focus_trap";

/** Edge a drawer slides from; reflected as `data-placement` for the consumer CSS. */
type Placement = "left" | "right" | "top" | "bottom";

/** Parses a CSS `transition-duration` string to milliseconds (max of the list). */
function maxTransitionMs(value: string): number {
  const durations = value.split(",").map((part) => {
    const trimmed = part.trim();
    if (trimmed.endsWith("ms")) return Number.parseFloat(trimmed);
    if (trimmed.endsWith("s")) return Number.parseFloat(trimmed) * 1000;
    return 0;
  });
  return durations.length === 0 ? 0 : Math.max(...durations);
}

/**
 * Headless, accessible **drawer / slide-over** behavior.
 *
 * Markup contract (identifier: `stimeo--drawer`):
 *   <div data-controller="stimeo--drawer" data-stimeo--drawer-placement-value="right">
 *     <button data-stimeo--drawer-target="trigger"
 *             data-action="click->stimeo--drawer#open">Open panel</button>
 *     <div data-stimeo--drawer-target="overlay"
 *          data-action="click->stimeo--drawer#closeOnBackdrop">
 *       <aside data-stimeo--drawer-target="panel" role="dialog" aria-modal="true"
 *              aria-labelledby="t" data-state="closed" hidden>
 *         <h2 id="t">…</h2>
 *         <button data-action="click->stimeo--drawer#close">Close</button>
 *       </aside>
 *     </div>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Dialog (Modal)** pattern. It is the same modal as
 * `stimeo--dialog`; what it adds is the state plumbing an enter/exit *slide*
 * needs: `data-state` (`open`/`closed`) is synced on the panel and overlay so CSS
 * can animate, and `hidden` is applied only *after* the close transition finishes
 * (so the exit animation can play). `placement` is reflected as `data-placement`
 * for the CSS to read — the controller never computes coordinates.
 *
 * @remarks
 * Behavior only. The modal lifecycle (focus trap, scroll lock, background
 * `inert`, focus restore, teardown reversal) is delegated to the shared
 * {@link FocusTrap}. Placement, slide direction, distance, and easing are all the
 * consumer's CSS — `data-placement` is merely a flag.
 *
 * Behavior provided:
 * - {@link open}/{@link close} toggle `data-state` and (deferred) `hidden`.
 * - On open, focus moves to the first focusable element in the panel.
 * - `Tab`/`Shift+Tab` cycle focus within the panel; `Escape` closes.
 * - {@link closeOnBackdrop} closes only when the overlay *itself* is clicked.
 */
export class DrawerController extends Controller<HTMLElement> {
  static override targets = ["trigger", "overlay", "panel"];
  static override values = {
    placement: { type: String, default: "right" },
    open: { type: Boolean, default: false },
  };
  static actions = ["close", "closeOnBackdrop", "open"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly overlayTarget: HTMLElement;
  declare readonly panelTarget: HTMLElement;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasOverlayTarget: boolean;
  declare readonly hasPanelTarget: boolean;

  declare placementValue: string;
  declare openValue: boolean;

  /** Owns the modal side effects; Escape closes, focus falls back to the trigger. */
  readonly #trap = new FocusTrap(() => this.panelTarget, {
    onEscape: () => this.close(),
    fallbackFocus: () => (this.hasTriggerTarget ? this.triggerTarget : null),
  });

  /** Pending `transitionend` hide listener, kept so it can be cancelled on reopen. */
  #pendingHide: (() => void) | null = null;

  /**
   * Reflects placement and establishes the initial open/closed state.
   *
   * The DOM is the source of truth on reconnect (Turbo cache restore / morph): a
   * restored snapshot whose panel is already `data-state="open"` stays open
   * rather than being re-derived from the declarative `open` Value (which would
   * close a user-opened drawer). The `open` Value only seeds a genuinely fresh
   * render. We normalize to a clean closed baseline first so {@link open} runs its
   * full reveal + trap activation — the {@link FocusTrap} is a fresh instance
   * after a reconnect and must be re-activated.
   */
  override connect(): void {
    this.#reflectPlacement();
    const shouldOpen = this.#isOpen || this.openValue;
    this.#applyClosedState();
    if (shouldOpen) this.open();
  }

  /** Reverts the modal side effects and pending hide if torn down while open. */
  override disconnect(): void {
    this.#cancelPendingHide();
    this.#trap.deactivate({ restoreFocus: false });
  }

  /** Keeps `data-placement` in sync if the value changes at runtime. */
  placementValueChanged(): void {
    this.#reflectPlacement();
  }

  /** Opens the drawer: reveals it, syncs `data-state`, traps focus. */
  open(): void {
    if (!this.hasPanelTarget || this.#isOpen) return;
    this.#cancelPendingHide(); // Reveal the panel/overlay while still in their `data-state="closed"`
    // (off-screen) position so the browser has a rendered "from" frame.
    this.panelTarget.hidden = false;
    if (this.hasOverlayTarget) this.overlayTarget.hidden = false;
    // Force a reflow to commit that closed frame before flipping to "open"; without
    // it the enter transition is skipped (going straight from display:none to the
    // open position paints no intermediate state, so the panel jumps in instead of
    // sliding). The exit transition already works because the panel stays displayed.
    void this.panelTarget.offsetWidth;
    this.#setState("open");
    this.openValue = true;
    this.#trap.activate();
  }

  /**
   * Closes the drawer: syncs `data-state` to start the exit transition, then
   * defers both `hidden` *and* the modal teardown (scroll lock / background
   * `inert` / focus restore) until the transition finishes — see
   * `#applyHidden`. This keeps the background inert and focus trapped while
   * the drawer is still visually on screen, preserving the modal contract during
   * the exit animation.
   */
  close(): void {
    if (!this.hasPanelTarget || !this.#isOpen) return;
    this.openValue = false;
    this.#setState("closed");
    this.#hideAfterTransition();
  }

  /** Closes only when the overlay itself (not its contents) is clicked. */
  closeOnBackdrop(event: MouseEvent): void {
    if (this.hasOverlayTarget && event.target === this.overlayTarget) this.close();
  }

  /** Writes `data-placement` from the current `placement` value. */
  #reflectPlacement(): void {
    if (this.hasPanelTarget) this.panelTarget.setAttribute("data-placement", this.#placement);
  }

  /** Validated placement (`left`/`right`/`top`/`bottom`), defaulting to `right`. */
  get #placement(): Placement {
    const value = this.placementValue;
    return value === "left" || value === "top" || value === "bottom" ? value : "right";
  }

  /** Syncs `data-state` on the panel and overlay together. */
  #setState(state: "open" | "closed"): void {
    if (this.hasPanelTarget) this.panelTarget.setAttribute("data-state", state);
    if (this.hasOverlayTarget) this.overlayTarget.setAttribute("data-state", state);
  }

  /** Fully reflects the closed state up front (used on connect when not open). */
  #applyClosedState(): void {
    this.#setState("closed");
    if (this.hasPanelTarget) this.panelTarget.hidden = true;
    if (this.hasOverlayTarget) this.overlayTarget.hidden = true;
  }

  /**
   * Applies `hidden` once the panel's close transition ends, so the exit slide
   * can play. When the panel has no transition (the duration is `0`, as in tests
   * or unstyled usage), it hides synchronously rather than waiting for an event
   * that would never fire.
   */
  #hideAfterTransition(): void {
    const panel = this.panelTarget;
    const duration = maxTransitionMs(getComputedStyle(panel).transitionDuration);
    if (duration === 0) {
      this.#applyHidden();
      return;
    }
    const onEnd = (event: TransitionEvent): void => {
      if (event.target !== panel) return;
      this.#cancelPendingHide();
      this.#applyHidden();
    };
    this.#pendingHide = () => panel.removeEventListener("transitionend", onEnd);
    panel.addEventListener("transitionend", onEnd);
  }

  /**
   * Runs once the close transition has finished: applies `hidden` to the panel
   * and overlay, then reverts the modal side effects (scroll lock, background
   * `inert`, keydown listener) and restores focus to the opener. Deferring the
   * {@link FocusTrap} teardown to here — rather than at {@link close} time — keeps
   * the background unreachable and focus trapped for the whole exit animation.
   */
  #applyHidden(): void {
    if (this.hasPanelTarget) this.panelTarget.hidden = true;
    if (this.hasOverlayTarget) this.overlayTarget.hidden = true;
    this.#trap.deactivate();
  }

  /** Removes any pending `transitionend` hide listener. */
  #cancelPendingHide(): void {
    this.#pendingHide?.();
    this.#pendingHide = null;
  }

  /** Whether the drawer is open (tracked via `data-state`, not `hidden`). */
  get #isOpen(): boolean {
    return this.hasPanelTarget && this.panelTarget.getAttribute("data-state") === "open";
  }
}
