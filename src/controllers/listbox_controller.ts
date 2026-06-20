import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/** How long (ms) typed characters accumulate into one typeahead query. */
const TYPEAHEAD_TIMEOUT = 500;

/**
 * Headless, accessible select-only listbox behavior.
 *
 * Markup contract (identifier: `stimeo--listbox`):
 *   <div data-controller="stimeo--listbox">
 *     <span id="lb-label">Favorite fruit</span>
 *     <button type="button" role="combobox" aria-haspopup="listbox"
 *             aria-expanded="false" aria-controls="lb-list" aria-activedescendant=""
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

  /** Index of the active option, or -1 when none is active. */
  #activeIndex = -1;
  /** Accumulated typeahead query, reset after {@link TYPEAHEAD_TIMEOUT} ms. */
  #typeahead = "";
  #typeaheadTimer = 0;
  readonly #timers = new SafeTimeout();

  /** Starts closed and registers the outside-click listener. */
  override connect(): void {
    this.close();
    document.addEventListener("click", this.#onOutsideClick);
  }

  /** Removes the document listener and clears the typeahead timer. */
  override disconnect(): void {
    document.removeEventListener("click", this.#onOutsideClick);
    this.#timers.clearAll();
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

  /** Routes trigger keyboard interaction per the APG select-only model. */
  onTriggerKeydown(event: KeyboardEvent): void {
    const length = this.optionTargets.length;

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
        this.#setActive(this.#activeIndex < 0 ? 0 : (this.#activeIndex + 1) % length);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.#setActive(
          this.#activeIndex < 0 ? length - 1 : (this.#activeIndex - 1 + length) % length,
        );
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
        event.preventDefault();
        this.close();
        this.triggerTarget.focus();
        break;
      case "Tab":
        // Let focus leave naturally; just don't keep a stale popup open.
        this.close();
        break;
      default:
        if (this.#isPrintable(event)) {
          event.preventDefault();
          this.#typeaheadTo(event.key);
        }
        break;
    }
  }

  /** Selects the clicked option and closes, returning focus to the trigger. */
  select(event: Event): void {
    const option = (event.currentTarget as HTMLElement).closest<HTMLElement>('[role="option"]');
    if (!option) return;
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
    this.#resetTypeahead();
  }

  /** Commits the active option (keyboard) and closes, returning focus. */
  #commitActive(): void {
    const option = this.#activeIndex < 0 ? undefined : this.optionTargets[this.#activeIndex];
    if (option) this.#selectOption(option);
    this.close();
    this.triggerTarget.focus();
  }

  /** Applies selection: `aria-selected`, trigger label, hidden field, `change`. */
  #selectOption(option: HTMLElement): void {
    for (const candidate of this.optionTargets) {
      candidate.setAttribute("aria-selected", candidate === option ? "true" : "false");
    }
    const label = (option.textContent ?? "").trim();
    const value = option.dataset.value ?? label;
    if (this.hasValueTarget) this.valueTarget.textContent = label;
    if (this.hasFieldTarget && this.fieldTarget.value !== value) {
      this.fieldTarget.value = value;
      // A native bubbling change (matching <select> semantics: only on an actual
      // value change) so form-level behaviors — validation re-checks, auto-submit
      // — hear the commit without knowing this widget.
      this.fieldTarget.dispatchEvent(new Event("change", { bubbles: true }));
    }
    this.dispatch("change", { detail: { value, option } });
  }

  /**
   * Marks the option at `index` active via `data-active` and the trigger's
   * `aria-activedescendant`. Pass `-1` to clear it (the attribute is removed, not
   * set to empty, per the APG).
   */
  #setActive(index: number): void {
    this.#activeIndex = index;
    const active = index < 0 ? null : this.optionTargets[index];
    for (const option of this.optionTargets) {
      if (option === active) {
        option.setAttribute("data-active", "");
      } else {
        option.removeAttribute("data-active");
      }
    }
    if (active?.id) {
      this.triggerTarget.setAttribute("aria-activedescendant", active.id);
    } else {
      this.triggerTarget.removeAttribute("aria-activedescendant");
    }
  }

  /** Appends a character to the typeahead query and activates the first match. */
  #typeaheadTo(char: string): void {
    this.#timers.clear(this.#typeaheadTimer);
    this.#typeahead += char.toLowerCase();
    this.#typeaheadTimer = this.#timers.set(() => {
      this.#typeahead = "";
    }, TYPEAHEAD_TIMEOUT);
    const index = this.optionTargets.findIndex((option) =>
      (option.textContent ?? "").trim().toLowerCase().startsWith(this.#typeahead),
    );
    if (index !== -1) this.#setActive(index);
  }

  /** Clears the typeahead query and its pending reset timer. */
  #resetTypeahead(): void {
    this.#timers.clear(this.#typeaheadTimer);
    this.#typeahead = "";
  }

  /** Closes the list when a click lands outside the controller element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (!this.#isClosed && !this.element.contains(event.target as Node)) this.close();
  };

  /** Whether `event.key` is a single printable character (no modifier chord). */
  #isPrintable(event: KeyboardEvent): boolean {
    return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
  }

  /** Whether the list is currently hidden. */
  get #isClosed(): boolean {
    return !this.hasListTarget || this.listTarget.hidden !== false;
  }
}
