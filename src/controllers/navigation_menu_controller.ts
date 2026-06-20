import { Controller } from "@hotwired/stimulus";
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
 * naturally. `Escape` closes the open panel and returns focus to its trigger; an
 * outside click or focus leaving the nav closes it. `ArrowLeft`/`ArrowRight` move
 * focus between triggers without rewriting `tabindex` (they keep their natural Tab
 * order). Hover open/close is opt-in via `openOnHover`.
 *
 * @remarks
 * Behavior only. Panel layout, mega-menu styling, and animation are the
 * consumer's CSS. Static placement is CSS; viewport-edge collision avoidance is
 * delegated to the opt-in `stimeo-ui/positioning` module (never imported here, so
 * the core stays zero-dependency). For an app command menu with arrow roving and
 * `role="menu"`, use `stimeo--menubar` instead.
 */
export class NavigationMenuController extends Controller<HTMLElement> {
  static override targets = ["trigger", "panel"];
  static override values = {
    openOnHover: { type: Boolean, default: false },
    hoverDelay: { type: Number, default: 150 },
  };
  static actions = ["onTriggerKeydown", "toggle"] as const;

  declare readonly triggerTargets: HTMLElement[];
  declare readonly panelTargets: HTMLElement[];

  declare openOnHoverValue: boolean;
  declare hoverDelayValue: number;

  /** Open/close delay timers for hover mode; cleared together on disconnect. */
  readonly #hoverTimers = new SafeTimeout();

  /** Establishes the closed baseline and the dismissal listeners. */
  override connect(): void {
    this.#closeAll();
    document.addEventListener("click", this.#onOutsideClick);
    document.addEventListener("keydown", this.#onKeydown);
    this.element.addEventListener("focusout", this.#onFocusOut);
    if (this.openOnHoverValue) this.#addHoverListeners();
  }

  /** Removes every listener and pending hover timer registered in {@link connect}. */
  override disconnect(): void {
    document.removeEventListener("click", this.#onOutsideClick);
    document.removeEventListener("keydown", this.#onKeydown);
    this.element.removeEventListener("focusout", this.#onFocusOut);
    if (this.openOnHoverValue) this.#removeHoverListeners();
    this.#hoverTimers.clearAll();
  }

  /** Toggles a trigger's panel (single-open). Bound via `data-action` (click). */
  toggle(event: Event): void {
    const trigger = event.currentTarget as HTMLElement;
    if (this.#isExpanded(trigger)) {
      this.#closePanel(trigger);
    } else {
      this.#openPanel(trigger);
    }
  }

  /** `ArrowLeft`/`ArrowRight` move focus between triggers (keeping Tab order). */
  onTriggerKeydown(event: KeyboardEvent): void {
    const triggers = this.triggerTargets;
    const index = triggers.indexOf(event.currentTarget as HTMLElement);
    if (index === -1) return;
    const length = triggers.length;

    if (event.key === "ArrowRight") {
      event.preventDefault();
      triggers[(index + 1) % length]?.focus();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      triggers[(index - 1 + length) % length]?.focus();
    }
  }

  /** Opens `trigger`'s panel, closing any other open panel first. */
  #openPanel(trigger: HTMLElement): void {
    this.#closeAll();
    const panel = this.#panelFor(trigger);
    if (!panel) return;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  }

  /** Closes `trigger`'s panel and reflects the collapsed state. */
  #closePanel(trigger: HTMLElement): void {
    const panel = this.#panelFor(trigger);
    if (panel) panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }

  /** Closes every open panel. */
  #closeAll(): void {
    for (const trigger of this.triggerTargets) this.#closePanel(trigger);
  }

  /** Closes any open panel and returns focus to its trigger (Escape path). */
  #closeAndRestore(): void {
    const open = this.#openTrigger;
    if (!open) return;
    this.#closePanel(open);
    open.focus();
  }

  /** Closes panels when a click lands outside the nav element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (this.#isAnyOpen && !this.element.contains(event.target as Node)) this.#closeAll();
  };

  /** Closes (restoring focus) on `Escape` while a panel is open. */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.#isAnyOpen) return;
    // Only act when focus is within this nav so unrelated Escapes are ignored.
    if (!this.element.contains(document.activeElement)) return;
    event.preventDefault();
    this.#closeAndRestore();
  };

  /** Closes (without restoring focus) when focus leaves the nav entirely. */
  readonly #onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget as Node | null;
    if (next && this.element.contains(next)) return;
    this.#closeAll();
  };

  /** Opens a trigger's panel after the hover delay (hover mode). */
  readonly #onPointerEnter = (event: Event): void => {
    const trigger = this.#triggerForHover(event.currentTarget as HTMLElement);
    if (!trigger) return;
    this.#hoverTimers.clearAll();
    this.#hoverTimers.set(() => this.#openPanel(trigger), this.hoverDelayValue);
  };

  /** Closes the open panel after the hover delay (hover mode). */
  readonly #onPointerLeave = (): void => {
    this.#hoverTimers.clearAll();
    this.#hoverTimers.set(() => this.#closeAll(), this.hoverDelayValue);
  };

  /** Wires hover open/close on each trigger and its panel (opt-in). */
  #addHoverListeners(): void {
    for (const element of this.#hoverElements) {
      element.addEventListener("mouseenter", this.#onPointerEnter);
      element.addEventListener("mouseleave", this.#onPointerLeave);
    }
  }

  /** Removes the hover listeners added by `#addHoverListeners`. */
  #removeHoverListeners(): void {
    for (const element of this.#hoverElements) {
      element.removeEventListener("mouseenter", this.#onPointerEnter);
      element.removeEventListener("mouseleave", this.#onPointerLeave);
    }
  }

  /** Elements that participate in hover (each trigger and its panel). */
  get #hoverElements(): HTMLElement[] {
    return [...this.triggerTargets, ...this.panelTargets];
  }

  /** Resolves the trigger for a hovered element (the trigger itself or a panel). */
  #triggerForHover(element: HTMLElement): HTMLElement | null {
    const triggerIndex = this.triggerTargets.indexOf(element);
    if (triggerIndex !== -1) return element;
    const panelIndex = this.panelTargets.indexOf(element);
    if (panelIndex === -1) return null;
    return this.triggerTargets.find((trigger) => this.#panelFor(trigger) === element) ?? null;
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
