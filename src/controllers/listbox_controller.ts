import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { scrollOptionIntoView } from "../utils/option_scroll";
import { findTypeaheadMatch, isTypeaheadKey, Typeahead } from "../utils/typeahead";

/**
 * Headless, accessible select-only listbox behavior.
 *
 * Markup contract (identifier: `stimeo--listbox`):
 *   <div data-controller="stimeo--listbox">
 *     <span id="lb-label">Favorite fruit</span>
 *     <button type="button" role="combobox" aria-haspopup="listbox"
 *             aria-expanded="false" aria-controls="lb-list"
 *             aria-labelledby="lb-label lb-value"
 *             data-stimeo--listbox-target="trigger"
 *             data-action="click->stimeo--listbox#toggle
 *                          keydown->stimeo--listbox#onTriggerKeydown">
 *       <span id="lb-value" data-stimeo--listbox-target="value">Choose…</span>
 *     </button>
 *     <ul id="lb-list" role="listbox" aria-label="Options" hidden
 *         data-stimeo--listbox-target="list">
 *       <li id="opt-1" role="option" aria-selected="false" data-value="1"
 *           data-stimeo--listbox-target="option"
 *           data-action="click->stimeo--listbox#select">Option 1</li>
 *       <!-- more options -->
 *     </ul>
 *     <input type="hidden" data-stimeo--listbox-target="field" />
 *   </div>
 *
 * Implements the WAI-ARIA APG **Listbox** pattern in its collapsed
 * (Select-Only Combobox) form. Focus stays on the trigger; the active option is
 * tracked with `aria-activedescendant` rather than by moving DOM focus. For a
 * text-filtered popup use {@link ComboboxController | Combobox}; for multiple
 * selection use Multi-Select.
 *
 * `change` dispatches `{ value: string, option: HTMLElement }`.
 *
 * @remarks
 * Behavior only. Static placement is the consumer's CSS; dynamic placement is
 * delegated to the opt-in `stimeo-ui/positioning` module. The look is keyed off
 * `aria-selected` / `data-active`. Because `role="combobox"` is not named by its
 * contents, give the trigger an accessible name via `aria-labelledby` (a visible
 * label plus the value span) or `aria-label`.
 *
 * Behavior provided:
 * - Open/close the list, syncing `aria-expanded` and the list's `hidden`.
 * - `ArrowDown`/`ArrowUp` (wrapping), `Home`/`End`, and printable-character
 *   typeahead move the active option; opening picks the selected option (else
 *   the first).
 * - Single selection syncs `aria-selected`, reflects the label into the trigger
 *   value and the field's value, and dispatches `stimeo--listbox:change` plus a
 *   native bubbling `change` on the field when its value actually changed.
 *   Making the field a validatable mirror (`<input type="text" hidden required>`
 *   instead of `type="hidden"`) lets `stimeo--form-validation` enforce native
 *   constraints on the committed value with no extra JavaScript.
 * - `Enter`/`Space` select and close; `Escape` and outside click / `Tab` close;
 *   closing via select/Escape returns focus to the trigger.
 */
export class ListboxController extends Controller<HTMLElement> {
  static override targets = ["trigger", "value", "list", "option", "field"];
  static actions = ["close", "onTriggerKeydown", "open", "select", "toggle"] as const;
  static events = ["change"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly valueTarget: HTMLElement;
  declare readonly listTarget: HTMLElement;
  declare readonly optionTargets: HTMLElement[];
  declare readonly fieldTarget: HTMLInputElement;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasValueTarget: boolean;
  declare readonly hasListTarget: boolean;
  declare readonly hasFieldTarget: boolean;

  /** Stable ID of the active option; DOM targets are resolved afresh before use. */
  #activeId: string | null = null;
  /** Target ID order captured while an option is active, used only for removal fallback. */
  #activeOrder: string[] = [];
  #connected = false;
  /** Collapses one mutation batch of target callbacks into a single pass. */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileActive());
  /** Accumulated typeahead query and its idle-reset timer. */
  readonly #typeahead = new Typeahead();

