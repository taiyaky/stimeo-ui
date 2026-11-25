import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
import { FocusTrap } from "../utils/focus_trap";
import { ListenerSet } from "../utils/listener_set";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { readLocalStorage, writeLocalStorage } from "../utils/safe_storage";
import { type StateReason, stateReasonFor } from "../utils/state_reason";
import { TransitionCompletion } from "../utils/transition_completion";

/** Current responsive mode, driven by a `min-width` media query. */
type Mode = "inline" | "overlay";

/**
 * Headless, accessible **responsive collapsible sidebar** behavior.
 *
 * Markup contract (identifier: `stimeo--sidebar`):
 *   <div data-controller="stimeo--sidebar"
 *        data-stimeo--sidebar-breakpoint-value="768"
 *        data-stimeo--sidebar-key-value="main-nav">
 *     <header>
 *       <button data-stimeo--sidebar-target="trigger"
 *               data-action="click->stimeo--sidebar#toggle"
 *               aria-expanded="true" aria-controls="app-sidebar">Menu</button>
 *     </header>
 *     <div data-stimeo--sidebar-target="backdrop"
 *          data-action="click->stimeo--sidebar#close" hidden></div>
 *     <aside id="app-sidebar" data-stimeo--sidebar-target="panel"
 *            aria-label="Main" data-mode="inline" data-state="expanded">
 *       <nav aria-label="…">…</nav>
 *     </aside>
 *   </div>
 *   <main>…</main>   <!-- a body-level sibling so it can be made inert in overlay -->
 *
 * No dedicated APG pattern: the base is **Disclosure** (the trigger's
 * `aria-expanded` controls the panel's expanded state) and, *below* the
 * `breakpoint`, it borrows the **Dialog (Modal)** focus behavior via the shared
 * `FocusTrap`.
 *
 * Above the breakpoint it is an **inline**, non-modal element that toggles
 * `expanded`↔`collapsed` (a rail), persisting that preference in `localStorage`.
 * Below it, it becomes an **overlay** off-canvas panel: opening activates the
 * trap (focus move, `Tab` cycle, `Escape`, body scroll lock, background `inert`,
 * focus restore); closing defers `hidden` and the trap teardown until the exit
 * transition ends (synchronously when there is none).
 *
 * @remarks
 * Behavior only — rail width, slide, and backdrop are the consumer's CSS, keyed
 * off `data-mode` (`inline`/`overlay`) and `data-state`. `aria-expanded` is an
 * abstract "is the panel expanded" flag, independent of the visual difference
 * between an inline collapsed rail (still in the DOM) and an overlay closed panel
 * (`hidden`/off-canvas). The `role="dialog"` semantics are intentionally **not**
 * applied — the sidebar stays an `<aside>`/`<nav>` landmark and only borrows the
 * modal *behavior*, because `role="dialog"` would replace that landmark.
 * The collapsed preference persists across Turbo navigations and full reloads;
 * the transient overlay-open state never persists: a page Turbo restores from its
 * cache connects with the overlay closed, so "back/forward" never restores a
 * stuck-open menu, whenever the copy was taken. A page that stays keeps an open overlay
 * open, through `turbo:before-cache` (which Turbo also dispatches on pages that stay) and
 * through a reconnect of the same instance (an in-page move, a `data-turbo-permanent`
 * element carried to the next page), which takes the trap again, and through a Turbo
 * morph, after which the mode and the state this instance holds are written back over
 * the server's markup. The `collapsed` Value only seeds a connect that neither a saved
 * preference nor the panel's `data-state` decides; a later declaration moves nothing.
 *
 * Each move of the panel's expanded state is reported: `stimeo--sidebar:open`
 * and `stimeo--sidebar:close` dispatch
 * `{ reason: StateReason, mode: "inline" | "overlay" }` — `mode` tells an
 * inline expand/collapse from an overlay open/close — as soon as `data-state`
 * and `aria-expanded` are written, without waiting for the exit transition. A
 * responsive mode change re-derives the state instead of the user moving it, so
 * it reports `stimeo--sidebar:reconcile` with
 * `{ mode: "inline" | "overlay", open: boolean }` and no reason; so does a `key`
 * rewritten after connect whose saved preference moves the inline rail. All three are
 * informational, so none is cancelable. A call that leaves the state where it
 * already was, the normalization in {@link connect}, the reconciliation that
 * follows panel, trigger or backdrop churn, and {@link disconnect} are all silent,
 * and after {@link disconnect} the actions do nothing until the controller connects
 * again. A close the backdrop asked for reports
 * `"outside"`: the backdrop carries no action of its own, so
 * {@link SidebarController.close | close} is what the consumer wires onto it and it
 * recognises that target.
 */
