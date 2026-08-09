import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { CompositionTracker } from "../utils/composition_tracker";
import { RovingTabindex } from "../utils/roving_tabindex";

/**
 * Headless, accessible free-input tags / chips field.
 *
 * Markup contract (identifier: `stimeo--tags-input`):
 *   <div data-controller="stimeo--tags-input"
 *        data-stimeo--tags-input-delimiter-value=",">
 *     <ul role="list" aria-label="Tags" data-stimeo--tags-input-target="tags"></ul>
 *     <input type="text" aria-label="Add tag" aria-describedby="tags-help"
 *            data-stimeo--tags-input-target="input"
 *            data-action="keydown->stimeo--tags-input#onKeydown" />
 *     <span role="status" aria-live="polite" class="visually-hidden"
 *           data-stimeo--tags-input-target="status"></span>
 *     <div data-stimeo--tags-input-target="fields"></div>
 *     <template data-stimeo--tags-input-target="tagTemplate">
 *       <li role="listitem" data-stimeo--tags-input-target="tag">
 *         <span data-tags-input-slot="label"></span>
 *         <!-- Removal is delegated on the tags container; no per-chip action needed. -->
 *         <button type="button" tabindex="-1">×</button>
 *       </li>
 *     </template>
 *   </div>
 *
 * There is no single established APG pattern; this composes a labeled text input
 * with a roving-tabindex list of removable chips, mapping to WCAG 2.1.1, 2.4.7,
 * 4.1.2, 4.1.3, and 1.3.1. Unlike {@link MultiSelectController} (pick from a
 * candidate list) the user types arbitrary strings.
 *
 * Behavior provided:
 * - `Enter` or the configured delimiter commits the trimmed input as a tag.
 * - Empty / duplicate / over-limit additions are rejected with
 *   `stimeo--tags-input:reject`; duplicates are allowed when `allowDuplicates`.
 * - Tags render from the `tagTemplate`, each with a `Remove {label}` button; the
 *   `fields` container mirrors the tag set as `name`d hidden inputs for form
 *   submission, and every change dispatches `stimeo--tags-input:change`.
 * - The remove buttons form one roving Tab stop: `ArrowLeft`/`ArrowRight` move
 *   between them (right past the end returns to the input), `Delete`/`Backspace`
 *   delete the focused tag, and `Backspace` on an empty input deletes the last.
 * - Removing a tag moves focus to the neighboring tag, else back to the input.
 */