  /** Establishes the ARIA baseline, starts closed, and listens for outside clicks. */
  override connect(): void {
    this.#normalizeSelection();
    this.close();
    document.addEventListener("click", this.#onOutsideClick, true);
    this.#connected = true;
    this.#reconcile.activate();
  }

  /**
   * Establishes an inactive baseline for a late option, re-resolves active
   * identity, and re-applies the selection baseline.
   */
  optionTargetConnected(option: HTMLElement): void {
    option.removeAttribute("data-active");
    if (!this.#connected) return;
    this.#normalizeSelection();
    this.#queueOptionReconciliation();
  }

  /** Removes controller-owned active state and reconciles the surviving targets. */
  optionTargetDisconnected(option: HTMLElement): void {
    option.removeAttribute("data-active");
    if (this.#connected) this.#queueOptionReconciliation();
  }

  /**
   * Brings the authored DOM to the shape the APG requires, and derives the state
   * that follows from the initial selection.
   *
   * Three things happen, and only these three — which option is chosen is the
   * author's, and is never changed:
   *
   * 1. Every option gets an explicit value. An absent `aria-selected` means "not
   *    selectable" in ARIA, so a forgotten attribute hides a selectable option
   *    from assistive technology.
   * 2. At most one stays `true`. The first in DOM order wins, since that is the
   *    only deterministic reading of "which one did the author mean".
   * 3. The trigger label and the hidden field are derived from that selection.
   *    Without this the widget announces a choice it does not submit: the popup
   *    says "Banana", the trigger still says "Choose…", and the form posts "".
   *
   * No `change` fires — nothing changed, this is the initial state being told
   * properly. The scan is the `option` target set: a `role="option"` without the
   * target is outside the contract and is neither counted nor written.
   */
  #normalizeSelection(): void {
    const options = this.optionTargets;
    const selected = options.find((option) => option.getAttribute("aria-selected") === "true");
    for (const option of options) {
      option.setAttribute("aria-selected", option === selected ? "true" : "false");
    }
    if (selected) this.#applySelection(selected);
  }

  /** Removes the document listener and clears the typeahead timer. */
  override disconnect(): void {
    this.#connected = false;
    this.#reconcile.cancel();
    document.removeEventListener("click", this.#onOutsideClick, true);
    // The typeahead keeps its idle reset in a `SafeTimeout` of its own, so this is
    // the only teardown that reaches it — there is no controller-level registry to
    // fall back on. Every timer this controller can schedule lives in there.
    this.#typeahead.reset();
  }

  /**
   * Toggles the list on a real mouse click. Keyboard activation of the
   * `<button>` also fires a click (`detail === 0`); the keydown handler already
   * drives that, so the synthetic click is ignored to avoid double-toggling.
   */
  toggle(event: MouseEvent): void {
    if (event.detail === 0) return;
    if (this.#isClosed) {
      this.open();
    } else {
      this.close();
    }
  }

  /** Yields claimed keys; otherwise routes the APG select-only keyboard model. */
  onTriggerKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    if (!this.#isClosed) this.#reconcileActive();
    const options = this.optionTargets;
    const length = options.length;
    const activeIndex = this.#findActiveIndex(options);
    if (this.#isClosed) {
      switch (event.key) {
        case "Enter":
        case " ":
        case "ArrowDown":
        case "ArrowUp":
          event.preventDefault();
          this.open();
          break;
        default:
          break;
      }
      return;
    }

    // With no options, only Escape/Tab are meaningful; ignore navigation and
    // typeahead so the active index can never become NaN (`% 0`).
    if (length === 0 && event.key !== "Escape" && event.key !== "Tab") {
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.#setActive(activeIndex < 0 ? 0 : (activeIndex + 1) % length);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.#setActive(activeIndex < 0 ? length - 1 : (activeIndex - 1 + length) % length);
        break;
      case "Home":
        event.preventDefault();
        this.#setActive(0);
        break;
      case "End":
        event.preventDefault();
        this.#setActive(length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        this.#commitActive();
        break;
      case "Escape":
        // The entry guard already yields a press another handler owned. A press
        // during IME composition never dismisses, keeping one rule across the
        // widgets (the trigger is a button, so composition does not start here).
        if (event.isComposing) break;
        event.preventDefault();
        this.close();
        this.triggerTarget.focus();
        break;
      case "Tab":
        // Let focus leave naturally; just don't keep a stale popup open.
        this.close();
        break;
      default:
        if (isTypeaheadKey(event)) {
          event.preventDefault();
          this.#typeaheadTo(options, activeIndex, event.key);
        }
        break;
    }
  }

  /** Selects the clicked option and closes, returning focus to the trigger. */
  select(event: Event): void {
    const option = (event.currentTarget as HTMLElement).closest<HTMLElement>('[role="option"]');
    if (!option || !this.optionTargets.includes(option)) return;
    this.#selectOption(option);
    this.close();
    this.triggerTarget.focus();
  }

  /** Opens the list and activates the selected option (else the first). */
  open(): void {
    if (!this.hasListTarget) return;
    this.listTarget.hidden = false;
    this.triggerTarget.setAttribute("aria-expanded", "true");
    if (this.optionTargets.length === 0) {
      // An empty listbox has nothing to activate; leave activedescendant cleared.
      this.#setActive(-1);
      return;
    }
    const selected = this.optionTargets.findIndex(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    this.#setActive(selected === -1 ? 0 : selected);
  }

  /** Closes the list, clears the active option, and resets the typeahead buffer. */
  close(): void {
    if (!this.hasListTarget) return;
    this.listTarget.hidden = true;
    this.triggerTarget.setAttribute("aria-expanded", "false");
    this.#setActive(-1);
    this.#typeahead.reset();
  }

  /** Commits the active option (keyboard) and closes, returning focus. */
  #commitActive(): void {
    this.#reconcileActive();
    const options = this.optionTargets;
    const activeIndex = this.#findActiveIndex(options);
    const option = activeIndex < 0 ? undefined : options[activeIndex];
    if (option) this.#selectOption(option);
    this.close();
    this.triggerTarget.focus();
  }

  /** Applies selection: `aria-selected`, trigger label, hidden field, `change`. */
  #selectOption(option: HTMLElement): void {
    const { value, fieldChanged } = this.#applySelection(option);
    if (fieldChanged) {
      // A native bubbling change (matching <select> semantics: only on an actual
      // value change) so form-level behaviors — validation re-checks, auto-submit
      // — hear the commit without knowing this widget.
      this.fieldTarget.dispatchEvent(new Event("change", { bubbles: true }));
    }
    this.dispatch("change", { detail: { value, option } });
  }

  /**
   * Writes `option` into `aria-selected`, the trigger label and the hidden field.
   * Emits nothing — {@link #normalizeSelection} reuses this at connect, where the
   * state is being described rather than changed.
   */
  #applySelection(option: HTMLElement): { value: string; fieldChanged: boolean } {
    for (const candidate of this.optionTargets) {
      candidate.setAttribute("aria-selected", candidate === option ? "true" : "false");
    }
    const label = (option.textContent ?? "").trim();
    const value = option.dataset.value ?? label;
    if (this.hasValueTarget) this.valueTarget.textContent = label;
    const fieldChanged = this.hasFieldTarget && this.fieldTarget.value !== value;
    if (fieldChanged) this.fieldTarget.value = value;
    return { value, fieldChanged };
  }

  /**
   * Marks the option at `index` active via `data-active` and the trigger's
   * `aria-activedescendant`. Pass `-1` to clear it (the attribute is removed, not
   * set to empty, per the APG).
   */
  #setActive(index: number): void {
    const options = this.optionTargets;
    const active = index < 0 ? null : (options[index] ?? null);
    // Only the options whose marker actually changes are written, so a held arrow
    // key costs two attribute writes rather than one per option. The whole set is
    // still read: that is what makes a stray marker — one a morph left behind on
    // an element that never re-connected as a target — heal on the next move.
    for (const option of options) {
      const marked = option.hasAttribute("data-active");
      if (option === active) {
        if (!marked) option.setAttribute("data-active", "");
      } else if (marked) {
        option.removeAttribute("data-active");
      }
    }
    if (active?.id) {
      this.#activeId = active.id;
      this.triggerTarget.setAttribute("aria-activedescendant", active.id);
    } else {
      this.#activeId = null;
      this.triggerTarget.removeAttribute("aria-activedescendant");
    }
    this.#activeOrder = active ? options.map((option) => option.id).filter(Boolean) : [];
    // Virtual focus never triggers the browser's native focus-scrolling, so a
    // scrollable list must follow the active option itself (list-only scroll).
    if (active && this.hasListTarget) scrollOptionIntoView(this.listTarget, active);
  }

