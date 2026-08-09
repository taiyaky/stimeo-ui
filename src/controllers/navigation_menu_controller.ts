import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";
import { claimsWhileFocusWithin, EscapeLayer } from "../utils/escape_layer";
import { isRtl } from "../utils/logical_scroll";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless, accessible **navigation menu** behavior (disclosure navigation).
 *
 * Markup contract (identifier: `stimeo--navigation-menu`):
 *   <nav data-controller="stimeo--navigation-menu" aria-label="Main">
 *     <ul>
 *       <li>
 *         <button data-stimeo--navigation-menu-target="trigger"
 *                 aria-expanded="false" aria-controls="nav-products"
 *                 data-action="click->stimeo--navigation-menu#toggle
 *                              keydown->stimeo--navigation-menu#onTriggerKeydown">
 *           Products
 *         </button>
 *         <div id="nav-products" data-stimeo--navigation-menu-target="panel" hidden>
 *           <a href="/a">Product A</a><a href="/b">Product B</a>
 *         </div>
 *       </li>
 *     </ul>
 *   </nav>
 *
 * Implements the WAI-ARIA APG **Disclosure** navigation pattern: each top-level
 * button toggles its sub-panel (`aria-expanded` + `hidden` synced), only one panel
 * is open at a time, and the panel content is a plain set of links (not a
 * `role="menu"`). Focus is **not** trapped — `Tab` moves through the links
 * naturally. `Escape` closes the open panel and returns focus to its trigger.
 * While a panel is open the nav is a layer on the shared {@link EscapeLayer}
 * stack; it claims a press only while focus is inside the nav or fell to the
 * body (a click on non-focusable panel content), so one keypress closes exactly
 * one layer. An outside click, or focus leaving the nav for a known external
 * destination, closes it. `ArrowLeft`/`ArrowRight` move focus between the
 * *navigable* triggers without rewriting `tabindex` (they keep their natural Tab
 * order); a modified press (`Alt`/`Ctrl`/`Meta`/`Shift`, e.g. the browser's
 * `Alt+←` history back) is left to the browser. Hover open/close is opt-in via
 * `openOnHover`.
 *
 * Every `panel` must be a **descendant of the nav element**: Stimulus resolves
 * targets within the controller's own scope, so a panel moved outside it (a
 * portal) never becomes a `panel` target and its trigger then opens nothing.
 *
 * By default the hover region is each trigger and its panel. An optional
 * `hoverArea` target widens it: mark a wrapper that contains **exactly one**
 * trigger (e.g. the `<li>` holding a top-level *link*, its disclosure button, and
 * its panel — the APG "Disclosure Navigation with Top-Level Links" arrangement)
 * and hovering anywhere over that wrapper opens the contained trigger's panel.
 * Wrapping several triggers at once (marking the whole `<ul>`, say) is not
 * supported: every hover over the area then resolves to the *first* contained
 * trigger. A trigger or panel inside a `hoverArea` defers to the wrapper (its own
 * edges stop scheduling open/close), so pointer movement within the area never
 * flickers the panel. Keep a trigger's panel inside its `hoverArea`: a panel left
 * outside simply falls back to the default two-region behavior — moving straight
 * across a shared edge never schedules a close (the leave handler checks
 * `relatedTarget`), and `hoverDelay` bridges the pointer's travel across an
 * actual gap. Targets added or removed **while connected** (e.g. a Turbo Stream
 * append) re-wire the hover listeners via Stimulus target callbacks; the same
 * callbacks also run during Stimulus teardown, so they no-op once disconnected.
 * Flipping `openOnHover` at runtime wires or unwires the listeners in place.
 * `hoverArea` has no effect unless `openOnHover` is enabled.
 *
 * Pointer-driven closing never hides focused content — hiding the panel would
 * take the focused link with it and drop focus to the body. So a hover *leave*
 * keeps the panel open while focus is inside it, and a hover *switch* to another
 * trigger returns focus to the outgoing trigger before hiding its panel. For the
 * same reason, while `openOnHover` is on, a click on a trigger whose hover region
 * the pointer currently occupies is a no-op: closing it would leave it unopenable
 * until the pointer left and re-entered (`mouseenter` does not re-fire in place).
 * `Escape` and outside clicks dismiss regardless.
 *
 * @remarks
 * Behavior only. Panel layout, mega-menu styling, and animation are the
 * consumer's CSS. Static placement is CSS; viewport-edge collision avoidance is
 * delegated to the opt-in `stimeo-ui/positioning` module (never imported here, so
 * the core stays zero-dependency). For an app command menu with arrow roving and
 * `role="menu"`, use `stimeo--menubar` instead.
 */