export class TagsInputController extends Controller<HTMLElement> {
  static override targets = ["input", "tags", "tag", "tagTemplate", "status", "fields"];
  static override values = {
    delimiter: { type: String, default: "," },
    max: { type: Number, default: 0 },
    allowDuplicates: { type: Boolean, default: false },
    name: { type: String, default: "tags[]" },
  };
  static actions = ["onKeydown"] as const;
  static events = ["change", "reject"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly tagsTarget: HTMLElement;
  declare readonly tagTargets: HTMLElement[];
  declare readonly tagTemplateTarget: HTMLTemplateElement;
  declare readonly statusTarget: HTMLElement;
  declare readonly fieldsTarget: HTMLElement;
  declare readonly hasStatusTarget: boolean;
  declare readonly hasFieldsTarget: boolean;
  declare readonly hasTagTemplateTarget: boolean;
  declare readonly hasInputTarget: boolean;

  declare delimiterValue: string;
  declare maxValue: number;
  declare allowDuplicatesValue: boolean;
  declare nameValue: string;

  readonly #roving = new RovingTabindex(() => this.#removeButtons);
  /** Owns IME lifecycle state for commit-key guarding. */
  readonly #composition = new CompositionTracker();

  /** Wires tag-list keyboard navigation and removal, and seeds the single Tab stop. */
  override connect(): void {
    if (this.hasInputTarget) this.#composition.observe(this.inputTarget);
    this.tagsTarget.addEventListener("keydown", this.#onTagKeydown);
    this.tagsTarget.addEventListener("click", this.#onTagClick);
    this.#syncState();
  }

  /** Releases the delegated listeners so no handler outlives the element. */
  override disconnect(): void {
    this.#composition.disconnect();
    this.tagsTarget.removeEventListener("keydown", this.#onTagKeydown);
    this.tagsTarget.removeEventListener("click", this.#onTagClick);
  }

  /** Tracks an input added initially or after connect. */
  inputTargetConnected(input: HTMLInputElement): void {
    this.#composition.observe(input);
  }

  /** Removes composition listeners when the active input is replaced or removed. */
  inputTargetDisconnected(input: HTMLInputElement): void {
    this.#composition.unobserve(input);
  }

  /** Commits on `Enter`/delimiter and deletes the last tag on empty `Backspace`. */
  onKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key must not ALSO commit a tag
    // or reach into the chips — composition depends on this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    // Ignore keys fired during IME composition: the `Enter` that confirms a
    // candidate (and arrows that move within it) must not commit/navigate the
    // chip list. Controller-owned lifecycle state covers confirming events that
    // omit the standard per-event signal.
    if (this.#composition.isComposing(event)) return;
    if (event.key === "Enter" || event.key === this.delimiterValue) {
      event.preventDefault();
      this.#commitInput();
      return;
    }
    if (event.key === "Backspace" && this.inputTarget.value === "") {
      const buttons = this.#removeButtons;
      if (buttons.length > 0) {
        event.preventDefault();
        this.#removeAt(buttons.length - 1);
      }
      return;
    }
    // Same normalisation as the chip handler below, read from the same element.
    if (logicalArrowKey(event.key, this.element) === "ArrowLeft" && this.inputTarget.value === "") {
      const buttons = this.#removeButtons;
      if (buttons.length > 0) {
        event.preventDefault();
        this.#roving.setActive(buttons.length - 1, { focus: true });
      }
    }
  }

  /**
   * Deletes the tag whose remove button was clicked. Delegated on the tags
   * container (like `#onTagKeydown`) rather than bound per chip via
   * `data-action`, so it works the instant a chip is appended without waiting on
   * Stimulus to wire a freshly created element.
   */
  readonly #onTagClick = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement).closest("button");
    if (!button || !this.tagsTarget.contains(button)) return;
    const index = this.#removeButtons.indexOf(button as HTMLButtonElement);
    if (index !== -1) this.#removeAt(index);
  };

  /** Validates and adds the current input value as a tag, then clears the input. */
  #commitInput(): void {
    const value = this.inputTarget.value.trim();
    if (value === "") {
      this.#reject(value, "empty");
      return;
    }
    if (this.maxValue > 0 && this.tagTargets.length >= this.maxValue) {
      this.#reject(value, "max");
      return;
    }
    if (!this.allowDuplicatesValue && this.#values.includes(value)) {
      this.#reject(value, "duplicate");
      return;
    }
    this.#appendTag(value);
    this.inputTarget.value = "";
    this.#announce(value);
    this.#syncState();
    this.dispatch("change", { detail: { tags: this.#values } });
  }

  /** Builds one chip from the template and appends it to the tag list. */
  #appendTag(value: string): void {
    if (!this.hasTagTemplateTarget) return;
    const fragment = this.tagTemplateTarget.content.cloneNode(true) as DocumentFragment;
    const tag = fragment.querySelector<HTMLElement>('[data-stimeo--tags-input-target="tag"]');
    const label = fragment.querySelector<HTMLElement>('[data-tags-input-slot="label"]');
    const button = fragment.querySelector<HTMLButtonElement>("button");
    if (!tag || !button) return;
    tag.dataset.value = value;
    if (label) label.textContent = value;
    button.setAttribute("aria-label", `Remove ${value}`);
    button.tabIndex = -1;
    this.tagsTarget.appendChild(fragment);
  }

  /** Removes the tag at `index`, then moves focus to a neighbor or the input. */
  #removeAt(index: number): void {
    const tag = this.tagTargets[index];
    if (!tag) return;
    const value = tag.dataset.value ?? "";
    tag.remove();
    this.#announce(value);
    this.#syncState();
    this.dispatch("change", { detail: { tags: this.#values } });
    const remaining = this.#removeButtons;
    if (remaining.length === 0) {
      this.inputTarget.focus();
    } else {
      this.#roving.setActive(Math.min(index, remaining.length - 1), { focus: true });
    }
  }

  /** Handles arrow navigation and deletion within the chip list (delegated). */
  readonly #onTagKeydown = (event: KeyboardEvent): void => {
    // A descendant widget that already claimed the key must not ALSO move the
    // chip focus — composition depends on this yield. Chips render from the
    // consumer's template, so an arbitrary widget can live inside one.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    const button = (event.target as HTMLElement).closest("button");
    if (!button) return;
    const buttons = this.#removeButtons;
    const index = buttons.indexOf(button);
    if (index === -1) return;
    // Logical, not physical. The key is normalised rather than a new case added:
    // the two horizontal branches are not mirror images — only one guards its
    // edge, and the other hands focus back to the input — so swapping the key
    // keeps each branch, guards and all, with its own direction. Both handlers
    // read the same element on purpose; probing the focused child would let the
    // input and the chips disagree at the boundary between them.
    switch (logicalArrowKey(event.key, this.element)) {
      case "ArrowLeft":
        if (index > 0) {
          event.preventDefault();
          this.#roving.setActive(index - 1, { focus: true });
        }
        break;
      case "ArrowRight":
        event.preventDefault();
        if (index < buttons.length - 1) {
          this.#roving.setActive(index + 1, { focus: true });
        } else {
          this.inputTarget.focus();
        }
        break;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        this.#removeAt(index);
        break;
      default:
        break;
    }
  };

  /** Rebuilds the hidden form fields, the `full` flag, and the roving Tab stop. */
  #syncState(): void {
    if (this.hasFieldsTarget) {
      this.fieldsTarget.replaceChildren(
        ...this.#values.map((value) => {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = this.nameValue;
          input.value = value;
          return input;
        }),
      );
    }
    const full = this.maxValue > 0 && this.tagTargets.length >= this.maxValue;
    this.element.toggleAttribute("data-stimeo--tags-input-full", full);
    // Keep exactly one remove button tabbable so the chip list is a single stop.
    if (this.#removeButtons.length > 0 && this.#roving.activeIndex === -1) {
      this.#roving.setActive(0);
    }
  }

  /** Mirrors the changed tag into the live region for assistive tech. */
  #announce(value: string): void {
    if (this.hasStatusTarget) this.statusTarget.textContent = value;
  }

  /** Reports a rejected addition via `stimeo--tags-input:reject`. */
  #reject(value: string, reason: "duplicate" | "empty" | "max"): void {
    this.dispatch("reject", { detail: { value, reason } });
  }

  /** The remove buttons in document order (the roving navigation set). */
  get #removeButtons(): HTMLButtonElement[] {
    return Array.from(this.tagsTarget.querySelectorAll<HTMLButtonElement>("button"));
  }

  /** Current tag values in order. */
  get #values(): string[] {
    return this.tagTargets.map((tag) => tag.dataset.value ?? "");
  }
}
