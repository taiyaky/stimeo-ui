import { Controller } from "@hotwired/stimulus";
import { ensureId } from "../utils/aria_ids";
import { RovingTabindex } from "../utils/roving_tabindex";

/**
 * Headless, accessible multi-select combobox with chips.
 *
 * Markup contract (identifier: `stimeo--multi-select`):
 *   <div data-controller="stimeo--multi-select">
 *     <ul data-stimeo--multi-select-target="tags" aria-label="Selected"></ul>
 *     <input type="text" role="combobox" aria-expanded="false"
 *            aria-autocomplete="list" aria-controls="ms-list" aria-activedescendant=""
 *            data-stimeo--multi-select-target="input"
 *            data-action="input->stimeo--multi-select#filter
 *                         keydown->stimeo--multi-select#onKeydown
 *                         focus->stimeo--multi-select#open" />
 *     <ul id="ms-list" role="listbox" aria-multiselectable="true" hidden
 *         data-stimeo--multi-select-target="list">
 *       <li id="ms-opt-1" role="option" aria-selected="false" data-value="apple"
 *           data-stimeo--multi-select-target="option"
 *           data-action="click->stimeo--multi-select#toggleOption">Apple</li>
 *     </ul>
 *     <span role="status" aria-live="polite" class="visually-hidden"
 *           data-stimeo--multi-select-target="status"></span>
 *     <template data-stimeo--multi-select-target="tagTemplate">…</template>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Combobox** pattern in its list-autocomplete,
 * multi-select form. Focus stays on the input; the active option is tracked with
 * `aria-activedescendant` and selection with `aria-selected`. Selected options are
 * mirrored as removable chips. For single selection use {@link ListboxController}
 * or Combobox; for free-text tags use {@link TagsInputController}.
 *
 * Behavior provided:
 * - Typing filters options by substring and opens the list; `ArrowDown`/`ArrowUp`
 *   (wrapping), `Home`/`End` move the active option; `Enter` toggles it (the list
 *   stays open); `Escape`/`Tab`/outside click close.
 * - Toggling syncs `aria-selected`, adds/removes a `Remove {label}` chip, mirrors
 *   the live region, and dispatches `stimeo--multi-select:change` with `values`;
 *   filtering dispatches `stimeo--multi-select:filter` for async candidates.
 * - The chips are one roving Tab stop: `ArrowLeft`/`ArrowRight` move between them,
 *   `Delete`/`Backspace` remove the focused chip, and `Backspace` on an empty
 *   input removes the last; removal re-homes focus to a neighbor or the input.
 * - `max` caps the selection (`0` = unlimited).
 */