export class NavigationMenuController extends Controller<HTMLElement> {
  static override targets = ["trigger", "panel", "hoverArea"];
  static override values = {
    openOnHover: { type: Boolean, default: false },
    hoverDelay: { type: Number, default: 150 },
  };
  static actions = ["onTriggerKeydown", "toggle"] as const;

  declare readonly triggerTargets: HTMLElement[];
  declare readonly panelTargets: HTMLElement[];
  declare readonly hoverAreaTargets: HTMLElement[];

  declare openOnHoverValue: boolean;
  declare hoverDelayValue: number;

  /** Open/close delay timers for hover mode; cleared together on disconnect. */
  readonly #hoverTimers = new SafeTimeout();

  /**
   * Elements currently carrying hover listeners. Removal always mirrors this
   * set (not a recomputed target snapshot), so a rebuild driven by target churn
   * can never strand a listener on an element that stopped being a target.
   */
  readonly #hoverWired = new Set<HTMLElement>();

  /**
   * The trigger whose hover region the pointer currently occupies, if any. Only
   * the click semantics under `openOnHover` read it (see {@link toggle}).
   */
  #hoveredTrigger: HTMLElement | null = null;

  /**
   * Whether the controller is between `connect()` and `disconnect()`. Stimulus
   * disconnects the controller **before** disconnecting its targets, so the
   * target callbacks below also fire during teardown; without this flag their
   * rebuild would re-wire hover listeners onto an already-disconnected nav.
   */
  #connected = false;

  /** Escape-stack membership while any panel is open; the shared resolver dismisses via it. */
  readonly #escapeLayer = new EscapeLayer();