  /** Resolves active state against the current target collection. */
  #reconcileActive(): void {
    if (!this.hasTriggerTarget || this.#isClosed) {
      if (this.hasTriggerTarget) this.#setActive(-1);
      return;
    }

    const options = this.optionTargets;
    const currentIndex = this.#findActiveIndex(options);
    if (currentIndex >= 0) {
      const active = options[currentIndex] ?? null;
      const marked = options.filter((option) => option.hasAttribute("data-active"));
      const stateMatches =
        this.#activeId === (active?.id || null) &&
        marked.length === 1 &&
        marked[0] === active &&
        this.triggerTarget.getAttribute("aria-activedescendant") === (active?.id || null);

      if (stateMatches) {
        // Keep the deletion fallback snapshot current without re-scrolling the
        // already-active option before every keyboard command.
        this.#activeOrder = options.map((option) => option.id).filter(Boolean);
      } else {
        this.#setActive(currentIndex);
      }
      return;
    }

    const activeId = this.triggerTarget.getAttribute("aria-activedescendant") ?? this.#activeId;
    this.#setActive(activeId ? this.#findFallbackIndex(options, activeId) : -1);
  }

  /** Finds the live target carrying the stable ID, or the active marker for an ID-less option. */
  #findActiveIndex(options: readonly HTMLElement[]): number {
    const activeId =
      (this.hasTriggerTarget ? this.triggerTarget.getAttribute("aria-activedescendant") : null) ??
      this.#activeId;
    if (activeId) return options.findIndex((option) => option.id === activeId);
    return options.findIndex((option) => option.hasAttribute("data-active"));
  }

  /** Chooses a surviving former successor, then a former predecessor. */
  #findFallbackIndex(options: readonly HTMLElement[], activeId: string): number {
    const oldIndex = this.#activeOrder.indexOf(activeId);
    if (oldIndex < 0) return -1;
    const indexesById = new Map(options.map((option, index) => [option.id, index]));
    for (let index = oldIndex + 1; index < this.#activeOrder.length; index += 1) {
      const fallback = indexesById.get(this.#activeOrder[index] ?? "");
      if (fallback !== undefined) return fallback;
    }
    for (let index = oldIndex - 1; index >= 0; index -= 1) {
      const fallback = indexesById.get(this.#activeOrder[index] ?? "");
      if (fallback !== undefined) return fallback;
    }
    return -1;
  }

  /** Coalesces all target callbacks from one MutationObserver batch. */
  #queueOptionReconciliation(): void {
    this.#reconcile.schedule();
  }

  /**
   * Advances the typeahead query and activates the next matching option.
   *
   * The search resumes just after the active option so repeating a character
   * cycles through the options starting with it, rather than re-activating the
   * same first match on every press.
   */
  #typeaheadTo(options: HTMLElement[], activeIndex: number, char: string): void {
    const index = findTypeaheadMatch(options, activeIndex, this.#typeahead.push(char));
    if (index !== -1) this.#setActive(index);
  }

  /** Closes on an outside click before an inside handler can detach its target. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (!this.#isClosed && !this.element.contains(event.target as Node)) this.close();
  };

  /** Whether the list is currently hidden. */
  get #isClosed(): boolean {
    return !this.hasListTarget || this.listTarget.hidden !== false;
  }
}
