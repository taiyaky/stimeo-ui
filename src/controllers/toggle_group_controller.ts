import { Controller } from "@hotwired/stimulus";
import { RovingTabindex, rovingMove } from "../utils/roving_tabindex";

/**
 * Headless, accessible toggle-button group behavior.
 *
 * Markup contract (identifier: `stimeo--toggle-group`):
 *   <div data-controller="stimeo--toggle-group"
 *        data-stimeo--toggle-group-mode-value="single"
 *        role="group" aria-label="Text style">
 *     <button type="button" aria-pressed="true" tabindex="0" data-value="bold"
 *             data-stimeo--toggle-group-target="item"
 *             data-action="click->stimeo--toggle-group#toggle
 *                          keydown->stimeo--toggle-group#onKeydown">Bold</button>
 *     <!-- more items; exactly one tabindex=0 -->
 *   </div>
 *
 * Implements the WAI-ARIA APG **Button (toggle)** pattern with **Toolbar**-style
 * roving navigation. Each item's pressed state is `aria-pressed` (the accessible
 * name never changes); the group is a single Tab stop. For strict mutually
 * exclusive selection with radio semantics, use
 * {@link RadioGroupController | Radio Group} instead.
 *
 * @remarks
 * Behavior only — the consumer styles off `[aria-pressed="true"]`. Per the
 * Toolbar model the arrow keys move **focus only**; activation is Space/Enter
 * (handled natively on `<button>` hosts, which synthesize a click).
 *
 * Behavior provided:
 * - Click (or Space/Enter) toggles an item. In `single` mode pressing one item
 *   releases the others (0 or 1 pressed); `multiple` allows any number.
 * - `ArrowRight`/`ArrowDown` move focus to the next item, `ArrowLeft`/`ArrowUp`
 *   to the previous (wrapping); `Home`/`End` to the first/last.
 * - `stimeo--toggle-group:change` is dispatched on every toggle.
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

  readonly #roving = new RovingTabindex(() => this.itemTargets);

  /** Establishes the roving entry point (first pressed item, else the first). */
  override connect(): void {
    const firstPressed = this.itemTargets.findIndex((item) => this.#isPressed(item));
    this.#roving.setActive(firstPressed === -1 ? 0 : firstPressed);
  }

  /** Toggles the activated item. Bound via `data-action` (click). */
  toggle(event: Event): void {
    this.#toggleIndex(this.itemTargets.indexOf(event.currentTarget as HTMLElement));
  }

  /** Arrow/Home/End move focus only; Space/Enter toggle non-button hosts. */
  onKeydown(event: KeyboardEvent): void {
    const current = this.itemTargets.indexOf(event.currentTarget as HTMLElement);
    if (current === -1) return;

    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = rovingMove(current, this.itemTargets.length, 1, "wrap");
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = rovingMove(current, this.itemTargets.length, -1, "wrap");
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = this.itemTargets.length - 1;
        break;
      case " ":
      case "Enter":
        // Native <button> hosts synthesize a click that drives #toggle; handling
        // the key here too would toggle twice. Only non-button hosts need it.
        if (event.currentTarget instanceof HTMLButtonElement) return;
        event.preventDefault();
        this.#toggleIndex(current);
        return;
      default:
        return;
    }

    event.preventDefault();
    this.#roving.setActive(next, { focus: true });
  }

  /** Applies the toggle at `index` per the current mode and dispatches `change`. */
  #toggleIndex(index: number): void {
    const item = this.itemTargets[index];
    if (!item) return;
    const willPress = !this.#isPressed(item);
    if (this.modeValue === "single") {
      this.itemTargets.forEach((other, i) => {
        this.#setPressed(other, i === index && willPress);
      });
    } else {
      this.#setPressed(item, willPress);
    }
    this.#roving.setActive(index);
    this.dispatch("change", {
      detail: { value: this.#itemValue(item), pressed: willPress, values: this.#pressedValues() },
    });
  }

  /** Whether an item is currently pressed. */
  #isPressed(item: HTMLElement): boolean {
    return item.getAttribute("aria-pressed") === "true";
  }

  /** Reflects the pressed state on `aria-pressed`. */
  #setPressed(item: HTMLElement, pressed: boolean): void {
    item.setAttribute("aria-pressed", pressed ? "true" : "false");
  }

  /** The `data-value` of every currently pressed item. */
  #pressedValues(): string[] {
    return this.itemTargets
      .filter((item) => this.#isPressed(item))
      .map((item) => this.#itemValue(item));
  }

  /** An item's value (`data-value`, defaulting to empty). */
  #itemValue(item: HTMLElement): string {
    return item.getAttribute("data-value") ?? "";
  }
}
