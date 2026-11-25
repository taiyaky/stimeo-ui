import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
import { FocusTrap } from "../utils/focus_trap";
import { LivedMark } from "../utils/lived_mark";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { type StateReason, stateReasonFor } from "../utils/state_reason";
import { TransitionCompletion } from "../utils/transition_completion";

/** Edge a drawer slides from; reflected as `data-placement` for the consumer CSS. */
type Placement = "left" | "right" | "top" | "bottom";

/**
 * Headless, accessible **drawer / slide-over** behavior.
 *
 * Markup contract (identifier: `stimeo--drawer`):
 *   <div data-controller="stimeo--drawer" data-stimeo--drawer-placement-value="right">
 *     <button data-stimeo--drawer-target="trigger"
 *             data-action="click->stimeo--drawer#open">Open panel</button>
 *     <div data-stimeo--drawer-target="overlay"
 *          data-action="click->stimeo--drawer#closeOnBackdrop" hidden>
 *       <div data-stimeo--drawer-target="panel" role="dialog" aria-modal="true"
 *            aria-labelledby="t" data-state="closed" hidden>
 *         <h2 id="t">…</h2>
 *         <button data-action="click->stimeo--drawer#close">Close</button>
 *       </div>
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
 * `FocusTrap`. Placement, slide direction, distance, and easing are all the
 * consumer's CSS — `data-placement` is merely a flag.
 *
 * Behavior provided:
 * - {@link DrawerController.open | open}/{@link DrawerController.close | close}
 *   toggle `data-state` and (deferred) `hidden`.
 * - Panel replacements inherit the controller's held state. While no panel resolves, the
 *   overlay remains the modal boundary until a panel returns or the drawer is closed.
 * - On open, focus moves to the first focusable element in the panel.
 * - `Tab`/`Shift+Tab` cycle focus within the panel; `Escape` closes.
 * - {@link closeOnBackdrop} closes only when the overlay *itself* is clicked.
 * - Each move of the open state is reported: `stimeo--drawer:open` and
 *   `stimeo--drawer:close` dispatch `{ reason: StateReason }`, as soon as
 *   `data-state` is written — the deferred `hidden` and the exit transition are
 *   not waited for. Both are informational, so neither is cancelable. A call
 *   that leaves the state where it already was, the normalization in
 *   {@link connect}, the reconciliation that follows panel or overlay churn,
 *   and {@link disconnect} are all silent.
 * - After {@link disconnect} the actions do nothing until the controller
 *   connects again: no state is written, nothing is reported and the focus
 *   trap is not taken.
 */
export class DrawerController extends Controller<HTMLElement> {
  static override targets = ["trigger", "overlay", "panel"];
  static override values = {
    placement: { type: String, default: "right" },
    open: { type: Boolean, default: false },
  };
  static actions = ["close", "closeOnBackdrop", "open"] as const;
  static events = ["close", "open"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly overlayTarget: HTMLElement;
  declare readonly overlayTargets: HTMLElement[];
  declare readonly panelTarget: HTMLElement;
  declare readonly panelTargets: HTMLElement[];
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasOverlayTarget: boolean;
  declare readonly hasPanelTarget: boolean;

  declare placementValue: string;
  declare openValue: boolean;

  /** Exact panel currently owned by the modal lifecycle (survives target churn safely). */
  #activePanel: HTMLElement | null = null;
  #openState = false;

  /** Owns modal effects; the overlay holds the trap boundary while no panel resolves. */
  readonly #trap = new FocusTrap(
    () =>
      this.#activePanel ??
      (this.hasPanelTarget
        ? this.panelTarget
        : this.hasOverlayTarget
          ? this.overlayTarget
          : this.element),
    {
      onEscape: () => this.#close("escape"),
      fallbackFocus: () => (this.hasTriggerTarget ? this.triggerTarget : null),
    },
  );

  /** Owns the cancellable close-transition wait and its bounded fallback. */
  readonly #transition = new TransitionCompletion();
  /** Distinguishes dynamic target churn from callbacks around controller teardown. */
  #connected = false;

  /** Whether state moves are reported: set once `connect()` settled the baseline. */
  #reporting = false;

  /**
   * Marks the element at each connection and tells a new instance on a copy of the page Turbo
   * restores from its cache from a fresh render and from a reconnect of this instance.
   */
  readonly #lived = new LivedMark(this.identifier);