  /** Establishes the closed baseline and the dismissal listeners. */
  override connect(): void {
    this.#connected = true;
    this.#closeAll();
    document.addEventListener("click", this.#onOutsideClick, true);
    this.element.addEventListener("focusout", this.#onFocusOut);
    if (this.openOnHoverValue) this.#addHoverListeners();
  }

  /** Removes every listener, pending hover timer, and stack membership taken while connected. */
  override disconnect(): void {
    this.#connected = false;
    this.#escapeLayer.deactivate();
    document.removeEventListener("click", this.#onOutsideClick, true);
    this.element.removeEventListener("focusout", this.#onFocusOut);
    this.#removeHoverListeners();
    this.#hoverTimers.clearAll();
  }

  /**
   * Follows a runtime flip of `openOnHover` (a morph or a scripted attribute
   * change) by wiring or unwiring the hover listeners in place. Stimulus also
   * fires this once before `connect()`, which the `#connected` guard skips —
   * `connect()` owns the initial wiring.
   */
  openOnHoverValueChanged(): void {
    if (!this.#connected) return;
    if (this.openOnHoverValue) this.#addHoverListeners();
    else this.#removeHoverListeners();
  }

  /** Re-wires hover listeners when a target is added after connect (Turbo Streams etc.). */
  triggerTargetConnected(): void {
    this.#rewireHoverListeners();
  }

  /** Re-wires hover listeners when a target is removed while connected. */
  triggerTargetDisconnected(): void {
    this.#rewireHoverListeners();
  }

  /** See {@link NavigationMenuController.triggerTargetConnected}. */
  panelTargetConnected(): void {
    this.#rewireHoverListeners();
  }

  /** See {@link NavigationMenuController.triggerTargetDisconnected}. */
  panelTargetDisconnected(): void {
    this.#rewireHoverListeners();
  }

  /** See {@link NavigationMenuController.triggerTargetConnected}. */
  hoverAreaTargetConnected(): void {
    this.#rewireHoverListeners();
  }

  /** See {@link NavigationMenuController.triggerTargetDisconnected}. */
  hoverAreaTargetDisconnected(): void {
    this.#rewireHoverListeners();
  }

  /**
   * Toggles a trigger's panel (single-open). Bound via `data-action` (click).
   *
   * An explicit activation always wins over a scheduled hover open/close, so any
   * pending hover timer is dropped first — otherwise a close scheduled just
   * before the click would fire into the freshly opened panel.
   *
   * Under `openOnHover`, closing a panel the pointer itself is holding open is
   * refused: the pointer stays put, `mouseenter` does not re-fire, and the panel
   * would be unopenable until the pointer left and came back. Keyboard
   * activation (pointer elsewhere) still toggles it closed, and `Escape` and
   * outside clicks dismiss either way.
   */
  toggle(event: Event): void {
    const trigger = event.currentTarget as HTMLElement;
    this.#hoverTimers.clearAll();
    if (!this.#isExpanded(trigger)) {
      this.#openPanel(trigger);
      return;
    }
    if (this.openOnHoverValue && this.#hoveredTrigger === trigger) return;
    this.#closePanel(trigger);
  }

  /**
   * `ArrowLeft`/`ArrowRight` move focus between triggers (keeping Tab order).
   *
   * Only navigable triggers are destinations, so a `hidden` or disabled item
   * never swallows the press. A modified arrow belongs to the browser or OS
   * (`Alt+←`/`Alt+→` is history back/forward), and with no destination at all
   * (a single-trigger nav) the press is left to the page — `preventDefault()` is
   * called only when focus actually moves, keeping the scroll-suppression
   * contract honest.
   */
  onTriggerKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key must not ALSO move the
    // trigger focus — composition depends on this yield. It runs ahead of the
    // modifier check, so a claimed press is yielded whether or not it carries a
    // modifier.
    if (event.defaultPrevented) return;
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    if (isReservedArrowChord(event)) return;

    const current = event.currentTarget as HTMLElement;
    // The focused trigger stays in the ring even when it is not navigable
    // itself, so arrows still lead *out* of a trigger disabled while focused.
    const triggers = this.triggerTargets.filter(
      (trigger) => trigger === current || this.#isNavigable(trigger),
    );
    const index = triggers.indexOf(current);
    if (index === -1 || triggers.length < 2) return;

    event.preventDefault();
    // Logical, not physical: the triggers are an ordered row, so which one is
    // "next" follows the writing direction. Read from the controller element —
    // the nav lays the triggers out, and a trigger may carry its own `dir`.
    const forward = isRtl(this.element) ? "ArrowLeft" : "ArrowRight";
    const step = event.key === forward ? 1 : -1;
    triggers[(index + step + triggers.length) % triggers.length]?.focus();
  }

  /**
   * Opens `trigger`'s panel, closing any other open panel first. Re-opening an
   * already-open panel only re-asserts the Escape layer: the close/open
   * round-trip would rewrite `aria-expanded` and `hidden` for no state change.
   */
  #openPanel(trigger: HTMLElement): void {
    // Guarded here rather than in `toggle`, because hover reaches this method
    // without going through it. Reaching an `aria-disabled` trigger is what the
    // attribute asks for — opening its panel is the activation it forbids, and
    // opening a popup counts as activation.
    if (trigger.getAttribute("aria-disabled") === "true") return;
    if (this.#isExpanded(trigger)) {
      this.#syncEscapeLayer();
      return;
    }
    this.#closeAll();
    const panel = this.#panelFor(trigger);
    if (!panel) return;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    this.#syncEscapeLayer();
  }

  /** Closes `trigger`'s panel and reflects the collapsed state. */
  #closePanel(trigger: HTMLElement): void {
    const panel = this.#panelFor(trigger);
    if (panel) panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    this.#syncEscapeLayer();
  }

  /**
   * Closes every open panel and normalizes `aria-expanded="false"` on **all**
   * triggers, so a trigger whose panel was hidden by other means cannot keep
   * advertising an open panel.
   */
  #closeAll(): void {
    for (const trigger of this.triggerTargets) this.#closePanel(trigger);
  }

  /**
   * Whether a trigger can receive arrow-key focus: not `hidden`, not a natively
   * `disabled` control (mirrors `toolbar`). CSS-only visibility cannot be
   * detected headlessly and stays the consumer's responsibility.
   *
   * **`aria-disabled="true"` stays reachable.** APG separates the attributes by
   * intent: `disabled` is for controls a neighbour makes inferable, while
   * `aria-disabled` marks one that must remain *discoverable* — and a nav
   * section the user cannot even arrow to is a section they cannot learn exists.
   * Opening is suppressed separately, so the trigger announces itself and does
   * nothing.
   */
  #isNavigable(trigger: HTMLElement): boolean {
    if (trigger.hasAttribute("hidden")) return false;
    return !(trigger as HTMLButtonElement | HTMLInputElement).disabled;
  }

  /**
   * Aligns Escape-stack membership with the open state: joins (or re-asserts to
   * the top) while a panel is open, leaves once none is. Re-asserting when the
   * user switches panels is deliberate — the nav is again the newest layer.
   */
  #syncEscapeLayer(): void {
    if (this.#isAnyOpen) {
      this.#escapeLayer.activate(document, {
        onDismiss: () => this.#closeAndRestore(),
        claims: claimsWhileFocusWithin(this.element),
      });
    } else {
      this.#escapeLayer.deactivate();
    }
  }

  /**
   * Closes any open panel and returns focus to its trigger (Escape path). A
   * pending hover open would otherwise re-open the panel the user just
   * dismissed, so the reservation is dropped with it.
   */
  #closeAndRestore(): void {
    const open = this.#openTrigger;
    if (!open) return;
    this.#hoverTimers.clearAll();
    this.#closePanel(open);
    open.focus();
  }

  /** Closes panels when a click lands outside the nav element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (this.#isAnyOpen && !this.element.contains(event.target as Node)) this.#closeAll();
  };

  /**
   * Closes (without restoring focus) when focus leaves the nav for a known
   * external destination. A null/non-Node destination is indeterminate:
   * browsers use it for clicks on non-focusable content and for window
   * deactivation, so those never close the nav here (matching the popover
   * convention) — the outside-click handler decides pointer dismissal, and the
   * Escape stack's body-focus claim keeps keyboard dismissal working.
   */
  readonly #onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || this.element.contains(next)) return;
    this.#closeAll();
  };

  /** Opens a trigger's panel after the hover delay (hover mode). */
  readonly #onPointerEnter = (event: Event): void => {
    const trigger = this.#triggerForHover(event.currentTarget as HTMLElement);
    if (!trigger) return;
    this.#hoveredTrigger = trigger;
    this.#hoverTimers.clearAll();
    this.#hoverTimers.set(() => this.#openFromHover(trigger), this.hoverDelayValue);
  };

  /**
   * Closes the open panel after the hover delay (hover mode) — unless the
   * pointer moved directly into another part of the hover region (an adjacent
   * trigger, panel, or hoverArea): crossing a shared edge must not schedule a
   * spurious close, e.g. a hoverArea whose panel sits outside it as a sibling.
   */
  readonly #onPointerLeave = (event: Event): void => {
    const next = event instanceof MouseEvent ? event.relatedTarget : null;
    if (next instanceof Node && this.#hoverElements.some((el) => el.contains(next))) return;
    this.#hoveredTrigger = null;
    this.#hoverTimers.clearAll();
    this.#hoverTimers.set(() => this.#closeFromHover(), this.hoverDelayValue);
  };

  /**
   * Hover-driven open. Switching panels would hide the outgoing one, so focus
   * standing inside it is handed back to its trigger first: pointer movement
   * must never send focus to the body (the keyboard user would lose their
   * place). Focus outside the closing panel is left alone.
   */
  #openFromHover(trigger: HTMLElement): void {
    // Checked before the rescue below, not only inside `#openPanel`. The rescue
    // exists to get focus out of a panel that is about to be hidden; when the
    // destination refuses to open, nothing is hidden and moving focus buys
    // nothing — it just walks the caret out of a panel that stays open.
    if (trigger.getAttribute("aria-disabled") === "true") return;
    const open = this.#openTrigger;
    if (open && open !== trigger && this.#holdsFocus(this.#panelFor(open))) open.focus();
    this.#openPanel(trigger);
  }

  /**
   * Hover-driven close: skipped while focus sits inside the panel it would hide,
   * for the same no-focus-loss reason (cf. `hover_card`'s delayed close). The
   * panel then stays open until `Escape`, an outside click, or focus leaving the
   * nav dismisses it — all of which restore or keep focus deliberately.
   */
  #closeFromHover(): void {
    const open = this.#openTrigger;
    if (open && this.#holdsFocus(this.#panelFor(open))) return;
    this.#closeAll();
  }

  /** Whether `panel` exists and currently contains the focused element. */
  #holdsFocus(panel: HTMLElement | null): boolean {
    return panel?.contains(document.activeElement) ?? false;
  }

  /** Wires hover open/close on each hover element (opt-in), tracking what was wired. */
  #addHoverListeners(): void {
    for (const element of this.#hoverElements) {
      element.addEventListener("mouseenter", this.#onPointerEnter);
      element.addEventListener("mouseleave", this.#onPointerLeave);
      this.#hoverWired.add(element);
    }
  }

  /** Removes the hover listeners from exactly the elements that were wired. */
  #removeHoverListeners(): void {
    for (const element of this.#hoverWired) {
      element.removeEventListener("mouseenter", this.#onPointerEnter);
      element.removeEventListener("mouseleave", this.#onPointerLeave);
    }
    this.#hoverWired.clear();
    this.#hoveredTrigger = null;
  }

  /**
   * Rebuilds the hover wiring from the current targets. Target callbacks call
   * this so items added or removed after connect (e.g. a Turbo Stream append)
   * participate in hover; the wired-set removal keeps the rebuild symmetric.
   * Stimulus fires those callbacks during teardown too, hence the `#connected`
   * guard — a rebuild after `disconnect()` would resurrect the listeners.
   */
  #rewireHoverListeners(): void {
    if (!this.#connected || !this.openOnHoverValue) return;
    this.#removeHoverListeners();
    this.#addHoverListeners();
  }

  /**
   * Elements that participate in hover: each `hoverArea`, plus every trigger and
   * panel **not** wrapped by one. A wrapped trigger/panel must defer to its
   * wrapper — its own mouseleave would otherwise schedule a close while the
   * pointer is still inside the area (mouseenter does not re-fire on the wrapper
   * when moving among its descendants), flickering the panel shut.
   */
  get #hoverElements(): HTMLElement[] {
    const areas = this.hoverAreaTargets;
    const covered = (element: HTMLElement): boolean => areas.some((area) => area.contains(element));
    return [
      ...areas,
      ...this.triggerTargets.filter((trigger) => !covered(trigger)),
      ...this.panelTargets.filter((panel) => !covered(panel)),
    ];
  }

  /**
   * Resolves the trigger for a hovered element: the trigger itself, the trigger
   * controlling a hovered panel, or the first trigger contained in a hovered
   * `hoverArea` wrapper.
   */
  #triggerForHover(element: HTMLElement): HTMLElement | null {
    if (this.triggerTargets.includes(element)) return element;
    if (this.panelTargets.includes(element)) {
      return this.triggerTargets.find((trigger) => this.#panelFor(trigger) === element) ?? null;
    }
    if (this.hoverAreaTargets.includes(element)) {
      return this.triggerTargets.find((trigger) => element.contains(trigger)) ?? null;
    }
    return null;
  }

  /** The panel controlled by `trigger` (matched by `aria-controls`/`id`). */
  #panelFor(trigger: HTMLElement): HTMLElement | null {
    const id = trigger.getAttribute("aria-controls");
    // Resolve against this controller's own panel targets (not a global id
    // lookup) so it stays scoped to this nav instance.
    return id ? (this.panelTargets.find((panel) => panel.id === id) ?? null) : null;
  }

  /** Whether `trigger`'s panel is currently expanded. */
  #isExpanded(trigger: HTMLElement): boolean {
    return trigger.getAttribute("aria-expanded") === "true";
  }

  /** The trigger whose panel is currently open, if any. */
  get #openTrigger(): HTMLElement | null {
    return this.triggerTargets.find((trigger) => this.#isExpanded(trigger)) ?? null;
  }

  /** Whether any panel is currently open. */
  get #isAnyOpen(): boolean {
    return this.#openTrigger !== null;
  }
}
