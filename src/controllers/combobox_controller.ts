import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible combobox behavior (list autocomplete).
 *
 * Markup contract (identifier: `stimeo--combobox`):
 *   <div data-controller="stimeo--combobox">
 *     <input type="text" role="combobox" aria-expanded="false"
 *            aria-autocomplete="list" aria-controls="listbox"
 *            data-stimeo--combobox-target="input"
 *            data-action="input->stimeo--combobox#filter
 *                         keydown->stimeo--combobox#onKeydown
 *                         focus->stimeo--combobox#open
 *                         click->stimeo--combobox#open" />
 *     <ul id="listbox" role="listbox" data-stimeo--combobox-target="list" hidden>
 *       <li role="option" id="opt-apple" data-value="apple"
 *           data-stimeo--combobox-target="option"
 *           data-action="click->stimeo--combobox#selectByClick">Apple</li>
 *       <!-- more options -->
 *     </ul>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Combobox** pattern with a listbox popup and
 * list-autocomplete. Focus stays in the input; the active option is tracked with
 * `aria-activedescendant` rather than by moving DOM focus.
 *
 * @remarks
 * Behavior only. Options are authored in the DOM; the controller filters them by
 * toggling each option's `hidden` attribute (case-insensitive substring match on
 * its text). The consumer owns styling, typically keyed off `[aria-selected]`.
 * When an open listbox has no matching options, the root element gets
 * `data-stimeo--combobox-empty` so the consumer can style the empty state (hide
 * the list, show a "no results" node, …) — the library imposes no visuals.
 *
 * Behavior provided:
 * - Typing filters the options and opens the listbox.
 * - Focusing or clicking the input opens the listbox, re-filtered against the
 *   current value (so re-opening with a non-matching value keeps the empty state).
 * - `ArrowDown`/`ArrowUp` move the active option (wrapping); `Enter` selects it;
 *   `Escape` closes the listbox; `Home`/`End` jump to the first/last visible
 *   option.
 * - Selecting an option fills the input (with the option's `data-value` if set,
 *   otherwise its text) and closes the listbox.
 * - A click outside the combobox closes the listbox.
 */
