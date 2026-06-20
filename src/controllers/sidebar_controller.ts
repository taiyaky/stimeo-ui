import { Controller } from "@hotwired/stimulus";
import { FocusTrap } from "../utils/focus_trap";

/** Current responsive mode, driven by a `min-width` media query. */
type Mode = "inline" | "overlay";

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
 * {@link FocusTrap} (the same trap used by dialog / alert-dialog / drawer).
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
 * modal *behavior* (cf. drawer's note on `<aside role="dialog">` conflicts).
 * The collapsed preference persists across Turbo navigations and full reloads;
 * the transient overlay-open state never persists, so "back/forward" never
 * restores a stuck-open menu.
 */
export class SidebarController extends Controller<HTMLElement> {
  static override targets = ["trigger", "panel", "backdrop"];
  static override values = {
    breakpoint: { type: Number, default: 768 },
    key: { type: String, default: "" },
    collapsed: { type: Boolean, default: false },
  };
  static actions = ["close", "open", "toggle"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly panelTarget: HTMLElement;
  declare readonly backdropTarget: HTMLElement;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasPanelTarget: boolean;
  declare readonly hasBackdropTarget: boolean;

  declare breakpointValue: number;
  declare keyValue: string;
  declare collapsedValue: boolean;

  /** Owns the overlay modal side effects; Escape closes, focus falls to trigger. */
  readonly #trap = new FocusTrap(() => this.panelTarget, {
    onEscape: () => this.close(),
    fallbackFocus: () => (this.hasTriggerTarget ? this.triggerTarget : null),
  });

  /** Current responsive mode. */
  #mode: Mode = "inline";
  /** Persisted inline preference: whether the rail is collapsed. */
  #collapsed = false;
  /** The matched media query (`min-width: breakpoint`), watched for mode changes. */
  #mql: MediaQueryList | null = null;
  /** Pending `transitionend` hide listener, cancelled on reopen/teardown. */
  #pendingHide: (() => void) | null = null;

  override connect(): void {
    this.#collapsed = this.#restoreCollapsed();
    this.#mql = this.#matchBreakpoint();
    this.#mql?.addEventListener("change", this.#onMediaChange);
    this.#applyMode(this.#computeMode());
  }

  override disconnect(): void {
    this.#mql?.removeEventListener("change", this.#onMediaChange);
    this.#cancelPendingHide();
    this.#trap.deactivate({ restoreFocus: false });
  }

  /** Toggles the panel: inline flips collapsed/expanded, overlay flips open/closed. */
  toggle(): void {
    if (this.#isOverlay) {
      this.#isOverlayOpen ? this.#closeOverlay() : this.#openOverlay();
    } else {
      this.#setCollapsed(!this.#collapsed);
    }
  }

  /** Shows the panel (inline: expand; overlay: open). */
  open(): void {
    if (this.#isOverlay) this.#openOverlay();
    else this.#setCollapsed(false);
  }

  /** Hides the panel (inline: collapse; overlay: close). */
  close(): void {
    if (this.#isOverlay) this.#closeOverlay();
    else this.#setCollapsed(true);
  }

  // --- Mode handling ---------------------------------------------------------

  /** Re-renders the closed/default state for `mode` and records it. */
  #applyMode(mode: Mode): void {
    this.#mode = mode;
    if (this.hasPanelTarget) this.panelTarget.setAttribute("data-mode", mode);
    if (mode === "inline") {
      // Drop any overlay residue, then render the persisted rail state.
      this.#cancelPendingHide();
      this.#trap.deactivate({ restoreFocus: false });
      if (this.hasPanelTarget) this.panelTarget.hidden = false;
      this.#hideBackdrop();
      this.#applyInlineState(this.#collapsed);
    } else {
      // Overlay always starts closed; never auto-open on a mode switch.
      this.#cancelPendingHide();
      this.#trap.deactivate({ restoreFocus: false });
      this.#setOverlayClosedImmediate();
    }
  }

  readonly #onMediaChange = (event: MediaQueryListEvent): void => {
    const next: Mode = event.matches ? "inline" : "overlay";
    if (next !== this.#mode) this.#applyMode(next);
  };

  #computeMode(): Mode {
    return (this.#mql?.matches ?? true) ? "inline" : "overlay";
  }

  #matchBreakpoint(): MediaQueryList | null {
    if (typeof window.matchMedia !== "function") return null;
    return window.matchMedia(`(min-width: ${this.breakpointValue}px)`);
  }

  // --- Inline (rail) ---------------------------------------------------------

  /** Sets, reflects, and persists the inline collapsed preference. */
  #setCollapsed(collapsed: boolean): void {
    this.#collapsed = collapsed;
    this.#applyInlineState(collapsed);
    this.#persistCollapsed(collapsed);
  }

  /** Reflects the inline rail state onto the panel and trigger. */
  #applyInlineState(collapsed: boolean): void {
    if (this.hasPanelTarget) {
      this.panelTarget.setAttribute("data-state", collapsed ? "collapsed" : "expanded");
    }
    this.#setExpandedAttr(!collapsed);
  }

  // --- Overlay (off-canvas modal) -------------------------------------------

  /** Opens the overlay: reveal it, commit a starting frame, then trap focus. */
  #openOverlay(): void {
    if (!this.hasPanelTarget || this.#isOverlayOpen) return;
    this.#cancelPendingHide();
    this.panelTarget.hidden = false;
    if (this.hasBackdropTarget) this.backdropTarget.hidden = false;
    // Commit the closed (off-canvas) frame before flipping to open so the enter
    // transition has a starting frame to animate (cf. drawer).
    void this.panelTarget.offsetWidth;
    this.#setOverlayState("open");
    this.#setExpandedAttr(true);
    this.#trap.activate();
  }

  /** Closes the overlay: start the exit transition, defer hide + trap teardown. */
  #closeOverlay(): void {
    if (!this.hasPanelTarget || !this.#isOverlayOpen) return;
    this.#setOverlayState("closed");
    this.#setExpandedAttr(false);
    this.#hideAfterTransition();
  }

  /** Renders the overlay closed state up front (used when entering overlay mode). */
  #setOverlayClosedImmediate(): void {
    this.#setOverlayState("closed");
    this.#setExpandedAttr(false);
    if (this.hasPanelTarget) this.panelTarget.hidden = true;
    this.#hideBackdrop();
  }

  /** Syncs `data-state` on the panel and backdrop together (overlay). */
  #setOverlayState(state: "open" | "closed"): void {
    if (this.hasPanelTarget) this.panelTarget.setAttribute("data-state", state);
    if (this.hasBackdropTarget) this.backdropTarget.setAttribute("data-state", state);
  }

  /**
   * Applies `hidden` once the close transition ends so the exit slide can play,
   * then reverts the modal side effects. With no transition (0ms / reduced
   * motion / unstyled) it runs synchronously rather than awaiting an event that
   * would never fire.
   */
  #hideAfterTransition(): void {
    const panel = this.panelTarget;
    const duration = maxTransitionMs(getComputedStyle(panel).transitionDuration);
    if (duration === 0) {
      this.#applyOverlayHidden();
      return;
    }
    const onEnd = (event: TransitionEvent): void => {
      if (event.target !== panel) return;
      this.#cancelPendingHide();
      this.#applyOverlayHidden();
    };
    this.#pendingHide = () => panel.removeEventListener("transitionend", onEnd);
    panel.addEventListener("transitionend", onEnd);
  }

  /** Hides the panel/backdrop and tears down the trap after the exit transition. */
  #applyOverlayHidden(): void {
    if (this.hasPanelTarget) this.panelTarget.hidden = true;
    this.#hideBackdrop();
    this.#trap.deactivate();
  }

  #hideBackdrop(): void {
    if (!this.hasBackdropTarget) return;
    this.backdropTarget.setAttribute("data-state", "closed");
    this.backdropTarget.hidden = true;
  }

  #cancelPendingHide(): void {
    this.#pendingHide?.();
    this.#pendingHide = null;
  }

  // --- Shared helpers --------------------------------------------------------

  #setExpandedAttr(expanded: boolean): void {
    if (this.hasTriggerTarget) {
      this.triggerTarget.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
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
    const key = this.#storageKey;
    if (key) {
      try {
        const stored = localStorage.getItem(key);
        if (stored !== null) return stored === "1";
      } catch {
        // localStorage may be unavailable; fall through to the DOM / declared default.
      }
    }
    const domState = this.hasPanelTarget ? this.panelTarget.getAttribute("data-state") : null;
    if (domState === "collapsed") return true;
    if (domState === "expanded") return false;
    return this.collapsedValue;
  }

  /** Persists the collapsed preference when a key is configured. */
  #persistCollapsed(collapsed: boolean): void {
    const key = this.#storageKey;
    if (!key) return;
    try {
      localStorage.setItem(key, collapsed ? "1" : "0");
    } catch {
      // Best-effort: ignore storage failures (private mode / quota).
    }
  }

  get #storageKey(): string {
    return this.keyValue ? `stimeo--sidebar:${this.keyValue}` : "";
  }

  get #isOverlay(): boolean {
    return this.#mode === "overlay";
  }

  get #isOverlayOpen(): boolean {
    return (
      this.#isOverlay &&
      this.hasPanelTarget &&
      this.panelTarget.getAttribute("data-state") === "open"
    );
  }
}