  readonly #morphRender = new MorphRenderWatcher(() => this.#repair());

  /** Borrows `data-state` on each panel and overlay, to give back when one stops being a target. */
  readonly #stateLease = new AttributeLease<HTMLElement>("data-state", this.identifier);
  /** Borrows `hidden` on each panel and overlay, for the same return. */
  readonly #hiddenLease = new AttributeLease<HTMLElement>("hidden", this.identifier);
  /** Borrows `data-placement` on each panel, for the same return. */
  readonly #placementLease = new AttributeLease<HTMLElement>("data-placement", this.identifier);

  /**
   * Reflects placement and establishes the initial open/closed state.
   *
   * A panel the server renders `data-state="open"` opens, and so does an `open` Value
   * of `true`, which only seeds that first render. A reconnect of this instance (an
   * in-page move, a permanent element carried to the next page) keeps an open drawer
   * open: the panel's `data-state` decides, not the Value. A copy of the page Turbo
   * restores from its cache comes back closed, whatever opened the drawer — the server's
   * markup, the `open` Value or the user — and the `open` Value is written `false`: every
   * connection leaves `data-<identifier>-lived` on the element, a copy carries it, and a
   * new instance that finds it is on such a copy. The baseline is normalized closed first,
   * silently, so {@link DrawerController.open | open} runs its full reveal and takes the
   * `FocusTrap` again.
   */
  override connect(): void {
    const restored = this.#lived.connect(this.element) === "restored";
    this.#trap.connect();
    this.#morphRender.observe(this.element);
    this.#connected = true;
    this.#activePanel = this.hasPanelTarget ? this.panelTarget : null;
    this.#reflectPlacement();
    const startsOpen = this.#activePanel
      ? this.#activePanel.getAttribute("data-state") === "open"
      : this.#openState;
    const shouldOpen = !restored && (startsOpen || this.openValue);
    this.#applyClosedState();
    if (restored) this.openValue = false;
    if (shouldOpen) this.#open("api");
    this.#reporting = true;
  }

  /** Reverts the modal side effects and pending hide if torn down while open. */
  override disconnect(): void {
    this.#lived.disconnect();
    this.#morphRender.disconnect();
    this.#connected = false;
    this.#reporting = false;
    this.#transition.cancel();
    this.#trap.disconnect(this);
    this.#activePanel = null;
  }

