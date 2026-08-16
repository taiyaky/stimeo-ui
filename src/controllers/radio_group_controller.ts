import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowStep } from "../utils/arrow_step";
import { inheritsFieldsetDisabled } from "../utils/focus_candidate";
import { isInteractiveHost } from "../utils/interactive_host";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { RovingTabindex, rovingMove } from "../utils/roving_tabindex";

/**
 * An attribute value this controller wrote, with how many observer records it
 * still owns. A pass that writes the same attribute more than once produces one
 * record per write, all reading back the final value, so the count is what keeps
 * the later records from looking like an author's edit.
 */
interface InternalWrite {
  value: string | null;
  count: number;
}

/** Radio and field attributes whose retained-element changes alter group state. */
const OBSERVED_ATTRIBUTES = [
  "aria-checked",
  "aria-disabled",
  "contenteditable",
  "controls",
  "data-value",
  "disabled",
  "hidden",
  "href",
  "tabindex",
  "type",
  "value",
];

/** Modifier keys that leave document-level Home/End shortcuts outside the widget. */
const hasModifier = (event: KeyboardEvent): boolean =>
  event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;

/**
 * Headless, accessible radio-group behavior for **custom** radios.
 *
 * Markup contract (identifier: `stimeo--radio-group`):
 *   <div data-controller="stimeo--radio-group" role="radiogroup" aria-label="Plan">
 *     <div role="radio" aria-checked="true" tabindex="0" data-value="basic"
 *          data-stimeo--radio-group-target="radio">Basic</div>
 *     <!-- more radios; exactly one navigable radio has tabindex=0 -->
 *     <input type="hidden" data-stimeo--radio-group-target="field" />
 *   </div>
 *
 * Implements the WAI-ARIA APG **Radio Group** pattern. Use this only for custom
 * radios; native `<input type="radio">` already owns its activation and form
 * semantics and should be preferred when its appearance is sufficient.
 *
 * `change` dispatches `{ value: string, radio: HTMLElement }`; `reconcile` dispatches
 * `{ value: string, radio: HTMLElement | null }`.
 *
 * @remarks
 * Behavior only — selection is exposed through `aria-checked`, the single Tab
 * stop through roving `tabindex` ({@link RovingTabindex}); the consumer styles
 * those attributes. Selection follows focus for enabled radios.
 *
 * A supported radio is either `<button type="button">` or a non-interactive
 * host such as `<div role="radio">`. Other native interactive elements retain
 * their activation model and this controller stands down on them.
 *
 * Click and keydown handling are delegated from the group, so radios added at
 * runtime need only the `radio` target. Per-radio `data-action` bindings to
 * {@link select} and {@link onKeydown} remain supported and are idempotent when
 * combined with delegation.
 *
 * Behavior provided:
 * - Click selects a radio.
 * - `ArrowDown`/`ArrowRight` select the next, `ArrowUp`/`ArrowLeft` the previous
 *   (wrapping); `Home`/`End` the first/last; `Space` selects the focused radio.
 * - Native-disabled and hidden radios are skipped. ARIA-disabled radios remain
 *   discoverable in the roving order but cannot be selected.
 * - The selected radio's `data-value` is mirrored to the optional hidden field.
 *   `stimeo--radio-group:change` is dispatched only when selection identity
 *   changes through user interaction.
 * - `stimeo--radio-group:reconcile` reports a selection this controller decided
 *   on its own — a removed selection, or first-wins over duplicate checked state
 *   — carrying the same detail as `change`. The hidden field's native `change`
 *   stays reserved for user edits, so form automation never sees a repair as one.
 */
