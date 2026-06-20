import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible inline-editing behavior.
 *
 * Markup contract (identifier: `stimeo--editable`):
 *   <div data-controller="stimeo--editable"
 *        data-stimeo--editable-submit-on-blur-value="true">
 *     <button type="button" aria-label="Edit title"
 *             data-stimeo--editable-target="display"
 *             data-action="click->stimeo--editable#edit
 *                          keydown->stimeo--editable#onDisplayKeydown">Current title</button>
 *     <input type="text" aria-label="Title" hidden
 *            data-stimeo--editable-target="input"
 *            data-action="keydown->stimeo--editable#onKeydown
 *                         blur->stimeo--editable#onBlur" />
 *   </div>
 *
 * There is no dedicated APG pattern; this implements a display ⇄ edit toggle with
 * focus management and keyboard commit/cancel, leaning on native form-control
 * labeling (WCAG 1.3.1 / 4.1.2). The look is the consumer's CSS, keyed off
 * `data-mode`.
 *
 * Behavior provided:
 * - Activating the display element (`Enter`/`Space` via the `<button>`, or `F2`)
 *   enters edit mode, focuses the input, and selects its text.
 * - `Enter` (single-line) or `Ctrl+Enter` / `Cmd+Enter` (multiline `<textarea>`)
 *   saves; `Escape` cancels. Both return focus to the display element.
 * - Losing focus while editing saves when `submitOnBlur` is true (the default),
 *   honoring wherever focus moved; when false, editing is kept.
 * - Saving dispatches `stimeo--editable:change` with `{ value, previous }` only
 *   when the value actually changed; cancelling dispatches
 *   `stimeo--editable:cancel`.
 */
export class EditableController extends Controller<HTMLElement> {
  static override targets = ["display", "input"];
  static override values = {
    submitOnBlur: { type: Boolean, default: true },
  };
  static actions = ["edit", "onBlur", "onDisplayKeydown", "onKeydown"] as const;
  static events = ["cancel", "change"] as const;

  declare readonly displayTarget: HTMLElement;
  declare readonly inputTarget: HTMLInputElement | HTMLTextAreaElement;
  declare readonly hasDisplayTarget: boolean;
  declare readonly hasInputTarget: boolean;

  declare submitOnBlurValue: boolean;

  /** The value captured when edit mode began, used to detect real changes. */
  #previousValue = "";

  /** Establishes the initial display mode (display shown, input hidden). */
  override connect(): void {
    this.#setMode("display");
  }

  /** Enters edit mode: seeds the input from the display text, focuses, selects. */
  edit(): void {
    if (this.#isEditing || !this.hasInputTarget || !this.hasDisplayTarget) return;
    this.#previousValue = this.#currentValue;
    this.inputTarget.value = this.#previousValue;
    this.#setMode("editing");
    this.inputTarget.focus();
    this.inputTarget.select();
  }

  /** Adds `F2` as an editing entry point alongside the button's native activation. */
  onDisplayKeydown(event: KeyboardEvent): void {
    if (event.key === "F2") {
      event.preventDefault();
      this.edit();
    }
  }

  /** Commits on `Enter` (or `Ctrl+Enter` when multiline) and cancels on `Escape`. */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.#cancel();
      return;
    }
    if (event.key === "Enter") {
      // A bare Enter inserts a newline in a textarea; only Ctrl+Enter (or Cmd+Enter on
      // macOS, the platform-conventional commit chord) saves there.
      if (this.#isMultiline && !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      this.#save(true);
    }
  }

  /** Saves on blur when `submitOnBlur` is set; otherwise keeps editing. */
  onBlur(): void {
    if (!this.#isEditing) return;
    if (this.submitOnBlurValue) this.#save(false);
  }

  /**
   * Returns to display mode, reflecting the input into the display text and
   * dispatching `change` when the value differs from where editing began.
   *
   * @param restoreFocus - Move focus back to the display element (explicit
   *   keyboard commit) rather than honoring the user's new focus target (blur).
   */
  #save(restoreFocus: boolean): void {
    if (!this.#isEditing) return;
    const value = this.inputTarget.value;
    const previous = this.#previousValue;
    this.displayTarget.textContent = value;
    this.#setMode("display");
    if (restoreFocus) this.displayTarget.focus();
    if (value !== previous) {
      this.dispatch("change", { detail: { value, previous } });
    }
  }

  /** Discards edits, returns to display mode, and dispatches `cancel`. */
  #cancel(): void {
    if (!this.#isEditing) return;
    this.#setMode("display");
    this.displayTarget.focus();
    this.dispatch("cancel", { detail: {} });
  }

  /** Toggles the `data-mode` flag and the `hidden` state of both elements. */
  #setMode(mode: "display" | "editing"): void {
    this.element.dataset.mode = mode;
    const editing = mode === "editing";
    if (this.hasDisplayTarget) this.displayTarget.hidden = editing;
    if (this.hasInputTarget) this.inputTarget.hidden = !editing;
  }

  /** Current display text, trimmed — the value shown when not editing. */
  get #currentValue(): string {
    return (this.displayTarget.textContent ?? "").trim();
  }

  /** Whether the editing control is a multi-line `<textarea>`. */
  get #isMultiline(): boolean {
    return this.inputTarget.tagName === "TEXTAREA";
  }

  /** Whether the controller is currently in edit mode. */
  get #isEditing(): boolean {
    return this.element.dataset.mode === "editing";
  }
}