  /**
   * Adopts a panel target that arrives while no owned panel is on the page. The owned panel
   * moving within the element arrives here too, and stays owned as it is.
   */
  panelTargetConnected(panel: HTMLElement): void {
    if (!this.#connected || this.#activePanel?.isConnected) return;
    this.#adoptPanel(panel);
  }

  /**
   * Gives a panel that no longer resolves as a target its own `data-state`, `hidden` and
   * `data-placement` back — after `disconnect()` too, since dropping the identifier leaves the
   * element on the page. When the owned panel leaves, or a move puts another panel in front
   * of it, the controller's open state is retained and applied silently to the panel now first.
   * If no panel remains, an open drawer keeps its modal lifetime until a replacement arrives
   * or it is closed. A move that keeps the owned panel first changes nothing. After
   * {@link disconnect} nothing is adopted because the modal lifetime has already ended.
   */
  panelTargetDisconnected(panel: HTMLElement): void {
    const stays = this.panelTargets.includes(panel);
    if (!stays) {
      this.#stateLease.return(panel);
      this.#hiddenLease.return(panel);
      this.#placementLease.return(panel);
    }
    if (!this.#connected || panel !== this.#activePanel || (stays && this.panelTarget === panel))
      return;
    this.#transition.cancel();
    this.#activePanel = null;

    if (stays) {
      this.#writeState(panel, "closed");
      this.#writeHidden(panel, true);
    }

    // Handles morph implementations that add the replacement before removing
    // the old target (its connected callback was intentionally ignored above).
    if (this.hasPanelTarget) {
      this.#adoptPanel(this.panelTarget);
      return;
    }

    if (!this.#openState) {
      this.#writeOverlayState("closed");
      this.#writeOverlayHidden(true);
      this.openValue = false;
      this.#trap.deactivate();
    } else {
      this.#trap.refreshContainer();
    }
  }

  /** Reflects the open state onto an overlay that arrives in front of the others. */
  overlayTargetConnected(): void {
    this.#morphRender.schedule();
  }

  /**
   * Gives an overlay that no longer resolves as the target its own `data-state` and `hidden`
   * back — after `disconnect()` too, since dropping the identifier leaves the element on the
   * page — and reflects the open state onto the overlay left.
   */
  overlayTargetDisconnected(overlay: HTMLElement): void {
    if (!this.overlayTargets.includes(overlay)) {
      this.#stateLease.return(overlay);
      this.#hiddenLease.return(overlay);
    }
    this.#morphRender.schedule();
  }

  /**
   * Reflects runtime placement changes. On a connected drawer this also keeps the
   * panel and overlay in the current open or closing state without restarting the trap.
   */
  placementValueChanged(): void {
    if (this.#connected) this.#repair();
    else this.#reflectPlacement();
  }

  /** Opens the drawer: reveals it, syncs `data-state`, traps focus. */
  open(event?: Event): void {
    if (!this.#connected) return;
    this.#open(stateReasonFor(event));
  }

  /** Reveals the drawer, syncs `data-state`, reports a move, then traps focus. */
  #open(reason: StateReason): void {
    const panel = this.hasPanelTarget ? this.panelTarget : null;
    if (this.#openState) {
      if (panel && panel !== this.#activePanel) this.#adoptPanel(panel);
      return;
    }
    if (!panel && !this.hasOverlayTarget) return;
    this.#transition.cancel();
    this.#activePanel = panel;
    // Reveal the panel/overlay while they are still in their `data-state="closed"`
    // (off-screen) position, so the browser has a rendered "from" frame.
    if (panel) this.#writeHidden(panel, false);
    this.#writeOverlayHidden(false);
    // Force a reflow to commit that closed frame before flipping to "open"; without
    // it the enter transition is skipped (going straight from display:none to the
    // open position paints no intermediate state, so the panel jumps in instead of
    // sliding). The exit transition already works because the panel stays displayed.
    void panel?.offsetWidth;
    this.#setState("open");
    this.openValue = true;
    if (this.#reporting) this.dispatch("open", { detail: { reason }, cancelable: false });
    // A subscriber may close it again from the handler above. Everything below
    // applies to an element that is open; run it against a closed one and the
    // side effects have no path back — the later `close()` returns early.
    if (!this.#connected || !this.#isOpen) return;
    if (this.hasPanelTarget && this.panelTarget !== this.#activePanel) {
      this.#adoptPanel(this.panelTarget);
    } else {
      this.#trap.activate();
    }
  }

  /**
   * Closes the drawer: syncs `data-state` to start the exit transition, then
   * defers both `hidden` *and* the modal teardown (scroll lock / background
   * `inert` / focus restore) until the transition finishes. This keeps the
   * background inert and focus trapped while the drawer is still visually on
   * screen, preserving the modal contract during the exit animation.
   */
  close(event?: Event): void {
    if (!this.#connected) return;
    this.#close(stateReasonFor(event));
  }

  /** Closes only when the overlay itself (not its contents) is clicked. */
  closeOnBackdrop(event: MouseEvent): void {
    if (!this.#connected) return;
    if (this.hasOverlayTarget && event.target === this.overlayTarget) this.#close("outside");
  }

  /** Starts the exit transition, reports a move, then defers `hidden` and teardown. */
  #close(reason: StateReason): void {
    if (!this.#openState) return;
    if (this.hasPanelTarget && this.panelTarget !== this.#activePanel) {
      this.#adoptPanel(this.panelTarget);
      if (!this.#connected || !this.#openState) return;
    }
    this.openValue = false;
    this.#setState("closed");
    if (this.#reporting) this.dispatch("close", { detail: { reason }, cancelable: false });
    // A subscriber can end this modal lifetime by disconnecting or reopen the drawer.
    if (!this.#connected || this.#isOpen) return;
    if (!this.hasPanelTarget) {
      this.#transition.cancel();
      this.#writeOverlayHidden(true);
      this.#trap.deactivate();
      return;
    }
    this.#hideAfterTransition();
  }

  /**
   * Writes `data-placement` from the current `placement` value.
   *
   * @stimeoRenderRoot
   */
  #reflectPlacement(): void {
    if (this.hasPanelTarget) this.#placementLease.write(this.panelTarget, this.#placement);
  }

  /**
   * Reconciles a replacement panel and companion overlay from the controller's held state.
   * The active modal trap moves onto the replacement in place when already active.
   */
  #adoptPanel(panel: HTMLElement): void {
    this.#transition.cancel();
    const previous = this.#activePanel;
    if (previous && previous !== panel && this.panelTargets.includes(previous)) {
      this.#writeState(previous, "closed");
      this.#writeHidden(previous, true);
    }
    this.#activePanel = panel;
    this.#placementLease.write(panel, this.#placement);
    if (this.#openState) {
      this.#writeState(panel, "open");
      this.#writeHidden(panel, false);
      this.#writeOverlayState("open");
      this.#writeOverlayHidden(false);
      this.openValue = true;
      if (this.#trap.active) this.#trap.refreshContainer();
      else this.#trap.activate();
      return;
    }

    this.#writeState(panel, "closed");
    this.#writeHidden(panel, true);
    this.#writeOverlayState("closed");
    this.#writeOverlayHidden(true);
    this.openValue = false;
    this.#trap.deactivate();
  }

  /** Repairs the current panel without restarting its modal lifetime. */
  #repair(): void {
    this.#reflectPlacement();
    const state = this.#openState ? "open" : "closed";
    const hidden = !this.#openState && !this.#trap.active;
    if (this.hasPanelTarget) {
      this.#writeState(this.panelTarget, state);
      this.#writeHidden(this.panelTarget, hidden);
    }
    this.#writeOverlayState(state);
    this.#writeOverlayHidden(hidden);
  }

  /** Validated placement (`left`/`right`/`top`/`bottom`), defaulting to `right`. */
  get #placement(): Placement {
    const value = this.placementValue;
    return value === "left" || value === "top" || value === "bottom" ? value : "right";
  }

  /** Syncs `data-state` on the panel and overlay together. */
  #setState(state: "open" | "closed"): void {
    this.#openState = state === "open";
    if (this.hasPanelTarget) this.#writeState(this.panelTarget, state);
    this.#writeOverlayState(state);
  }

  /** Writes `data-state` on a panel or overlay, through the lease that gives it back. */
  #writeState(element: HTMLElement, state: "open" | "closed"): void {
    this.#stateLease.write(element, state);
  }

  /** Writes `hidden` on a panel or overlay, through the lease that gives it back. */
  #writeHidden(element: HTMLElement, hidden: boolean): void {
    this.#hiddenLease.write(element, hidden ? "" : null);
  }

  /** Writes `data-state` on the first overlay. */
  #writeOverlayState(state: "open" | "closed"): void {
    if (this.hasOverlayTarget) this.#writeState(this.overlayTarget, state);
  }

  /** Writes `hidden` on the first overlay. */
  #writeOverlayHidden(hidden: boolean): void {
    if (this.hasOverlayTarget) this.#writeHidden(this.overlayTarget, hidden);
  }

  /** Fully reflects the closed state up front; `connect()` normalizes to it before any open. */
  #applyClosedState(): void {
    this.#setState("closed");
    if (this.hasPanelTarget) this.#writeHidden(this.panelTarget, true);
    this.#writeOverlayHidden(true);
  }

  /**
   * Applies `hidden` once the panel's close transition ends, so the exit slide
   * can play. The shared waiter hides synchronously for 0ms transitions and
   * supplies a bounded fallback when the browser emits no terminal event.
   */
  #hideAfterTransition(): void {
    const panel = this.panelTarget;
    this.#activePanel = panel;
    this.#transition.wait(panel, () => this.#applyHidden(panel));
  }

  /**
   * Runs once the close transition has finished: applies `hidden` to the panel
   * and overlay, then reverts the modal side effects (scroll lock, background
   * `inert`, keydown listener) and restores focus to the opener. Deferring the
   * `FocusTrap` teardown to here — rather than at
   * {@link DrawerController.close | close} time — keeps the background unreachable
   * and focus trapped for the whole exit animation.
   */
  #applyHidden(panel: HTMLElement): void {
    this.#writeHidden(panel, true);
    this.#writeOverlayHidden(true);
    this.#trap.deactivate();
  }

  /** Whether the drawer is open, retained even while no panel target resolves. */
  get #isOpen(): boolean {
    return this.#openState;
  }
}