export class RadioGroupController extends Controller<HTMLElement> {
  static override targets = ["radio", "field"];
  static actions = ["onKeydown", "select"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly radioTargets: HTMLElement[];
  declare readonly fieldTarget: HTMLInputElement;
  declare readonly hasFieldTarget: boolean;

  readonly #roving = new RovingTabindex(() => this.#managedTargets);
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileDom());
  readonly #handledEvents = new WeakSet<Event>();
  readonly #managedRadios = new Set<HTMLElement>();
  readonly #originalTabindex = new Map<HTMLElement, string | null>();
  readonly #ownedChecked = new Set<HTMLElement>();
  readonly #internalCheckedValues = new Map<HTMLElement, InternalWrite>();
  readonly #internalTabindexValues = new Map<HTMLElement, InternalWrite>();
  #observer: MutationObserver | null = null;
  #committedRadio: HTMLElement | null = null;
  #connected = false;
  #lastOrder: HTMLElement[] = [];
  #focusedRadio: HTMLElement | null = null;
  #pendingFocusIndex: number | null = null;
  #preferChecked = false;

  /**
   * Normalizes authored selection, establishes the APG Tab entry point, and
   * reflects derived form state without reporting a user edit.
   */
  override connect(): void {
    const currentRadios = new Set(this.radioTargets);
    for (const radio of this.#managedRadios) {
      if (!currentRadios.has(radio)) this.#releaseRadio(radio);
    }
    for (const radio of this.radioTargets) this.#reconcileHost(radio, false);
    this.#normalizeSelection();
    this.#ensureTabStop(true);
    this.#reflectField(this.#selectedRadio, { silent: true });
    this.#committedRadio = this.#selectedRadio ?? null;
    this.#lastOrder = this.#managedTargets;

    this.element.addEventListener("click", this.#onClickCapture, true);
    this.element.addEventListener("keydown", this.#onKeydownCapture, true);
    this.element.addEventListener("click", this.#onClick);
    this.element.addEventListener("keydown", this.#onKeydown);
    this.element.addEventListener("focusin", this.#onFocusin);
    this.element.addEventListener("focusout", this.#onFocusout);
    this.#connected = true;
    this.#preferChecked = false;
    this.#internalCheckedValues.clear();
    this.#internalTabindexValues.clear();
    this.#reconcile.activate();
    this.#observeMutations();
  }

  /** Releases every listener, observer, and queued pass while retaining live DOM state. */
  override disconnect(): void {
    this.#connected = false;
    this.#reconcile.cancel();
    this.element.removeEventListener("click", this.#onClickCapture, true);
    this.element.removeEventListener("keydown", this.#onKeydownCapture, true);
    this.element.removeEventListener("click", this.#onClick);
    this.element.removeEventListener("keydown", this.#onKeydown);
    this.element.removeEventListener("focusin", this.#onFocusin);
    this.element.removeEventListener("focusout", this.#onFocusout);
    this.#observer?.disconnect();
    this.#observer = null;
    this.#internalCheckedValues.clear();
    this.#internalTabindexValues.clear();
    this.#focusedRadio = null;
    this.#pendingFocusIndex = null;
    this.#committedRadio = null;
    this.#preferChecked = false;
  }

  /** Removes a newly connected radio from the Tab sequence before batch reconciliation. */
  radioTargetConnected(radio: HTMLElement): void {
    if (this.#connected === false) return;
    this.#reconcileHost(radio, true);
    this.#preferChecked = true;
    this.#reconcile.schedule();
  }

  /** Releases target-only attributes and repairs selection, form state, focus, and roving. */
  radioTargetDisconnected(radio: HTMLElement): void {
    if (!this.#connected) return;
    if (this.#focusedRadio === radio) {
      // A radio that arrived and left inside one batch is absent from the saved
      // order; `-1` then makes the search start from the top, which is where a
      // group with no position to return to belongs.
      this.#pendingFocusIndex = this.#lastOrder.indexOf(radio);
      this.#focusedRadio = null;
    }
    this.#releaseRadio(radio);
    this.#preferChecked = true;
    this.#reconcile.schedule();
  }

  /** Reflects the current selection into a field added or replaced at runtime. */
  fieldTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Reconciles after a field target is removed from a retained group. */
  fieldTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Selects the action's radio. Per-radio action wiring is optional. */
  select(event: Event): void {
    if (event.defaultPrevented || !this.#ownsEventTarget(event.target)) return;
    const radio = event.currentTarget as HTMLElement | null;
    if (!radio || !this.radioTargets.includes(radio)) return;
    this.#handledEvents.add(event);
    this.#selectRadio(radio, { focus: false });
  }

  /** Applies the APG key map to the action's radio. Per-radio action wiring is optional. */
  onKeydown(event: KeyboardEvent): void {
    const radio = event.currentTarget as HTMLElement | null;
    if (!radio || !this.radioTargets.includes(radio)) return;
    this.#handleKeydown(event, radio);
  }

  /** Blocks disabled pointer activation before per-radio and consumer handlers run. */
  readonly #onClickCapture = (event: MouseEvent): void => {
    const radio = this.#radioForEventTarget(event.target);
    if (!radio || !this.#isSupportedHost(radio) || !this.#isActivationDisabled(radio)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /** Blocks disabled activation and suppresses a button's non-APG Enter activation. */
  readonly #onKeydownCapture = (event: KeyboardEvent): void => {
    if (event.key !== " " && event.key !== "Enter") return;
    const radio = this.#radioForEventTarget(event.target);
    if (!radio || !this.#isSupportedHost(radio)) return;
    if (
      this.#isActivationDisabled(radio) ||
      (event.key === "Enter" && radio instanceof HTMLButtonElement)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  /** Delegated click path for static and runtime-added radios without actions. */
  readonly #onClick = (event: MouseEvent): void => {
    if (this.#handledEvents.delete(event) || event.defaultPrevented) return;
    const radio = this.#radioForEventTarget(event.target);
    if (radio) this.#selectRadio(radio, { focus: false });
  };

  /** Delegated keydown path for static and runtime-added radios without actions. */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    const radio = this.#radioForEventTarget(event.target);
    if (radio) this.#handleKeydown(event, radio);
  };

  /** Keeps programmatic and pointer focus as the group's current roving position. */
  readonly #onFocusin = (event: FocusEvent): void => {
    const radio = this.#radioForEventTarget(event.target);
    if (!radio || !this.#isNavigable(radio)) return;
    this.#focusedRadio = radio;
    this.#setActive(radio);
  };

  /** Distinguishes ordinary focus departure from focus lost because its radio was removed. */
  readonly #onFocusout = (event: FocusEvent): void => {
    const radio = this.#radioForEventTarget(event.target);
    if (!radio) return;
    queueMicrotask(() => {
      if (!this.#connected || this.#focusedRadio !== radio || !radio.isConnected) return;
      const active = document.activeElement;
      if (!(active instanceof Node) || !radio.contains(active)) this.#focusedRadio = null;
    });
  };

  /** Applies navigation and Space activation to one supported radio. */
  #handleKeydown(event: KeyboardEvent, radio: HTMLElement): void {
    if (event.defaultPrevented || !this.#isSupportedHost(radio)) return;
    if (event.isComposing || isReservedArrowChord(event)) return;
    if ((event.key === "Home" || event.key === "End") && hasModifier(event)) return;

    if (event.key === " ") {
      if (this.#isActivationDisabled(radio)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (radio instanceof HTMLButtonElement) {
        if (event.repeat) event.preventDefault();
        return;
      }
      event.preventDefault();
      if (!event.repeat) this.#selectRadio(radio, { focus: true });
      return;
    }

    const items = this.#managedTargets;
    const current = items.indexOf(radio);
    const step = logicalArrowStep(event.key, this.element);
    let destination: HTMLElement | undefined;
    if (step !== 0) {
      destination = this.#nextNavigable(current, step);
    } else if (event.key === "Home") {
      destination = this.#navigableRadios[0];
    } else if (event.key === "End") {
      const navigable = this.#navigableRadios;
      destination = navigable[navigable.length - 1];
    } else {
      return;
    }

    event.preventDefault();
    if (!destination) return;
    if (this.#isActivationDisabled(destination)) this.#setActive(destination, true);
    else this.#selectRadio(destination, { focus: true });
  }

  /** Applies one user selection and emits only when selected identity changes. */
  #selectRadio(radio: HTMLElement, { focus }: { focus: boolean }): void {
    if (!this.#isSupportedHost(radio) || this.#isActivationDisabled(radio)) return;
    const previous = this.#selectedRadio;
    const changed = previous !== radio;
    if (changed) {
      for (const item of this.#managedTargets) this.#setChecked(item, item === radio);
    }
    this.#setActive(radio, focus);
    this.#reflectField(radio, { silent: !changed });
    this.#committedRadio = radio;
    if (changed) {
      this.dispatch("change", { detail: { value: this.#radioValue(radio), radio } });
    }
  }

  /** Reconciles target ownership, selection, roving, focus continuity, and form state. */
  #reconcileDom(): void {
    const observer = this.#observer;
    observer?.disconnect();

    for (const radio of this.radioTargets) this.#reconcileHost(radio, true);
    this.#normalizeSelection();

    const pendingFocusIndex = this.#pendingFocusIndex;
    this.#pendingFocusIndex = null;
    if (pendingFocusIndex !== null) {
      const destination = this.#nearestNavigable(pendingFocusIndex);
      this.#setActive(destination, destination !== null);
    } else {
      this.#ensureTabStop(this.#preferChecked);
    }
    this.#reflectField(this.#selectedRadio, { silent: true });
    this.#lastOrder = this.#managedTargets;
    this.#preferChecked = false;
    this.#internalCheckedValues.clear();
    this.#internalTabindexValues.clear();

    if (this.#connected && observer) this.#observeWith(observer);
    this.#reportReconciledSelection();
  }

  /**
   * Announces a selection this pass decided rather than the user. Dispatched after
   * observation resumes so a consumer's own DOM edits are seen by the next pass.
   */
  #reportReconciledSelection(): void {
    const settled = this.#selectedRadio ?? null;
    if (settled === this.#committedRadio) return;
    this.#committedRadio = settled;
    this.dispatch("reconcile", {
      detail: { value: settled ? this.#radioValue(settled) : "", radio: settled },
    });
  }

  /** Begins or ends ownership according to a radio's current host semantics. */
  #reconcileHost(radio: HTMLElement, dropFromTabSequence: boolean): void {
    if (!this.#isSupportedHost(radio)) {
      this.#releaseRadio(radio);
      return;
    }
    if (!this.#managedRadios.has(radio)) {
      this.#managedRadios.add(radio);
      this.#originalTabindex.set(radio, radio.getAttribute("tabindex"));
      if (dropFromTabSequence) this.#writeTabindex(radio, -1);
    }
    this.#normalizeChecked(radio);
  }

  /** Restores only defaults owned while an element belonged to this group. */
  #releaseRadio(radio: HTMLElement): void {
    this.#managedRadios.delete(radio);
    const original = this.#originalTabindex.get(radio);
    if (original === null) {
      this.#markInternal(this.#internalTabindexValues, radio, null);
      radio.removeAttribute("tabindex");
    } else if (original !== undefined) {
      this.#markInternal(this.#internalTabindexValues, radio, original);
      radio.setAttribute("tabindex", original);
    }
    this.#originalTabindex.delete(radio);
    if (this.#ownedChecked.delete(radio)) {
      this.#markInternal(this.#internalCheckedValues, radio, null);
      radio.removeAttribute("aria-checked");
    }
  }

  /** Supplies a missing checked state and normalizes invalid ARIA tokens. */
  #normalizeChecked(radio: HTMLElement): void {
    const value = radio.getAttribute("aria-checked");
    if (value === null) {
      this.#ownedChecked.add(radio);
      this.#setChecked(radio, false);
    } else if (value !== "true" && value !== "false") {
      this.#setChecked(radio, false);
    }
  }

  /** Makes the first DOM-ordered checked radio the sole checked radio. */
  #normalizeSelection(): void {
    let found = false;
    for (const radio of this.#managedTargets) {
      this.#normalizeChecked(radio);
      if (!this.#isChecked(radio)) continue;
      if (!found) found = true;
      else this.#setChecked(radio, false);
    }
  }

  /** Keeps one navigable Tab stop, preferring checked state when selection changed externally. */
  #ensureTabStop(preferChecked: boolean): void {
    const navigable = this.#navigableRadios;
    let active: HTMLElement | undefined;
    if (!preferChecked) {
      const current = this.#managedTargets.filter(
        (radio) => radio.tabIndex === 0 && this.#isNavigable(radio),
      );
      if (current.length === 1) active = current[0];
    }
    const selected = this.#selectedRadio;
    if (!active && selected && this.#isNavigable(selected)) active = selected;
    active ??= navigable[0];
    this.#setActive(active ?? null);
  }

  /**
   * The surviving navigable radio closest to a position in the order captured
   * before the removal: the first one at or after it, else the last one before it.
   * The saved position and this search read the same population, so a `hidden` or
   * natively disabled sibling never shifts the destination past its neighbor.
   */
  #nearestNavigable(index: number): HTMLElement | null {
    const navigable = new Set(this.#navigableRadios);
    for (let i = index; i < this.#lastOrder.length; i++) {
      const radio = this.#lastOrder[i];
      if (radio && navigable.has(radio)) return radio;
    }
    for (let i = index - 1; i >= 0; i--) {
      const radio = this.#lastOrder[i];
      if (radio && navigable.has(radio)) return radio;
    }
    // Only radios added in the same batch survive; fall back to document order.
    return this.#navigableRadios[0] ?? null;
  }

  /** Moves through full DOM order until a navigable radio is found. */
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
  #setActive(radio: HTMLElement | null, focus = false): void {
    const items = this.#managedTargets;
    const index = items.indexOf(radio as HTMLElement);
    this.#roving.setActive(index, { focus });
    for (const item of items) {
      this.#markInternal(this.#internalTabindexValues, item, item.getAttribute("tabindex"));
    }
  }

  /** Finds this group's radio containing an event target, excluding nested groups. */
  #radioForEventTarget(target: EventTarget | null): HTMLElement | undefined {
    if (!this.#ownsEventTarget(target)) return undefined;
    const node = target as Element;
    return this.radioTargets.find((radio) => radio === node || radio.contains(node));
  }

  /** Whether the closest Radio Group scope around a target is this instance. */
  #ownsEventTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      target.closest('[data-controller~="stimeo--radio-group"]') === this.element
    );
  }

  /** Hosts whose activation model can be owned without conflicting native behavior. */
  #isSupportedHost(radio: HTMLElement): boolean {
    if (radio instanceof HTMLButtonElement) return radio.type === "button";
    return !isInteractiveHost(radio);
  }

  /** Radios eligible for roving focus; ARIA-disabled deliberately remains eligible. */
  #isNavigable(radio: HTMLElement): boolean {
    if (!this.#isSupportedHost(radio) || this.#isHidden(radio)) return false;
    if (!(radio instanceof HTMLButtonElement)) return true;
    return !radio.disabled && !inheritsFieldsetDisabled(radio);
  }

  /** Whether hidden applies on the path from a radio up to the group root. */
  #isHidden(radio: HTMLElement): boolean {
    let current: HTMLElement | null = radio;
    while (current && current !== this.element) {
      if (current.hasAttribute("hidden")) return true;
      current = current.parentElement;
    }
    return false;
  }

  /** Whether ARIA, visibility, or native HTML semantics suppress selection. */
  #isActivationDisabled(radio: HTMLElement): boolean {
    if (!this.#isNavigable(radio)) return true;
    let current: HTMLElement | null = radio;
    while (current) {
      if (current.getAttribute("aria-disabled") === "true") return true;
      current = current.parentElement;
    }
    return false;
  }

  /** Distinguishes external retained-element changes from this controller's own writes. */
  #handleMutationRecords(records: MutationRecord[]): void {
    let external = false;
    for (const record of records) {
      const target = record.target as HTMLElement;
      const attribute = record.attributeName;
      if (attribute === "aria-checked") {
        const value = target.getAttribute(attribute);
        if (this.#matchesInternal(this.#internalCheckedValues, target, value)) continue;
        this.#ownedChecked.delete(target);
        this.#preferChecked = true;
        external = true;
      } else if (attribute === "tabindex") {
        const value = target.getAttribute(attribute);
        if (this.#matchesInternal(this.#internalTabindexValues, target, value)) continue;
        if (this.#managedRadios.has(target)) this.#originalTabindex.set(target, value);
        external = true;
      } else {
        external = true;
      }
    }
    this.#internalCheckedValues.clear();
    this.#internalTabindexValues.clear();
    if (external) this.#reconcile.schedule();
  }

  /** Records an attribute write this pass made, keeping one claim per record it will produce. */
  #markInternal(
    values: Map<HTMLElement, InternalWrite>,
    target: HTMLElement,
    value: string | null,
  ): void {
    const pending = values.get(target);
    if (pending) {
      pending.value = value;
      pending.count += 1;
    } else {
      values.set(target, { value, count: 1 });
    }
  }

  /** Consumes one claim on a record whose value this pass wrote. */
  #matchesInternal(
    values: Map<HTMLElement, InternalWrite>,
    target: HTMLElement,
    value: string | null,
  ): boolean {
    const pending = values.get(target);
    if (!pending || pending.value !== value) return false;
    pending.count -= 1;
    if (pending.count === 0) values.delete(target);
    return true;
  }

  /** Watches target membership, retained state/hosts, form state, and fieldset ancestry. */
  #observeMutations(): void {
    const observer = new MutationObserver((records) => this.#handleMutationRecords(records));
    this.#observer = observer;
    this.#observeWith(observer);
  }

  /** Registers root and ancestor observation on one observer instance. */
  #observeWith(observer: MutationObserver): void {
    observer.observe(this.element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
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
    return this.radioTargets.filter((radio) => this.#managedRadios.has(radio));
  }

  /** Managed radios eligible for the roving Tab stop. */
  get #navigableRadios(): HTMLElement[] {
    return this.#managedTargets.filter((radio) => this.#isNavigable(radio));
  }

  /** The currently checked managed radio, if any. */
  get #selectedRadio(): HTMLElement | undefined {
    return this.#managedTargets.find((radio) => this.#isChecked(radio));
  }

  /** Whether a radio is currently checked. */
  #isChecked(radio: HTMLElement): boolean {
    return radio.getAttribute("aria-checked") === "true";
  }

  /** Reflects checked state while distinguishing controller writes from authored morphs. */
  #setChecked(radio: HTMLElement, checked: boolean): void {
    const value = checked ? "true" : "false";
    if (radio.getAttribute("aria-checked") === value) return;
    this.#markInternal(this.#internalCheckedValues, radio, value);
    radio.setAttribute("aria-checked", value);
  }

  /** Writes a roving value before the radio is visible to the shared primitive. */
  #writeTabindex(radio: HTMLElement, value: number): void {
    const serialized = String(value);
    this.#markInternal(this.#internalTabindexValues, radio, serialized);
    radio.tabIndex = value;
  }

  /** Mirrors the selected value or the empty state to the optional hidden field. */
  #reflectField(
    radio: HTMLElement | undefined,
    { silent = false }: { silent?: boolean } = {},
  ): void {
    if (!this.hasFieldTarget) return;
    const value = radio ? this.#radioValue(radio) : "";
    if (this.fieldTarget.value === value) return;
    this.fieldTarget.value = value;
    if (!silent) this.fieldTarget.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** A radio's submitted value (`data-value`, defaulting to empty). */
  #radioValue(radio: HTMLElement): string {
    return radio.getAttribute("data-value") ?? "";
  }
}
