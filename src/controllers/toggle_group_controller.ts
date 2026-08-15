import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowStep } from "../utils/arrow_step";
import { inheritsFieldsetDisabled } from "../utils/focus_candidate";
import { isInteractiveHost } from "../utils/interactive_host";
import { RovingTabindex, rovingMove } from "../utils/roving_tabindex";

/** Item attributes whose retained-element changes can alter this controller's contract. */
const ITEM_ATTRIBUTES = [
  "aria-pressed",
  "disabled",
  "hidden",
  "type",
  "href",
  "contenteditable",
  "controls",
];

/** Modifier keys that keep document-level Home/End shortcuts outside the widget. */
const hasModifier = (event: KeyboardEvent): boolean =>
  event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;

/**
 * Headless, accessible toggle-button group behavior.
 *
 * Markup contract (identifier: `stimeo--toggle-group`):
 *   <div data-controller="stimeo--toggle-group"
 *        data-stimeo--toggle-group-mode-value="single"
 *        role="group" aria-label="Text style">
 *     <button type="button" aria-pressed="true" tabindex="0" data-value="bold"
 *             data-stimeo--toggle-group-target="item">Bold</button>
 *     <!-- more items; exactly one navigable item has tabindex=0 -->
 *   </div>
 *
 * Implements the WAI-ARIA APG **Button (toggle)** pattern with **Toolbar**-style
 * roving navigation. Each item's pressed state is `aria-pressed` (the accessible
 * name never changes); the group is a single Tab stop. For strict mutually
 * exclusive selection with radio semantics, use
 * {@link RadioGroupController | Radio Group} instead.
 *
 * @remarks
 * Behavior only — the consumer styles off `[aria-pressed="true"]`. A supported
 * item is either `<button type="button">` or a non-interactive host such as
 * `<div role="button">`; other native interactive elements retain their own
 * activation model and this controller stands down on them.
 *
 * Click handling and keydown handling are delegated from the group, so items
 * added at runtime need only the `item` target. Per-item `data-action` bindings
 * to {@link toggle} and {@link onKeydown} remain supported and are idempotent
 * when combined with delegation.
 *
 * Behavior provided:
 * - Click (or Space/Enter) toggles an item. In `single` mode pressing one item
 *   releases the others (0 or 1 pressed); `multiple` allows any number.
 * - `ArrowRight`/`ArrowDown` move focus to the next navigable item,
 *   `ArrowLeft`/`ArrowUp` to the previous (wrapping); `Home`/`End` to the
 *   first/last. Native-disabled and hidden items are skipped. ARIA-disabled
 *   items remain discoverable in the roving order but cannot be activated.
 * - `stimeo--toggle-group:change` is dispatched only for user activation. Its
 *   detail is `{ value: string, pressed: boolean, values: string[] }`, where
 *   `values` is the DOM-ordered value list of every item left pressed.
 */
export class ToggleGroupController extends Controller<HTMLElement> {
  static override targets = ["item"];
  static override values = {
    mode: { type: String, default: "multiple" },
  };
  static actions = ["onKeydown", "toggle"] as const;
  static events = ["change"] as const;

  declare readonly itemTargets: HTMLElement[];
  declare modeValue: string;

  readonly #roving = new RovingTabindex(() => this.#managedTargets);
  readonly #handledEvents = new WeakSet<Event>();
  readonly #managedItems = new Set<HTMLElement>();
  readonly #originalTabindex = new Map<HTMLElement, string | null>();
  readonly #ownedPressed = new Set<HTMLElement>();
  readonly #internalPressedValues = new Map<HTMLElement, string>();
  #observer: MutationObserver | null = null;
  #connected = false;

