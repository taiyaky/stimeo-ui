import { Controller } from "@hotwired/stimulus";
import { RovingTabindex, rovingMove } from "../utils/roving_tabindex";

/**
 * Headless, accessible radio-group behavior for **custom** (non-native) radios.
 *
 * Markup contract (identifier: `stimeo--radio-group`):
 *   <div data-controller="stimeo--radio-group" role="radiogroup" aria-label="Plan">
 *     <div role="radio" aria-checked="true" tabindex="0" data-value="basic"
 *          data-stimeo--radio-group-target="radio"
 *          data-action="click->stimeo--radio-group#select
 *                       keydown->stimeo--radio-group#onKeydown">Basic</div>
 *     <!-- more radios; exactly one tabindex=0 -->
 *     <input type="hidden" data-stimeo--radio-group-target="field" />
 *   </div>
 *
 * Implements the WAI-ARIA APG **Radio Group** pattern. Use this only for custom
 * radios (e.g. button-styled cards); native `<input type="radio">` already does
 * this and should be preferred when its look suffices.
 *
 * @remarks
 * Behavior only — selection is exposed through `aria-checked`, the single Tab
 * stop through roving `tabindex` ({@link RovingTabindex}); the consumer styles
 * off `[role="radio"][aria-checked="true"]`. Per APG, **selection follows
 * focus**: arrow keys move focus and select in one step.
 *
 * Behavior provided:
 * - Click selects a radio.
 * - `ArrowDown`/`ArrowRight` select the next, `ArrowUp`/`ArrowLeft` the previous
 *   (wrapping); `Home`/`End` the first/last; `Space` selects the focused radio.
 * - The selected radio's `data-value` is mirrored to the optional hidden `field`,
 *   and `stimeo--radio-group:change` is dispatched on every change.
 */
export class RadioGroupController extends Controller<HTMLElement> {
  static override targets = ["radio", "field"];
  static actions = ["onKeydown", "select"] as const;
  static events = ["change"] as const;

  declare readonly radioTargets: HTMLElement[];
  declare readonly fieldTarget: HTMLInputElement;
  declare readonly hasFieldTarget: boolean;

  readonly #roving = new RovingTabindex(() => this.radioTargets);

  /** Establishes the roving entry point and reflects the initial selection. */
  override connect(): void {
    const selected = this.#selectedIndex();
    // With no selection, the first radio is the (unchecked) Tab entry point.
    this.#roving.setActive(selected === -1 ? 0 : selected);
    // Reflect the server-rendered selection without firing a native `change`:
    // connect is not a user edit, and the field already carries this value.
    if (selected !== -1) this.#reflectField(this.radioTargets[selected], { silent: true });
  }

  /** Selects the clicked radio. Bound via `data-action` (click). */
  select(event: Event): void {
    const index = this.radioTargets.indexOf(event.currentTarget as HTMLElement);
    if (index !== -1) this.#selectIndex(index, { focus: false });
  }

  /** Arrow/Home/End/Space navigation with selection-follows-focus. */
  onKeydown(event: KeyboardEvent): void {
    const current = this.radioTargets.indexOf(event.currentTarget as HTMLElement);
    if (current === -1) return;

    let next: number | null = null;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = rovingMove(current, this.radioTargets.length, 1, "wrap");
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = rovingMove(current, this.radioTargets.length, -1, "wrap");
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = this.radioTargets.length - 1;
        break;
      case " ":
        next = current;
        break;
      default:
        return;
    }

    event.preventDefault();
    this.#selectIndex(next, { focus: true });
  }

  /**
   * Checks the radio at `index`, clears the rest, updates the roving Tab stop and
   * the hidden field, and dispatches `change`.
   */
  #selectIndex(index: number, { focus }: { focus: boolean }): void {
    const radio = this.radioTargets[index];
    if (!radio) return;
    this.radioTargets.forEach((item, i) => {
      item.setAttribute("aria-checked", i === index ? "true" : "false");
    });
    this.#roving.setActive(index, { focus });
    this.#reflectField(radio);
    this.dispatch("change", { detail: { value: this.#radioValue(radio), radio } });
  }

  /** Index of the currently checked radio, or `-1` if none. */
  #selectedIndex(): number {
    return this.radioTargets.findIndex((radio) => radio.getAttribute("aria-checked") === "true");
  }

  /**
   * Mirrors a radio's `data-value` onto the hidden field, when present. Fires a
   * native bubbling `change` on a real value change (matching `listbox`, so
   * `auto-submit` and other native-`change` consumers react) — unless `silent`
   * (the initial connect reflection, which is not a user edit).
   */
  #reflectField(
    radio: HTMLElement | undefined,
    { silent = false }: { silent?: boolean } = {},
  ): void {
    if (!this.hasFieldTarget || !radio) return;
    const value = this.#radioValue(radio);
    if (this.fieldTarget.value === value) return;
    this.fieldTarget.value = value;
    if (!silent) this.fieldTarget.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** A radio's submitted value (`data-value`, defaulting to empty). */
  #radioValue(radio: HTMLElement): string {
    return radio.getAttribute("data-value") ?? "";
  }
}
