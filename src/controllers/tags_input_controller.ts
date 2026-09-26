import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { ChipRow } from "../utils/chip_row";
import { CompositionTracker } from "../utils/composition_tracker";
import { matchingPart, writeLabel } from "../utils/element_part";
import { commitField, writeFields } from "../utils/field_mirror";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { TemplateRow } from "../utils/template_row";

/**
 * Headless, accessible free-input tags / chips field.
 *
 * Markup contract (identifier: `stimeo--tags-input`):
 *   <div data-controller="stimeo--tags-input"
 *        data-stimeo--tags-input-delimiter-value=","
 *        data-stimeo--tags-input-announce-text-value="{label} added; {count} total"
 *        data-stimeo--tags-input-announce-removed-text-value="{label} removed; {count} total">
 *     <ul role="list" aria-label="Tags" data-stimeo--tags-input-target="tags"></ul>
 *     <input type="text" aria-label="Add tag" aria-describedby="tags-help"
 *            data-stimeo--tags-input-target="input"
 *            data-action="keydown->stimeo--tags-input#onKeydown" />
 *     <div data-stimeo--tags-input-target="fields"></div>
 *     <template data-stimeo--tags-input-target="tagTemplate">
 *       <li role="listitem" data-stimeo--tags-input-target="tag">
 *         <span data-stimeo--tags-input-target="label"></span>
 *         <!-- Removal is delegated on the tags container; no per-chip action needed. -->
 *         <button type="button" tabindex="-1" aria-label="Remove {label}"
 *                 data-stimeo--tags-input-target="remove">×</button>
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
 * - Tags render transactionally from the `tagTemplate`; its author-localized
 *   remove-button `aria-label` expands `{label}` / `{value}`. The
 *   `fields` container mirrors the tag set as `name`d hidden inputs for form
 *   submission; `form` associates them with a `<form>` by id when the field
 *   sits outside it. A tag the user added or removed also emits a native
 *   bubbling `change` from that container, the way a form control does, so
 *   `stimeo--auto-submit` and form-level validation hear it; the rebuilds that
 *   follow connect, a replacement container, tag churn, or a `name` / `form`
 *   change stay silent. User changes dispatch `stimeo--tags-input:change`;
 *   DOM/Turbo tag changes dispatch `stimeo--tags-input:reconcile`; authored
 *   templates route localized addition/removal text to the shared announcer.
 * - The remove buttons form one roving Tab stop: `ArrowLeft`/`ArrowRight` move
 *   between them (right past the end returns to the input), `Delete`/`Backspace`
 *   delete the focused tag, and `Backspace` on an empty input deletes the last.
 * - Removing from a chip moves focus to its neighbor (else the input); removing
 *   via empty-input `Backspace` keeps focus in the input for continued editing.
 * `change` and `reconcile` dispatch `{ tags: string[] }`; `reject` dispatches
 * `{ value: string, reason: "duplicate" | "empty" | "max" }`.
 */