  /**
   * Normalizes state and establishes one roving entry point. A single authored
   * `tabindex="0"` survives reconnect; otherwise the first pressed, navigable
   * item wins, falling back to the first navigable item.
   */
  override connect(): void {
    const currentItems = new Set(this.itemTargets);
    for (const item of this.#managedItems) {
      if (!currentItems.has(item)) this.#releaseItem(item);
    }
    const authoredStops = this.itemTargets.filter(
      (item) =>
        this.#isSupportedHost(item) &&
        item.getAttribute("tabindex") === "0" &&
        this.#isNavigable(item),
    );
    const preferred = authoredStops.length === 1 ? authoredStops[0] : null;

    for (const item of this.itemTargets) this.#reconcileHost(item, false);
    this.#normalizeSelection();
    this.#ensureTabStop(preferred);

    this.element.addEventListener("click", this.#onClickCapture, true);
    this.element.addEventListener("keydown", this.#onKeydownCapture, true);
    this.element.addEventListener("click", this.#onClick);
    this.element.addEventListener("keydown", this.#onKeydown);
    this.element.addEventListener("focusin", this.#onFocusin);
    this.#connected = true;
    // Writes made before observation started cannot produce records and must
    // not be mistaken for a later retained-element morph.
    this.#internalPressedValues.clear();
    this.#observeMutations();
  }

  /** Releases every listener and observer while retaining DOM state for Turbo cache/reconnect. */
  override disconnect(): void {
    this.#connected = false;
    this.element.removeEventListener("click", this.#onClickCapture, true);
    this.element.removeEventListener("keydown", this.#onKeydownCapture, true);
    this.element.removeEventListener("click", this.#onClick);
    this.element.removeEventListener("keydown", this.#onKeydown);
    this.element.removeEventListener("focusin", this.#onFocusin);
    this.#observer?.disconnect();
    this.#observer = null;
    this.#internalPressedValues.clear();
  }

  /** Drops a newly connected item from the Tab sequence before reconciling the group. */
  itemTargetConnected(item: HTMLElement): void {
    if (!this.#connected) return;
    this.#reconcileHost(item, true);
    this.#normalizeSelection();
    this.#ensureTabStop();
  }

  /** Restores attributes owned only while an element is an item and repairs the Tab stop. */
  itemTargetDisconnected(item: HTMLElement): void {
    if (!this.#connected) return;
    this.#releaseItem(item);
    this.#normalizeSelection();
    this.#ensureTabStop();
  }

  /** Reconciles the single-selection invariant when the Stimulus Value changes. */
  modeValueChanged(): void {
    if (!this.#connected) return;
    this.#normalizeSelection();
    this.#ensureTabStop();
  }

  /**
   * Toggles the action's item. Per-item action wiring is optional because click
   * is also delegated from the group.
   */
  toggle(event: Event): void {
    if (event.defaultPrevented) return;
    const item = event.currentTarget as HTMLElement | null;
    if (!item || !this.itemTargets.includes(item)) return;
    this.#handledEvents.add(event);
    this.#toggleItem(item);
  }

  /**
   * Moves focus or activates the action's item. Per-item action wiring is
   * optional because keydown is also delegated from the group.
   */
  onKeydown(event: KeyboardEvent): void {
    const item = event.currentTarget as HTMLElement | null;
    if (!item || !this.itemTargets.includes(item)) return;
    this.#handleKeydown(event, item);
  }

  /** Blocks disabled activation before per-item or consumer event handlers run. */
  readonly #onClickCapture = (event: MouseEvent): void => {
    const item = this.#itemForEventTarget(event.target);
    if (!item || !this.#isSupportedHost(item) || !this.#isActivationDisabled(item)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /** Blocks disabled keyboard activation while leaving navigation keys available. */
  readonly #onKeydownCapture = (event: KeyboardEvent): void => {
    if (event.key !== " " && event.key !== "Enter") return;
    const item = this.#itemForEventTarget(event.target);
    if (!item || !this.#isSupportedHost(item) || !this.#isActivationDisabled(item)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /** Delegated click path for static and runtime-added items without actions. */
  readonly #onClick = (event: MouseEvent): void => {
    if (this.#handledEvents.delete(event) || event.defaultPrevented) return;
    const item = this.#itemForEventTarget(event.target);
    if (item) this.#toggleItem(item);
  };

  /** Delegated keydown path for static and runtime-added items without actions. */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    const item = this.#itemForEventTarget(event.target);
    if (item) this.#handleKeydown(event, item);
  };

  /** Keeps programmatic and pointer focus as the group's next Tab entry point. */
  readonly #onFocusin = (event: FocusEvent): void => {
    const item = this.#itemForEventTarget(event.target);
    if (!item || !this.#isNavigable(item)) return;
    this.#setActive(item);
  };

  /** Applies the APG navigation and activation key map to one supported item. */
  #handleKeydown(event: KeyboardEvent, item: HTMLElement): void {
    if (event.defaultPrevented || !this.#isSupportedHost(item)) return;
    if (event.isComposing) return;
    if (isReservedArrowChord(event)) return;
    if ((event.key === "Home" || event.key === "End") && hasModifier(event)) return;

    if (!this.#managedItems.has(item)) this.#reconcileHost(item, true);
    this.#ensureTabStop();
    const items = this.#managedTargets;
    const current = items.indexOf(item);

    if (event.key === " " || event.key === "Enter") {
      if (this.#isActivationDisabled(item)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (item instanceof HTMLButtonElement) {
        if (event.repeat) event.preventDefault();
        return;
      }
      event.preventDefault();
      if (!event.repeat) this.#toggleItem(item);
      return;
    }

    const step = logicalArrowStep(event.key, this.element);
    let destination: HTMLElement | undefined;
    if (step !== 0) {
      destination = this.#nextNavigable(current, step);
    } else if (event.key === "Home") {
      destination = this.#navigableItems[0];
    } else if (event.key === "End") {
      const navigable = this.#navigableItems;
      destination = navigable[navigable.length - 1];
    } else {
      return;
    }

    event.preventDefault();
    if (destination) this.#setActive(destination, true);
  }

  /** Applies one user toggle and dispatches the documented change detail. */
  #toggleItem(item: HTMLElement): void {
    if (!this.#isSupportedHost(item) || this.#isActivationDisabled(item)) return;
    if (!this.#managedItems.has(item)) this.#reconcileHost(item, true);
    const willPress = !this.#isPressed(item);
    if (this.modeValue === "single") {
      for (const other of this.#managedTargets)
        this.#setPressed(other, other === item && willPress);
    } else {
      this.#setPressed(item, willPress);
    }
    this.#setActive(item);
    this.dispatch("change", {
      detail: { value: this.#itemValue(item), pressed: willPress, values: this.#pressedValues() },
    });
  }

  /** Reconciles supported hosts, pressed state, and the roving invariant after a DOM mutation. */
  #reconcile(): void {
    for (const item of this.itemTargets) this.#reconcileHost(item, true);
    this.#normalizeSelection();
    this.#ensureTabStop();
  }

  /** Begins or ends ownership according to the item's current host semantics. */
  #reconcileHost(item: HTMLElement, dropFromTabSequence: boolean): void {
    if (!this.#isSupportedHost(item)) {
      this.#releaseItem(item);
      return;
    }
    if (!this.#managedItems.has(item)) {
      this.#managedItems.add(item);
      this.#originalTabindex.set(item, item.getAttribute("tabindex"));
      if (dropFromTabSequence) item.tabIndex = -1;
    }
    this.#normalizePressed(item);
  }

  /** Restores only defaults owned because an element belonged to this group. */
  #releaseItem(item: HTMLElement): void {
    if (!this.#managedItems.delete(item)) return;
    const original = this.#originalTabindex.get(item);
    if (original === null) item.removeAttribute("tabindex");
    else if (original !== undefined) item.setAttribute("tabindex", original);
    this.#originalTabindex.delete(item);
    if (this.#ownedPressed.delete(item)) item.removeAttribute("aria-pressed");
    this.#internalPressedValues.delete(item);
  }

  /** Supplies a missing pressed state and normalizes invalid ARIA tokens. */
  #normalizePressed(item: HTMLElement): void {
    const value = item.getAttribute("aria-pressed");
    if (value === null) {
      this.#ownedPressed.add(item);
      this.#internalPressedValues.set(item, "false");
      item.setAttribute("aria-pressed", "false");
    } else if (value !== "true" && value !== "false") {
      item.setAttribute("aria-pressed", "false");
    }
  }

  /** Makes the first DOM-ordered pressed item the sole pressed item in single mode. */
  #normalizeSelection(): void {
    for (const item of this.#managedTargets) this.#normalizePressed(item);
    if (this.modeValue !== "single") return;
    let found = false;
    for (const item of this.#managedTargets) {
      if (!this.#isPressed(item)) continue;
      if (!found) found = true;
      else this.#setPressed(item, false);
    }
  }

  /** Keeps one navigable Tab stop, preferring current DOM state after initial connect. */
  #ensureTabStop(initialPreference?: HTMLElement | null): void {
    const navigable = this.#navigableItems;
    let active: HTMLElement | undefined;
    if (initialPreference !== undefined) {
      active = initialPreference ?? undefined;
    } else {
      const current = this.#managedTargets.filter(
        (item) => item.tabIndex === 0 && this.#isNavigable(item),
      );
      if (current.length === 1) active = current[0];
    }
    active ??= navigable.find((item) => this.#isPressed(item));
    active ??= navigable[0];
    this.#setActive(active ?? null);
  }

  /** Moves through the full item order until a navigable destination is found. */
  #nextNavigable(fromIndex: number, delta: 1 | -1): HTMLElement | undefined {
    const items = this.#managedTargets;
    let index = fromIndex;
    for (let step = 0; step < items.length; step++) {
      index = rovingMove(index, items.length, delta, "wrap");
      const candidate = items[index];
      if (candidate && this.#isNavigable(candidate)) return candidate;
    }
    return undefined;
  }

  /** Assigns the single roving Tab stop and optionally moves DOM focus. */
  #setActive(item: HTMLElement | null, focus = false): void {
    this.#roving.setActive(this.#managedTargets.indexOf(item as HTMLElement), { focus });
  }

  /** Finds this group's item containing an event target, excluding nested groups. */
  #itemForEventTarget(target: EventTarget | null): HTMLElement | undefined {
    if (!this.#ownsEventTarget(target)) return undefined;
    const node = target as Element;
    return this.itemTargets.find((item) => item === node || item.contains(node));
  }

  /** Whether the closest Toggle Group scope around a target is this instance. */
  #ownsEventTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      target.closest('[data-controller~="stimeo--toggle-group"]') === this.element
    );
  }

  /** Hosts whose activation model can be owned without conflicting native behavior. */
  #isSupportedHost(item: HTMLElement): boolean {
    if (item instanceof HTMLButtonElement) return item.type === "button";
    return !isInteractiveHost(item);
  }

  /** Items eligible for roving focus (ARIA-disabled deliberately remains eligible). */
  #isNavigable(item: HTMLElement): boolean {
    if (!this.#isSupportedHost(item) || this.#isHidden(item)) return false;
    if (!(item instanceof HTMLButtonElement)) return true;
    return !item.disabled && !inheritsFieldsetDisabled(item);
  }

  /** Whether hidden applies on the path from an item up to the group root. */
  #isHidden(item: HTMLElement): boolean {
    let current: HTMLElement | null = item;
    while (current && current !== this.element) {
      if (current.hasAttribute("hidden")) return true;
      current = current.parentElement;
    }
    return false;
  }

  /** Whether ARIA, visibility, or native HTML semantics suppress activation. */
  #isActivationDisabled(item: HTMLElement): boolean {
    if (!this.#isNavigable(item)) return true;
    let current: HTMLElement | null = item;
    while (current) {
      if (current.getAttribute("aria-disabled") === "true") return true;
      current = current.parentElement;
    }
    return false;
  }

  /** Releases default ownership when a Turbo morph authors `aria-pressed`. */
  #releaseAuthoredPressed(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.attributeName !== "aria-pressed") continue;
      const item = record.target as HTMLElement;
      const value = item.getAttribute("aria-pressed");
      if (value !== null && this.#internalPressedValues.get(item) !== value) {
        this.#ownedPressed.delete(item);
      }
    }
    this.#internalPressedValues.clear();
  }

  /** Watches target membership, retained item hosts/state, and inherited host/fieldset state. */
  #observeMutations(): void {
    const observer = new MutationObserver((records) => {
      this.#releaseAuthoredPressed(records);
      observer.disconnect();
      this.#reconcile();
      this.#observeWith(observer);
    });
    this.#observer = observer;
    this.#observeWith(observer);
  }

  /** Registers every root and ancestor observation on one observer instance. */
  #observeWith(observer: MutationObserver): void {
    observer.observe(this.element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ITEM_ATTRIBUTES,
    });
    let ancestor = this.element.parentElement;
    while (ancestor) {
      observer.observe(ancestor, {
        attributes: true,
        attributeFilter: ["contenteditable", "disabled"],
      });
      ancestor = ancestor.parentElement;
    }
  }

  /** Supported targets currently managed by the roving primitive. */
  get #managedTargets(): HTMLElement[] {
    return this.itemTargets.filter((item) => this.#managedItems.has(item));
  }

  /** Managed items eligible for the roving Tab stop. */
  get #navigableItems(): HTMLElement[] {
    return this.#managedTargets.filter((item) => this.#isNavigable(item));
  }

  /** Whether an item is currently pressed. */
  #isPressed(item: HTMLElement): boolean {
    return item.getAttribute("aria-pressed") === "true";
  }

  /** Reflects pressed state while distinguishing controller writes from authored morphs. */
  #setPressed(item: HTMLElement, pressed: boolean): void {
    const value = pressed ? "true" : "false";
    this.#internalPressedValues.set(item, value);
    item.setAttribute("aria-pressed", value);
  }

  /** The DOM-ordered values of every currently pressed managed item. */
  #pressedValues(): string[] {
    return this.#managedTargets
      .filter((item) => this.#isPressed(item))
      .map((item) => this.#itemValue(item));
  }

  /** An item's value (`data-value`, defaulting to empty). */
  #itemValue(item: HTMLElement): string {
    return item.getAttribute("data-value") ?? "";
  }
}