export class MultiSelectController extends Controller<HTMLElement> {
  static override targets = ["input", "list", "option", "tags", "tag", "tagTemplate", "status"];
  static override values = {
    max: { type: Number, default: 0 },
  };
  static actions = ["close", "filter", "onKeydown", "open", "toggleOption"] as const;
  static events = ["change", "filter"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly listTarget: HTMLElement;
  declare readonly optionTargets: HTMLElement[];
  declare readonly tagsTarget: HTMLElement;
  declare readonly tagTargets: HTMLElement[];
  declare readonly tagTemplateTarget: HTMLTemplateElement;
  declare readonly statusTarget: HTMLElement;
  declare readonly hasListTarget: boolean;
  declare readonly hasTagsTarget: boolean;
  declare readonly hasTagTemplateTarget: boolean;
  declare readonly hasStatusTarget: boolean;

  declare maxValue: number;

  /** The active option (tracked via `aria-activedescendant`), or null. */
  #activeOption: HTMLElement | null = null;
  readonly #roving = new RovingTabindex(() => this.#removeButtons);

  /** Starts closed, syncs chips for any pre-selected options, and listens out. */
  override connect(): void {
    this.close();
    if (this.hasTagsTarget) {
      this.tagsTarget.addEventListener("keydown", this.#onTagKeydown);
      this.tagsTarget.addEventListener("click", this.#onTagClick);
      // Rebuild chips idempotently: a Turbo Drive cache restore or morph can
      // re-connect with chips already in the DOM, so clear them before deriving
      // afresh from the selected options to avoid duplicate chips.
      for (const tag of this.tagTargets) tag.remove();
      for (const option of this.#selectedOptions) this.#appendTag(option);
      if (this.#removeButtons.length > 0) this.#roving.setActive(0);
    }
    document.addEventListener("click", this.#onOutsideClick);
  }

  /** Tears down document and chip listeners on disconnect (Turbo included). */
  override disconnect(): void {
    if (this.hasTagsTarget) {
      this.tagsTarget.removeEventListener("keydown", this.#onTagKeydown);
      this.tagsTarget.removeEventListener("click", this.#onTagClick);
    }
    document.removeEventListener("click", this.#onOutsideClick);
  }

  /** Filters options by the input substring, opens, and re-seeds the active one. */
  filter(): void {
    const query = this.inputTarget.value.trim().toLowerCase();
    for (const option of this.optionTargets) {
      const label = (option.textContent ?? "").trim().toLowerCase();
      option.hidden = query !== "" && !label.includes(query);
    }
    this.open();
    const visible = this.#visibleOptions;
    this.element.toggleAttribute("data-stimeo--multi-select-empty", visible.length === 0);
    this.#setActive(visible[0] ?? null);
    this.dispatch("filter", { detail: { query } });
  }

  /** Opens the list and activates the first visible option when none is active. */
  open(): void {
    if (!this.hasListTarget) return;
    this.listTarget.hidden = false;
    this.inputTarget.setAttribute("aria-expanded", "true");
    if (!this.#activeOption) this.#setActive(this.#visibleOptions[0] ?? null);
  }

  /** Closes the list and clears the active option. */
  close(): void {
    if (!this.hasListTarget) return;
    this.listTarget.hidden = true;
    this.inputTarget.setAttribute("aria-expanded", "false");
    this.#setActive(null);
  }

  /** Routes input keyboard interaction per the multi-select combobox model. */
  onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (this.#isClosed) this.open();
        else this.#moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (this.#isClosed) this.open();
        else this.#moveActive(-1);
        break;
      case "Home":
        if (!this.#isClosed) {
          event.preventDefault();
          this.#setActive(this.#visibleOptions[0] ?? null);
        }
        break;
      case "End": {
        if (!this.#isClosed) {
          event.preventDefault();
          const visible = this.#visibleOptions;
          this.#setActive(visible[visible.length - 1] ?? null);
        }
        break;
      }
      case "Enter":
        if (!this.#isClosed && this.#activeOption) {
          event.preventDefault();
          this.#toggleSelection(this.#activeOption);
        }
        break;
      case "Escape":
        event.preventDefault();
        this.close();
        break;
      case "Backspace":
        if (this.inputTarget.value === "") {
          const buttons = this.#removeButtons;
          if (buttons.length > 0) {
            event.preventDefault();
            this.#removeTagAt(buttons.length - 1);
          }
        }
        break;
      case "ArrowLeft":
        if (this.inputTarget.value === "" && this.#removeButtons.length > 0) {
          event.preventDefault();
          this.#roving.setActive(this.#removeButtons.length - 1, { focus: true });
        }
        break;
      case "Tab":
        this.close();
        break;
      default:
        break;
    }
  }

  /** Toggles the clicked option's selection. Bound via `data-action`. */
  toggleOption(event: Event): void {
    const option = (event.currentTarget as HTMLElement).closest<HTMLElement>('[role="option"]');
    if (option) this.#toggleSelection(option);
  }

  /**
   * Removes the chip whose remove button was clicked, deselecting its option.
   * Delegated on the tags container (like `#onTagKeydown`) rather than bound
   * per chip via `data-action`, so it works the instant a chip is appended without
   * waiting on Stimulus to wire a freshly created element.
   */
  readonly #onTagClick = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement).closest("button");
    if (!button || !this.tagsTarget.contains(button)) return;
    const index = this.#removeButtons.indexOf(button as HTMLButtonElement);
    if (index !== -1) this.#removeTagAt(index);
  };

  /** Moves the active option by `delta` among visible options, wrapping. */
  #moveActive(delta: number): void {
    const visible = this.#visibleOptions;
    if (visible.length === 0) return;
    const current = this.#activeOption ? visible.indexOf(this.#activeOption) : -1;
    const next = (current + delta + visible.length) % visible.length;
    this.#setActive(visible[next] ?? null);
  }

  /** Selects/deselects `option`, honoring `max`, and syncs chip + live region. */
  #toggleSelection(option: HTMLElement): void {
    const selected = option.getAttribute("aria-selected") === "true";
    if (!selected && this.maxValue > 0 && this.#selectedOptions.length >= this.maxValue) {
      return;
    }
    option.setAttribute("aria-selected", String(!selected));
    if (selected) {
      this.#removeTagFor(option);
    } else {
      this.#appendTag(option);
    }
    this.#announce(this.#optionLabel(option));
    this.#refreshRoving();
    this.dispatch("change", { detail: { values: this.#values } });
  }

  /** Builds one chip from the template for `option`. */
  #appendTag(option: HTMLElement): void {
    if (!this.hasTagTemplateTarget || !this.hasTagsTarget) return;
    const fragment = this.tagTemplateTarget.content.cloneNode(true) as DocumentFragment;
    const tag = fragment.querySelector<HTMLElement>('[data-stimeo--multi-select-target="tag"]');
    const label = fragment.querySelector<HTMLElement>('[data-multi-select-slot="label"]');
    const button = fragment.querySelector<HTMLButtonElement>("button");
    if (!tag || !button) return;
    const text = this.#optionLabel(option);
    tag.dataset.value = this.#optionValue(option);
    if (label) label.textContent = text;
    button.setAttribute("aria-label", `Remove ${text}`);
    button.tabIndex = -1;
    this.tagsTarget.appendChild(fragment);
  }

  /** Removes the chip mirroring `option`, if present. */
  #removeTagFor(option: HTMLElement): void {
    const value = this.#optionValue(option);
    const tag = this.tagTargets.find((candidate) => candidate.dataset.value === value);
    tag?.remove();
  }

  /** Removes chip `index` and deselects its option, re-homing focus. */
  #removeTagAt(index: number): void {
    const tag = this.tagTargets[index];
    if (!tag) return;
    const value = tag.dataset.value ?? "";
    // Match by the option's stable value, which falls back to its label when no
    // data-value is present, so a label-keyed chip still finds its option.
    const option = this.optionTargets.find((candidate) => this.#optionValue(candidate) === value);
    if (option) option.setAttribute("aria-selected", "false");
    tag.remove();
    // Prefer the option's display label for the announcement (e.g. "Apple"),
    // which can differ from its data-value (e.g. "apple").
    this.#announce(option ? this.#optionLabel(option) : value);
    this.#refreshRoving();
    this.dispatch("change", { detail: { values: this.#values } });

    const remaining = this.#removeButtons;
    if (remaining.length === 0) {
      this.inputTarget.focus();
    } else {
      this.#roving.setActive(Math.min(index, remaining.length - 1), { focus: true });
    }
  }

  /** Arrow navigation and deletion within the chip list (delegated). */
  readonly #onTagKeydown = (event: KeyboardEvent): void => {
    const button = (event.target as HTMLElement).closest("button");
    if (!button) return;
    const buttons = this.#removeButtons;
    const index = buttons.indexOf(button);
    if (index === -1) return;
    switch (event.key) {
      case "ArrowLeft":
        if (index > 0) {
          event.preventDefault();
          this.#roving.setActive(index - 1, { focus: true });
        }
        break;
      case "ArrowRight":
        event.preventDefault();
        if (index < buttons.length - 1) this.#roving.setActive(index + 1, { focus: true });
        else this.inputTarget.focus();
        break;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        this.#removeTagAt(index);
        break;
      default:
        break;
    }
  };

  /**
   * Marks `option` active via `data-active` and the input's
   * `aria-activedescendant` (the attribute is removed, not emptied, when null).
   */
  #setActive(option: HTMLElement | null): void {
    this.#activeOption = option;
    for (const candidate of this.optionTargets) {
      candidate.toggleAttribute("data-active", candidate === option);
    }
    if (option) {
      this.inputTarget.setAttribute("aria-activedescendant", ensureId(option, "stimeo-ms-opt"));
    } else {
      this.inputTarget.removeAttribute("aria-activedescendant");
    }
  }

  /** Keeps exactly one chip remove button tabbable after the set changes. */
  #refreshRoving(): void {
    if (this.#removeButtons.length > 0 && this.#roving.activeIndex === -1)
      this.#roving.setActive(0);
  }

  /** Mirrors the changed option label into the live region. */
  #announce(text: string): void {
    if (this.hasStatusTarget) this.statusTarget.textContent = text;
  }

  /** Closes the list on a click outside the controller element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (!this.#isClosed && !this.element.contains(event.target as Node)) this.close();
  };

  /** Trimmed visible label of an option. */
  #optionLabel(option: HTMLElement): string {
    return (option.textContent ?? "").trim();
  }

  /** An option's stable value: its `data-value`, else its display label. */
  #optionValue(option: HTMLElement): string {
    return option.dataset.value ?? this.#optionLabel(option);
  }

  /** Options not hidden by the current filter. */
  get #visibleOptions(): HTMLElement[] {
    return this.optionTargets.filter((option) => !option.hidden);
  }

  /** Options currently selected. */
  get #selectedOptions(): HTMLElement[] {
    return this.optionTargets.filter((option) => option.getAttribute("aria-selected") === "true");
  }

  /** Selected values in option order. */
  get #values(): string[] {
    return this.#selectedOptions.map((option) => this.#optionValue(option));
  }

  /** The chip remove buttons in order (the roving navigation set). */
  get #removeButtons(): HTMLButtonElement[] {
    return this.hasTagsTarget
      ? Array.from(this.tagsTarget.querySelectorAll<HTMLButtonElement>("button"))
      : [];
  }

  /** Whether the list is currently hidden. */
  get #isClosed(): boolean {
    return !this.hasListTarget || this.listTarget.hidden !== false;
  }
}