export class ComboboxController extends Controller<HTMLElement> {
  static override targets = ["input", "list", "option"];
  static actions = ["close", "filter", "onKeydown", "open", "selectByClick"] as const;
  static events = ["selected"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly listTarget: HTMLElement;
  declare readonly optionTargets: HTMLElement[];
  declare readonly hasInputTarget: boolean;
  declare readonly hasListTarget: boolean;

  /** Index into the *visible* options of the active option, or -1 if none. */
  #activeIndex = -1;
  /**
   * Suppresses {@link open} for the duration of the programmatic re-focus in
   * `#select`, so committing a value (which returns focus to the input)
   * does not immediately re-open the listbox via a `focus`-bound action.
   */
  #suppressOpen = false;

  /** Starts closed with no active option and registers the outside-click listener. */
  override connect(): void {
    this.close();
    document.addEventListener("click", this.#onOutsideClick);
  }

  /** Removes the document-level listener registered in {@link connect}. */
  override disconnect(): void {
    document.removeEventListener("click", this.#onOutsideClick);
  }

  /** Filters options by the current input value and opens the listbox. */
  filter(): void {
    this.open();
  }

  /**
   * Opens the listbox, re-filtering the options against the current input value
   * so the visible options and empty state always match what is typed (e.g.
   * re-opening with a stale non-matching value still surfaces the empty state).
   */
  open(): void {
    if (!this.hasListTarget || this.#suppressOpen) return;
    this.#applyFilter();
    this.listTarget.hidden = false;
    this.inputTarget.setAttribute("aria-expanded", "true");
    this.#setActive(-1);
    this.#reflectEmptyState();
  }

  /**
   * Hides options that don't match the current input value (case-insensitive
   * substring). An empty query shows every option. Does not change open state.
   */
  #applyFilter(): void {
    const query = this.inputTarget.value.trim().toLowerCase();
    for (const option of this.optionTargets) {
      const text = (option.textContent ?? "").trim().toLowerCase();
      option.hidden = query.length > 0 && !text.includes(query);
    }
  }

  /** Closes the listbox, clears the active option, and updates ARIA state. */
  close(): void {
    if (!this.hasListTarget) return;
    this.listTarget.hidden = true;
    this.inputTarget.setAttribute("aria-expanded", "false");
    this.#setActive(-1);
    this.element.removeAttribute("data-stimeo--combobox-empty");
  }

  /** Routes keyboard interaction per the APG combobox model. */
  onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        // open() re-filters, so read the visible set afterwards.
        if (this.#isClosed) this.open();
        const visible = this.#visibleOptions();
        if (visible.length > 0) {
          const next = this.#activeIndex === -1 ? 0 : (this.#activeIndex + 1) % visible.length;
          this.#setActive(next);
        }
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        if (this.#isClosed) this.open();
        const visible = this.#visibleOptions();
        if (visible.length > 0) {
          // From the input (no active option) ArrowUp jumps to the last option,
          // per the APG; otherwise it wraps backwards.
          const next =
            this.#activeIndex === -1
              ? visible.length - 1
              : (this.#activeIndex - 1 + visible.length) % visible.length;
          this.#setActive(next);
        }
        break;
      }
      case "Home":
        if (!this.#isClosed && this.#visibleOptions().length > 0) {
          event.preventDefault();
          this.#setActive(0);
        }
        break;
      case "End": {
        const visible = this.#visibleOptions();
        if (!this.#isClosed && visible.length > 0) {
          event.preventDefault();
          this.#setActive(visible.length - 1);
        }
        break;
      }
      case "Enter": {
        const visible = this.#visibleOptions();
        const active = this.#activeIndex === -1 ? undefined : visible[this.#activeIndex];
        if (active) {
          event.preventDefault();
          this.#select(active);
        }
        break;
      }
      case "Escape":
        event.preventDefault();
        this.close();
        break;
      case "Tab":
        // Let focus leave naturally, but don't keep a stale popup open.
        this.close();
        break;
      default:
        break;
    }
  }

  /**
   * Closes the listbox when a click lands outside the combobox. Mirrors the menu
   * button's outside-click behavior; clicks on an option are inside the element,
   * so `#select` (not this handler) closes the popup after committing.
   */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (!this.#isClosed && !this.element.contains(event.target as Node)) this.close();
  };

  /** Selects the clicked option. Bound via `data-action` (click). */
  selectByClick(event: Event): void {
    const option = (event.currentTarget as HTMLElement).closest<HTMLElement>('[role="option"]');
    if (option) this.#select(option);
  }

  /** Commits an option: fills the input, closes the listbox, notifies listeners. */
  #select(option: HTMLElement): void {
    const value = option.dataset.value ?? (option.textContent ?? "").trim();
    const changed = this.inputTarget.value !== value;
    this.inputTarget.value = value;
    this.close();
    // Returning focus to the input would re-trigger a `focus`-bound open(); guard
    // it so the listbox stays closed after a selection.
    this.#suppressOpen = true;
    this.inputTarget.focus();
    this.#suppressOpen = false;
    if (changed) {
      // A native bubbling `change` (matching <select>/listbox semantics: only on
      // an actual value change) so form-level behaviors — validation re-checks,
      // auto-submit — hear the commit without knowing this widget. Deliberately
      // NOT `input`: that is this combobox's own filter trigger and would reopen
      // the popup on every selection.
      this.inputTarget.dispatchEvent(new Event("change", { bubbles: true }));
    }
    this.dispatch("selected", { detail: { value } });
  }

  /**
   * Reflects whether the open listbox currently has zero matching options by
   * toggling `data-stimeo--combobox-empty` on the root element. Behavior only:
   * consumers decide how to present the empty state (hide the list, show a
   * "no results" node, etc.) via CSS keyed off this attribute.
   */
  #reflectEmptyState(): void {
    const empty = !this.#isClosed && this.#visibleOptions().length === 0;
    if (empty) {
      this.element.setAttribute("data-stimeo--combobox-empty", "");
    } else {
      this.element.removeAttribute("data-stimeo--combobox-empty");
    }
  }

  /**
   * Marks the visible option at `index` active via `aria-selected` and the
   * input's `aria-activedescendant`. Pass `-1` to clear the active option.
   */
  #setActive(index: number): void {
    this.#activeIndex = index;
    const visible = this.#visibleOptions();
    const active = index === -1 ? null : visible[index];
    // Clear aria-selected on every option (not just the visible ones) so a
    // previously-active option that became hidden by filtering doesn't keep a
    // stale selected state.
    for (const option of this.optionTargets) {
      option.setAttribute("aria-selected", option === active ? "true" : "false");
    }
    if (active?.id) {
      this.inputTarget.setAttribute("aria-activedescendant", active.id);
    } else {
      this.inputTarget.removeAttribute("aria-activedescendant");
    }
  }

  /** The options currently shown (not filtered out). */
  #visibleOptions(): HTMLElement[] {
    return this.optionTargets.filter((option) => !option.hidden);
  }

  /** Whether the listbox is currently hidden. */
  get #isClosed(): boolean {
    return !this.hasListTarget || this.listTarget.hidden !== false;
  }
}