export class SidebarController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["trigger", "panel", "backdrop"];
  static override values = {
    breakpoint: { type: Number, default: 768 },
    key: { type: String, default: "" },
    collapsed: { type: Boolean, default: false },
  };

  static valueConstraints = {
    breakpoint: NUMBER_BOUNDS.nonNegative,
  } satisfies NumberValueConstraints<typeof SidebarController.values>;
  static actions = ["close", "open", "toggle"] as const;
  static events = ["close", "open", "reconcile"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly triggerTargets: HTMLElement[];
  declare readonly panelTarget: HTMLElement;
  declare readonly panelTargets: HTMLElement[];
  declare readonly backdropTarget: HTMLElement;
  declare readonly backdropTargets: HTMLElement[];
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasPanelTarget: boolean;
  declare readonly hasBackdropTarget: boolean;

  declare breakpointValue: number;
  declare keyValue: string;
  declare collapsedValue: boolean;

  /** Exact panel currently owned by the modal lifecycle (survives target churn safely). */
  #activePanel: HTMLElement | null = null;

  /** Owns the overlay modal side effects; Escape closes, focus falls to trigger. */
  readonly #trap = new FocusTrap(() => this.#activePanel ?? this.panelTarget, {
    onEscape: () => this.#closeOverlay("escape"),
    fallbackFocus: () => (this.hasTriggerTarget ? this.triggerTarget : null),
  });

  /** Current responsive mode. */
  #mode: Mode = "inline";
  /** Persisted inline preference: whether the rail is collapsed. */
  #collapsed = false;
  /** The matched media query (`min-width: breakpoint`), watched for mode changes. */
  #mql: MediaQueryList | null = null;
  /** The change listener on the matched query; a new breakpoint releases it first. */
  readonly #mediaListeners = new ListenerSet();
  /** Exact normalized query currently represented by the active media-query listener. */
  #mqlQuery: string | null = null;
  /** Owns the cancellable close-transition wait and its bounded fallback. */
  readonly #transition = new TransitionCompletion();
  /** Distinguishes dynamic target churn from callbacks around controller teardown. */
  #connected = false;

  /** The storage key last read, so a `key` callback naming it again reads nothing. */
  #storageKeyRead: string | null = null;

  /** The `aria-expanded` last written, for a trigger that arrives or stays. */
  #overlayOpen = false;
  /** The backdrop's `data-state` and `hidden` as last written, for one that arrives or stays. */
  readonly #backdrop: { state: "open" | "closed"; hidden: boolean } = {
    state: "closed",
    hidden: true,
  };
  /** Borrows `aria-expanded` on each trigger, to give back when one stops being the target. */
  readonly #expandedLease = new AttributeLease<HTMLElement>("aria-expanded", this.identifier);
  /** Borrows `data-state` on each panel and backdrop, for the same return. */
  readonly #stateLease = new AttributeLease<HTMLElement>("data-state", this.identifier);
  /** Borrows `hidden` on each panel and backdrop, for the same return. */
  readonly #hiddenLease = new AttributeLease<HTMLElement>("hidden", this.identifier);
  /** Borrows `data-mode` on each panel, for the same return. */
  readonly #modeLease = new AttributeLease<HTMLElement>("data-mode", this.identifier);
  /** Writes the state back after a Turbo morph put the server's markup in its place. */
  readonly #morphRender = new MorphRenderWatcher(() => this.#repair());

  /**
   * Whether this instance has connected before. A reconnect is an in-page move or a
   * `data-turbo-permanent` element carried to the next page; a page Turbo restores from its
   * cache connects new instances.
   */
  #lived = false;

  /**
   * Restores the inline preference and starts the overlay closed, silently. A reconnect of
   * this instance that finds its overlay still open in overlay mode keeps it open and takes
   * the trap again.
   */
  override connect(): void {
    this.#trap.connect();
    this.#connected = true;
    this.#activePanel = this.hasPanelTarget ? this.panelTarget : null;
    this.#storageKeyRead = this.#storageKey;
    this.#collapsed = this.#restoreCollapsed();
    this.#mqlQuery = this.#breakpointQuery;
    this.#mql = this.#matchBreakpoint(this.#mqlQuery);
    if (this.#mql) this.#mediaListeners.add(this.#mql, "change", this.#onMediaChange);
    const mode = this.#computeMode();
    const startsOpen = this.#activePanel
      ? this.#activePanel.getAttribute("data-state") === "open"
      : this.#overlayOpen;
    const resume = this.#lived && this.#isOverlay && mode === "overlay" && startsOpen;
    this.#lived = true;
    if (resume) {
      this.#overlayOpen = true;
      this.#trap.activate();
    } else {
      this.#applyMode(mode, false);
    }
    this.#morphRender.observe(this.element);
  }

  override disconnect(): void {
    this.#connected = false;
    this.#morphRender.disconnect();
    this.#mediaListeners.dispose();
    this.#mql = null;
    this.#mqlQuery = null;
    this.#transition.cancel();
    this.#trap.disconnect(this);
    this.#activePanel = null;
  }

  /**
   * Applies the retained state to the panel that is now first.
   */
  panelTargetConnected(_panel: HTMLElement): void {
    this.#adoptPanel();
  }

  /**
   * Gives a panel that no longer resolves as a target its own `data-mode`, `data-state` and
   * `hidden` back — after `disconnect()` too, since dropping the identifier leaves the element
   * on the page. The overlay state is transferred when the first panel changes.
   */
  panelTargetDisconnected(panel: HTMLElement): void {
    if (!this.panelTargets.includes(panel)) {
      this.#modeLease.return(panel);
      this.#stateLease.return(panel);
      this.#hiddenLease.return(panel);
    }
    this.#adoptPanel();
  }

  /** Reflects the expanded state onto a trigger that arrives in front of the others. */
  triggerTargetConnected(): void {
    if (this.#connected) this.#reflectExpanded();
  }

  /**
   * Gives a trigger that no longer resolves as the target its own `aria-expanded` back — after
   * `disconnect()` too, since dropping the identifier leaves the element on the page — and,
   * while connected, reflects the expanded state onto the trigger left.
   */
  triggerTargetDisconnected(trigger: HTMLElement): void {
    if (!this.triggerTargets.includes(trigger)) this.#expandedLease.return(trigger);
    if (this.#connected) this.#reflectExpanded();
  }

  /** Reflects the overlay state onto a backdrop that arrives in front of the others. */
  backdropTargetConnected(): void {
    if (this.#connected) this.#reflectBackdrop();
  }

  /**
   * Gives a backdrop that no longer resolves as the target its own `data-state` and `hidden`
   * back — after `disconnect()` too — and, while connected, reflects the overlay state onto
   * the backdrop left.
   */
  backdropTargetDisconnected(backdrop: HTMLElement): void {
    if (!this.backdropTargets.includes(backdrop)) {
      this.#stateLease.return(backdrop);
      this.#hiddenLease.return(backdrop);
    }
    if (this.#connected) this.#reflectBackdrop();
  }

  /**
   * Rebinds responsive observation when `breakpoint` changes at runtime.
   *
   * Stimulus calls value callbacks before `connect()`, so the connected guard
   * prevents an eager subscription. Equivalent normalized queries retain the
   * existing listener instead of allocating duplicate `MediaQueryList` objects.
   */
  breakpointValueChanged(): void {
    if (!this.#connected) return;
    const query = this.#breakpointQuery;
    if (this.#mqlQuery === query) return;

    this.#mediaListeners.dispose();
    this.#mqlQuery = query;
    this.#mql = this.#matchBreakpoint(query);
    if (this.#mql) this.#mediaListeners.add(this.#mql, "change", this.#onMediaChange);
    const next = this.#computeMode();
    if (next !== this.#mode) this.#applyMode(next, true);
  }

  /**
   * Follows a `key` rewritten after connect. A preference saved under the new key is
   * applied — rendered and reported as `reconcile` inline, kept for the next inline
   * render in overlay — and without one the state stays. Nothing is copied or written.
   */
  keyValueChanged(): void {
    // `connect()` reads the initial key itself.
    if (!this.#connected) return;
    const key = this.#storageKey;
    if (key === this.#storageKeyRead) return;
    this.#storageKeyRead = key;
    const stored = this.#readStoredCollapsed(key);
    if (stored === null || stored === this.#collapsed) return;
    this.#collapsed = stored;
    if (this.#isOverlay) return;
    this.#applyInlineState(stored);
    this.#reportReconcile();
  }

  /** Toggles the panel: inline flips collapsed/expanded, overlay flips open/closed. */
  toggle(event?: Event): void {
    if (!this.#connected) return;
    const reason = stateReasonFor(event);
    if (this.#isOverlay) {
      this.#isOverlayOpen ? this.#closeOverlay(reason) : this.#openOverlay(reason);
    } else {
      this.#setCollapsed(!this.#collapsed, reason);
    }
  }

  /** Shows the panel (inline: expand; overlay: open). */
  open(event?: Event): void {
    if (!this.#connected) return;
    const reason = stateReasonFor(event);
    if (this.#isOverlay) this.#openOverlay(reason);
    else this.#setCollapsed(false, reason);
  }

  /** Hides the panel (inline: collapse; overlay: close). */
  close(event?: Event): void {
    if (!this.#connected) return;
    const reason = this.#closeReason(event);
    if (this.#isOverlay) this.#closeOverlay(reason);
    else this.#setCollapsed(true, reason);
  }

  /**
   * Reads why a close happened. The backdrop has no action of its own — the
   * consumer wires this one onto it — so the shared `"outside"` vocabulary is
   * only reachable by recognising that target here.
   */
  #closeReason(event?: Event): StateReason {
    if (this.hasBackdropTarget && event?.currentTarget === this.backdropTarget) return "outside";
    return stateReasonFor(event);
  }

  // --- Mode handling ---------------------------------------------------------

  /**
   * Re-renders the closed/default state for `mode` and records it.
   *
   * @param report - Whether the mode change is one the consumer can observe: a
   *   viewport change re-derives the state under them, the connect-time baseline
   *   does not.
   */
  #applyMode(mode: Mode, report: boolean): void {
    this.#mode = mode;
    if (this.hasPanelTarget) this.#modeLease.write(this.panelTarget, mode);
    if (mode === "inline") {
      this.#overlayOpen = false;
      // Drop any overlay residue, then render the persisted rail state. The connect-time
      // baseline releases nothing: the trap is inactive then, and a tabindex it kept on a
      // panel that held focus is the trap's to keep across an in-page move.
      this.#transition.cancel();
      if (report) this.#trap.deactivate({ restoreFocus: false });
      if (this.hasPanelTarget) this.#writeHidden(this.panelTarget, false);
      this.#hideBackdrop();
      this.#applyInlineState(this.#collapsed);
    } else {
      // Overlay always starts closed; never auto-open on a mode switch.
      this.#setOverlayClosedImmediate();
    }
    if (report) this.#reportReconcile();
  }

  /**
   * Writes the state this instance holds back over the server's markup a Turbo morph put in
   * its place, silently: the mode, and the overlay as open, closing or closed — shown while
   * open or while the trap is still held through the exit — or the inline rail.
   */
  #repair(): void {
    if (!this.hasPanelTarget) return;
    if (this.#mode === "inline") {
      this.#applyMode("inline", false);
      return;
    }
    const panel = this.panelTarget;
    this.#modeLease.write(panel, "overlay");
    this.#setOverlayState(this.#overlayOpen ? "open" : "closed");
    const hidden = !this.#overlayOpen && !this.#trap.active;
    this.#writeHidden(panel, hidden);
    this.#writeBackdropHidden(hidden);
    this.#reflectExpanded();
  }

  /** Reports a state the controller re-derived rather than one the user moved. */
  #reportReconcile(): void {
    this.dispatch("reconcile", {
      detail: { mode: this.#mode, open: this.#isExpanded },
      cancelable: false,
    });
  }

  /**
   * Transfers the retained state to the first panel. An open overlay keeps its place in the
   * trap and Escape stacks and its opener while the panel is absent. Its backdrop is hidden
   * until there is a panel to display.
   */
  #adoptPanel(): void {
    if (!this.#connected) return;
    const panel = this.hasPanelTarget ? this.panelTarget : null;
    const previous = this.#activePanel;
    if (panel === previous) return;
    this.#transition.cancel();
    this.#activePanel = panel;
    if (previous && this.#isOverlay && this.panelTargets.includes(previous)) {
      this.#writeState(previous, "closed");
      this.#writeHidden(previous, true);
    }
    if (panel) this.#modeLease.write(panel, this.#mode);
    if (this.#mode === "inline") {
      if (panel) this.#writeHidden(panel, false);
      this.#hideBackdrop();
      this.#applyInlineState(this.#collapsed);
      return;
    }
    if (this.#isOverlayOpen) {
      if (panel) {
        this.#writeHidden(panel, false);
        this.#setOverlayState("open");
        this.#writeBackdropHidden(false);
      } else {
        this.#hideBackdrop();
      }
      this.#trap.refreshContainer();
      return;
    }
    this.#setOverlayClosedImmediate();
    this.#trap.deactivate();
  }

  readonly #onMediaChange = (event: MediaQueryListEvent): void => {
    const next: Mode = event.matches ? "inline" : "overlay";
    if (next !== this.#mode) this.#applyMode(next, true);
  };

  #computeMode(): Mode {
    return (this.#mql?.matches ?? true) ? "inline" : "overlay";
  }

  #matchBreakpoint(query = this.#breakpointQuery): MediaQueryList | null {
    if (typeof window.matchMedia !== "function") return null;
    return window.matchMedia(query);
  }

  // --- Inline (rail) ---------------------------------------------------------

  /** Sets, reflects, and persists the inline collapsed preference. */
  #setCollapsed(collapsed: boolean, reason: StateReason): void {
    if (collapsed === this.#collapsed) return;
    this.#collapsed = collapsed;
    this.#applyInlineState(collapsed);
    this.#report(!collapsed, reason);
    this.#persistCollapsed(collapsed);
  }

  /** Reflects the inline rail state onto the panel and trigger. */
  #applyInlineState(collapsed: boolean): void {
    if (this.hasPanelTarget) {
      this.#writeState(this.panelTarget, collapsed ? "collapsed" : "expanded");
    }
    this.#reflectExpanded();
  }

  // --- Overlay (off-canvas modal) -------------------------------------------

  /** Opens the overlay: reveal it, commit a starting frame, then trap focus. */
  #openOverlay(reason: StateReason): void {
    this.#adoptPanel();
    if (this.#isOverlayOpen) return;
    this.#transition.cancel();
    if (this.#activePanel) {
      this.#writeHidden(this.#activePanel, false);
      this.#writeBackdropHidden(false);
      // Commit the off-canvas frame so the enter transition has a starting frame.
      void this.#activePanel.offsetWidth;
      this.#setOverlayState("open");
    }
    this.#overlayOpen = true;
    this.#reflectExpanded();
    this.#report(true, reason);
    // A subscriber may close it again from the handler above. Everything below
    // applies to a panel that is open; run it against a closed one and the modal
    // side effects have no path back — the later `close()` returns early.
    if (!this.#connected || !this.#isOverlayOpen) return;
    this.#adoptPanel();
    this.#trap.activate();
  }

  /** Closes the overlay: start the exit transition, defer hide + trap teardown. */
  #closeOverlay(reason: StateReason): void {
    if (!this.#isOverlayOpen) return;
    this.#adoptPanel();
    if (!this.#connected || !this.#isOverlayOpen) return;
    this.#overlayOpen = false;
    this.#setOverlayState("closed");
    this.#reflectExpanded();
    this.#report(false, reason);
    // A subscriber may reopen it from the handler above; hiding after the exit
    // transition would then apply `hidden` to a panel that is on screen.
    if (!this.#connected || this.#isOverlayOpen) return;
    const panel = this.hasPanelTarget ? this.panelTarget : null;
    if (panel !== this.#activePanel) this.#adoptPanel();
    else if (panel) this.#hideAfterTransition(panel);
    else {
      this.#hideBackdrop();
      this.#trap.deactivate();
    }
  }

  /** Renders the overlay closed state up front (used when entering overlay mode). */
  #setOverlayClosedImmediate(): void {
    this.#overlayOpen = false;
    this.#setOverlayState("closed");
    this.#reflectExpanded();
    if (this.hasPanelTarget) this.#writeHidden(this.panelTarget, true);
    this.#hideBackdrop();
  }

  /** Syncs `data-state` on the panel and backdrop together (overlay). */
  #setOverlayState(state: "open" | "closed"): void {
    if (this.hasPanelTarget) this.#writeState(this.panelTarget, state);
    this.#writeBackdropState(state);
  }

  /**
   * Applies `hidden` once the close transition ends so the exit slide can play,
   * then reverts the modal side effects. The shared waiter completes
   * synchronously for 0ms transitions and supplies a bounded fallback when the
   * browser emits no terminal event.
   */
  #hideAfterTransition(panel: HTMLElement): void {
    this.#transition.wait(panel, () => this.#applyOverlayHidden(panel));
  }

  /** Hides the panel/backdrop and tears down the trap after the exit transition. */
  #applyOverlayHidden(panel: HTMLElement): void {
    this.#writeHidden(panel, true);
    this.#hideBackdrop();
    this.#trap.deactivate();
  }

  #hideBackdrop(): void {
    this.#writeBackdropState("closed");
    this.#writeBackdropHidden(true);
  }

  /** Writes `data-state` on a panel or backdrop, through the lease that gives it back. */
  #writeState(element: HTMLElement, state: string): void {
    this.#stateLease.write(element, state);
  }

  /** Writes `hidden` on a panel or backdrop, through the lease that gives it back. */
  #writeHidden(element: HTMLElement, hidden: boolean): void {
    this.#hiddenLease.write(element, hidden ? "" : null);
  }

  /** Writes the backdrop's `data-state`, keeping it for a backdrop that arrives or stays. */
  #writeBackdropState(state: "open" | "closed"): void {
    this.#backdrop.state = state;
    if (this.hasBackdropTarget) this.#writeState(this.backdropTarget, state);
  }

  /** Writes the backdrop's `hidden`, keeping it for a backdrop that arrives or stays. */
  #writeBackdropHidden(hidden: boolean): void {
    this.#backdrop.hidden = hidden;
    if (this.hasBackdropTarget) this.#writeHidden(this.backdropTarget, hidden);
  }

  /** Writes the kept `data-state` and `hidden` onto the first backdrop. */
  #reflectBackdrop(): void {
    this.#writeBackdropState(this.#backdrop.state);
    this.#writeBackdropHidden(this.#backdrop.hidden);
  }

  // --- Shared helpers --------------------------------------------------------

  /** Writes the current mode's `aria-expanded` onto the first trigger, through its lease. */
  #reflectExpanded(): void {
    if (this.hasTriggerTarget) {
      this.#expandedLease.write(this.triggerTarget, this.#isExpanded ? "true" : "false");
    }
  }

  /** Reports a move of the expanded state, naming the mode it happened in. */
  #report(open: boolean, reason: StateReason): void {
    const detail = { reason, mode: this.#mode };
    if (open) this.dispatch("open", { detail, cancelable: false });
    else this.dispatch("close", { detail, cancelable: false });
  }

  /** Whether the panel currently counts as expanded in the mode it is in. */
  get #isExpanded(): boolean {
    return this.#isOverlay ? this.#isOverlayOpen : !this.#collapsed;
  }

  /**
   * Resolves the inline collapsed preference, in priority order:
   *   1. the persisted value (when a `key` is set and storage is readable),
   *   2. the current DOM `data-state` — so a Turbo cache restore / morph that
   *      reconnects over already-rendered markup keeps the live state (the DOM is
   *      the source of truth) even when no `key` / localStorage is available,
   *   3. the declared `collapsed` value.
   */
  #restoreCollapsed(): boolean {
    const stored = this.#readStoredCollapsed(this.#storageKey);
    if (stored !== null) return stored;
    const domState = this.hasPanelTarget ? this.panelTarget.getAttribute("data-state") : null;
    if (domState === "collapsed") return true;
    if (domState === "expanded") return false;
    return this.collapsedValue;
  }

  /** The preference saved under `key`, or `null` when there is none to read. */
  #readStoredCollapsed(key: string): boolean | null {
    if (!key) return null;
    const result = readLocalStorage(key);
    if (!result.ok || result.value === null) return null;
    return result.value === "1";
  }

  /** Persists the collapsed preference when a key is configured. */
  #persistCollapsed(collapsed: boolean): void {
    const key = this.#storageKey;
    if (!key) return;
    writeLocalStorage(key, collapsed ? "1" : "0");
  }

  /**
   * @stimeoRuntimeOnly `key` names the storage slot the collapsed state is saved under; the state
   *   itself comes from the user.
   */
  get #storageKey(): string {
    return this.keyValue ? `stimeo--sidebar:${this.keyValue}` : "";
  }

  /** Valid breakpoint CSS query, defaulting malformed or negative values to 768px. */
  get #breakpointQuery(): string {
    const value = this.#safeBreakpoint;
    const breakpoint = value;
    return `(min-width: ${breakpoint}px)`;
  }

  get #isOverlay(): boolean {
    return this.#mode === "overlay";
  }

  get #isOverlayOpen(): boolean {
    return this.#isOverlay && this.#overlayOpen;
  }
  /** Current `breakpoint` declaration resolved against its numeric contract. */
  get #safeBreakpoint(): number {
    return this.#numbers.read(
      this,
      "breakpoint",
      this.breakpointValue,
      SidebarController.values.breakpoint.default,
      SidebarController.valueConstraints.breakpoint,
    );
  }
}