export class TagsInputController extends Controller<HTMLElement> {
  static override targets = ["input", "tags", "tag", "tagTemplate", "label", "remove", "fields"];
  static override values = {
    delimiter: { type: String, default: "," },
    max: { type: Number, default: 0 },
    allowDuplicates: { type: Boolean, default: false },
    name: { type: String, default: "tags[]" },
    form: { type: String, default: "" },
    announceText: { type: String, default: "" },
    announceRemovedText: { type: String, default: "" },
  };
  static actions = ["onKeydown"] as const;
  static events = ["change", "reconcile", "reject"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly tagsTarget: HTMLElement;
  declare readonly tagTargets: HTMLElement[];
  declare readonly tagTemplateTarget: HTMLTemplateElement;
  declare readonly labelTargets: HTMLElement[];
  declare readonly removeTargets: HTMLButtonElement[];
  declare readonly fieldsTarget: HTMLElement;
  declare readonly hasFieldsTarget: boolean;
  declare readonly hasTagTemplateTarget: boolean;
  declare readonly hasInputTarget: boolean;
  declare readonly hasTagsTarget: boolean;

  declare delimiterValue: string;
  declare maxValue: number;
  declare allowDuplicatesValue: boolean;
  declare nameValue: string;
  declare formValue: string;
  declare announceTextValue: string;
  declare announceRemovedTextValue: string;

  /** Last reconciled tag order, separating user edits from DOM/Turbo repair. */
  #tagValues: string[] = [];
  /** Builds one chip from the authored template and owns its diagnostic. */
  readonly #rows = new TemplateRow({
    identifier: this.identifier,
    root: "tag",
    required: ["label"],
    button: "remove",
    outcome: "added no tag",
    noun: "chip template",
  });
  /** Collapses one target/Value mutation batch into one final-DOM repair pass. */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileTags());
  readonly #chipRow = new ChipRow({
    directionElement: this.element,
    getItems: () => this.tagTargets,
    getButton: (tag) =>
      matchingPart<HTMLButtonElement>(tag, `button${this.#rows.selector("remove")}`),
    onRemove: (index) => this.#removeAt(index),
    focusAfterEnd: () => this.#focusInput(),
  });
  /** Owns IME lifecycle state for commit-key guarding. */
  readonly #composition = new CompositionTracker();

  /** Wires tag-list keyboard navigation and removal, and seeds the single Tab stop. */
  override connect(): void {
    this.#rows.connect();
    if (this.hasInputTarget) this.#composition.observe(this.inputTarget);
    if (this.hasTagsTarget) this.#chipRow.connect(this.tagsTarget);
    const tags = this.#values;
    this.#syncState(tags);
    this.#tagValues = tags;
    this.#reconcile.activate();
  }

  /** Releases the delegated listeners so no handler outlives the element. */
  override disconnect(): void {
    this.#reconcile.cancel();
    this.#composition.disconnect();
    this.#chipRow.disconnect();
  }

  /** Tracks an input added initially or after connect. */
  inputTargetConnected(input: HTMLInputElement): void {
    this.#composition.observe(input);
  }

  /** Removes composition listeners when the active input is replaced or removed. */
  inputTargetDisconnected(input: HTMLInputElement): void {
    this.#composition.unobserve(input);
  }

  /** Rebinds delegation and derived state when the tags container is replaced. */
  tagsTargetConnected(_tags: HTMLElement): void {
    this.#reconcile.schedule();
  }

  /** Releases only the row that disconnected, leaving a newer target intact. */
  tagsTargetDisconnected(tags: HTMLElement): void {
    this.#chipRow.disconnect(tags);
    this.#reconcile.schedule();
  }

  /** Reconciles a tag inserted by Turbo, a server render, or another controller. */
  tagTargetConnected(_tag: HTMLElement): void {
    this.#reconcile.schedule();
  }

  /** Reconciles a tag removed by Turbo, a server render, or another controller. */
  tagTargetDisconnected(_tag: HTMLElement): void {
    this.#reconcile.schedule();
  }

  /** Seeds a fields target inserted after connect. */
  fieldsTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Rebuilds submitted fields when the public name changes at runtime. */
  nameValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Repoints submitted fields when the owning form changes at runtime. */
  formValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Recomputes the full hook when the cap changes at runtime. */
  maxValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Commits on `Enter`/delimiter and deletes the last tag on empty `Backspace`. */
  onKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key must not ALSO commit a tag
    // or reach into the chips — composition depends on this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    if (!this.hasInputTarget) return;
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
      const last = this.#chipRow.lastIndex;
      if (last >= 0) {
        event.preventDefault();
        this.#removeAt(last, "input");
      }
      return;
    }
    // Same normalisation as the chip handler below, read from the same element.
    if (logicalArrowKey(event.key, this.element) === "ArrowLeft" && this.inputTarget.value === "") {
      if (this.#chipRow.length > 0) {
        event.preventDefault();
        this.#chipRow.focusLast();
      }
    }
  }

  /**
   * Validates and adds the current input value as a tag, then clears the input.
   *
   * @stimeoRuntimeOnly `max` and `allowDuplicates` decide whether this one entry is taken.
   */
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
    if (!this.#appendTag(value)) return;
    this.inputTarget.value = "";
    const tags = this.#values;
    this.#syncState(tags, true);
    this.#tagValues = tags;
    this.#announceTransition(true, value, tags.length);
    this.dispatch("change", { detail: { tags } });
  }

  /**
   * Builds one chip from the template and appends it to the tag list.
   *
   * A refused row leaves the commit a no-op — nothing about the input, the tag
   * set, the hidden fields, the announcement, or the events changes — and the
   * row reports why on the console once per connection.
   */
  #appendTag(value: string): boolean {
    if (!this.hasTagsTarget) return false;
    if (!this.hasTagTemplateTarget) {
      this.#rows.report('a "tagTemplate" target');
      return false;
    }
    const row = this.#rows.instantiate(this.tagTemplateTarget, { label: value, value });
    if (!row) return false;
    row.root.dataset.value = value;
    writeLabel(row.slots.label, value);
    // Chip buttons are a single Tab stop the roving helper hands out.
    row.button.tabIndex = -1;
    this.tagsTarget.appendChild(row.root);
    return true;
  }

  /** Removes the tag at `index`, then applies the interaction-origin focus policy. */
  #removeAt(index: number, focus: "neighbor" | "input" = "neighbor"): void {
    const tag = this.tagTargets[index];
    if (!tag) return;
    const value = tag.dataset.value ?? "";
    tag.remove();
    const tags = this.#values;
    this.#syncState(tags, true);
    this.#tagValues = tags;
    this.#announceTransition(false, value, tags.length);
    this.dispatch("change", { detail: { tags } });
    if (focus === "input") {
      this.#focusInput();
      return;
    }
    if (!this.#chipRow.focusAfterRemoval(index)) this.#focusInput();
  }

  /** Moves focus to the current input when one exists. */
  #focusInput(): void {
    if (this.hasInputTarget) this.inputTarget.focus();
  }

  /**
   * Rebuilds the hidden form fields, the `full` flag, and the roving Tab stop.
   *
   * @stimeoRenderRoot
   */
  #syncState(values: readonly string[], notify = false): void {
    if (this.hasFieldsTarget) {
      const options = { name: this.nameValue, form: this.formValue };
      if (writeFields(this.fieldsTarget, values, options) && notify) {
        commitField(this.fieldsTarget);
      }
    }
    const full = this.maxValue > 0 && values.length >= this.maxValue;
    this.element.toggleAttribute(`data-${this.identifier}-full`, full);
    // Keep exactly one remove button tabbable so the chip list is a single stop.
    this.#chipRow.ensureTabStop();
  }

  /** Repairs derived state after DOM/Turbo changes and reports a changed tag order. */
  #reconcileTags(): void {
    if (this.hasTagsTarget) this.#chipRow.connect(this.tagsTarget);
    else this.#chipRow.disconnect();
    const tags = this.#values;
    this.#syncState(tags);
    const changed = !this.#sameTags(this.#tagValues, tags);
    this.#tagValues = tags;
    if (changed) this.dispatch("reconcile", { detail: { tags } });
  }

  /**
   * Sends one localized tag transition through the page's shared announcer.
   *
   * @stimeoRuntimeOnly The texts word the one announcement of this change.
   */
  #announceTransition(added: boolean, value: string, count: number): void {
    const template = added ? this.announceTextValue : this.announceRemovedTextValue;
    announce(fillTemplate(template, { label: value, value, count }));
  }

  /** Reports rejection with `{ value, reason: "duplicate" | "empty" | "max" }`. */
  #reject(value: string, reason: "duplicate" | "empty" | "max"): void {
    this.dispatch("reject", { detail: { value, reason } });
  }

  /** Current tag values in order. */
  get #values(): string[] {
    return this.tagTargets.map((tag) => tag.dataset.value ?? "");
  }

  /** Whether two arrays carry the same values in the same submitted order. */
  #sameTags(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
}
