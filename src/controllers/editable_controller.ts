import { Controller } from "@hotwired/stimulus";
import { CompositionTracker } from "../utils/composition_tracker";

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
 *            data-action="keydown->stimeo--editable#onKeydown" />
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
 *   saves; `Escape` cancels. Both return focus to the display element. Keys
 *   pressed during an IME composition act on the composition, never the edit:
 *   a conversion-cancelling `Escape` keeps editing and a conversion-confirming
 *   `Enter` never saves (lifecycle-tracked, covering events that omit
 *   `isComposing`).
 * - Losing focus while editing saves when `submitOnBlur` is true (the default),
 *   honoring wherever focus moved. The departure is watched on the controller
 *   element, so it is seen from wherever focus sat — the input, or a Save or
 *   Cancel button beside it — and no per-control wiring is required. Focus
 *   landing on another element inside this controller has not left the edit, so
 *   it commits nothing. When `submitOnBlur` is false, editing is kept.
 * - `save()`, `cancel()`, and `revert()` are actions, so a pointer-only user
 *   reaches every path a keyboard user does. `revert()` restores the value from
 *   before the last save once, for a consumer whose server rejected it.
 * - Saving dispatches `stimeo--editable:change` with `{ value, previous }` only
 *   when the value actually changed; cancelling dispatches
 *   `stimeo--editable:cancel` with an empty `{}` detail.
 *
 * The value is whatever the display element declares. A `data-value` attribute
 * holds it when the element's text is a rendering of the value rather than the
 * value itself — a formatted date, a grouped number, an icon beside a label.
 * Without that attribute the trimmed text is the value, and it must then be a
 * string the editing control accepts: `<input type="date">` keeps `2026-08-23`
 * but sanitizes `August 23, 2026` away to an empty string. Saving updates
 * whichever of the two carries the value, so a rendered display keeps its markup
 * and the consumer re-renders it from the `change` event.
 */
export class EditableController extends Controller<HTMLElement> {
  static override targets = ["display", "input"];
  static override values = {
    submitOnBlur: { type: Boolean, default: true },
  };
  static actions = ["cancel", "edit", "onDisplayKeydown", "onKeydown", "revert", "save"] as const;
  static events = ["cancel", "change"] as const;

  declare readonly displayTarget: HTMLElement;
  declare readonly inputTarget: HTMLInputElement | HTMLTextAreaElement;
  declare readonly hasDisplayTarget: boolean;
  declare readonly hasInputTarget: boolean;

  declare submitOnBlurValue: boolean;

  /** The value captured when edit mode began, used to detect real changes. */
  #previousValue = "";

  /**
   * The value the last save replaced, or `null` when there is nothing to undo.
   * Cleared on connect: a value from before a page restore is unrecoverable, so
   * `revert()` must not resurrect one.
   */
  #revertValue: string | null = null;

  /**
   * Owns IME lifecycle state for the edit surface, so a keydown that belongs to
   * a composition (cancel or confirm) is never treated as an edit command.
   */
  readonly #composition = new CompositionTracker();

  /**
   * Watches focus leaving the editor from wherever it currently sits.
   *
   * `focusout` bubbles where `blur` does not, so one listener on the root sees
   * every departure — including one from a Save or Cancel button the consumer
   * placed beside the input. Binding the input alone would make the promise
   * "saves wherever focus moved" true only for focus that leaves the input
   * itself, and tabbing straight past an inner button would strand the editor
   * open.
   */
  readonly #onFocusOut = (event: FocusEvent): void => {
    // Entering edit mode hides the display element, and hiding the element that
    // holds focus reports a departure with nowhere to go. That hand-off is the
    // edit starting, not the user leaving it, and the input is focused moments
    // later in the same task. The display is hidden for the whole edit, so it
    // can never be the source of a real departure from one.
    const from = event.target;
    if (this.hasDisplayTarget && from instanceof Node && this.displayTarget.contains(from)) return;
    // Focus reaching another element inside this controller has not left the
    // edit. Without this the commit would beat an inner button's own click —
    // and a Cancel button would save what it promises to discard.
    const next = event.relatedTarget;
    if (next instanceof Node && this.element.contains(next)) return;
    if (this.submitOnBlurValue) this.#commit(false);
  };

  /** Establishes the initial display mode (display shown, input hidden). */
  override connect(): void {
    // The tracker is idempotent, so observing here and in the target callback
    // keeps IME tracking correct whichever of the two the framework runs first.
    if (this.hasInputTarget) this.#composition.observe(this.inputTarget);
    this.element.addEventListener("focusout", this.#onFocusOut);
    this.#revertValue = null;
    this.#setMode("display");
  }

  /** Releases the composition and focus listeners so nothing outlives the element. */
  override disconnect(): void {
    this.#composition.disconnect();
    this.element.removeEventListener("focusout", this.#onFocusOut);
  }

  /** Tracks an input added initially or after connect (e.g. a Turbo swap). */
  inputTargetConnected(input: HTMLElement): void {
    this.#composition.observe(input);
    this.#applyMode();
  }

  /** Removes composition listeners when the active input is replaced or removed. */
  inputTargetDisconnected(input: HTMLElement): void {
    this.#composition.unobserve(input);
  }

  /** Re-hides or re-shows a display element that arrived after the mode was set. */
  displayTargetConnected(): void {
    this.#applyMode();
  }

  /** Enters edit mode: seeds the input from the declared value, focuses, selects. */
  edit(): void {
    if (this.#isEditing || !this.hasInputTarget || !this.hasDisplayTarget) return;
    this.#previousValue = this.#currentValue;
    this.inputTarget.value = this.#previousValue;
    this.#setMode("editing");
    this.inputTarget.focus();
    this.inputTarget.select();
  }

  /** Commits the edit and returns focus to the display element. */
  save(): void {
    this.#commit(true);
  }

  /** Discards edits, returns to display mode, and dispatches `cancel`. */
  cancel(): void {
    if (!this.#isEditing) return;
    this.#setMode("display");
    if (this.hasDisplayTarget) this.displayTarget.focus();
    this.dispatch("cancel", { detail: {} });
  }

  /**
   * Puts back the value the last save replaced — for a consumer whose server
   * rejected it. Silent by design: a `change` here would re-enter the same
   * handler that asked for the undo. One save, one undo.
   */
  revert(): void {
    if (this.#revertValue === null || this.#isEditing) return;
    this.#writeValue(this.#revertValue);
    this.#revertValue = null;
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
    // Keys fired during IME composition steer the composition (cancel a
    // conversion, confirm a candidate) and must never cancel or save the edit.
    if (this.#composition.isComposing(event)) return;
    if (event.key === "Escape") {
      // Leave a press an inner handler already owned.
      if (event.defaultPrevented) return;
      event.preventDefault();
      this.cancel();
      return;
    }
    if (event.key === "Enter") {
      // A descendant widget that already claimed the key (a completion popup
      // confirming its candidate) must not ALSO commit the edit — composition
      // depends on this yield. Kept separate from the Escape guard above, which
      // answers a different question: who owns an Escape press.
      if (event.defaultPrevented) return;
      // A bare Enter inserts a newline in a textarea; only Ctrl+Enter (or Cmd+Enter on
      // macOS, the platform-conventional commit chord) saves there.
      if (this.#isMultiline && !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      this.#commit(true);
    }
  }

  /**
   * Returns to display mode, storing the input's value and dispatching `change`
   * when it differs from where editing began.
   *
   * @param restoreFocus - Move focus back to the display element (explicit
   *   commit) rather than honoring the user's new focus target (blur).
   */
  #commit(restoreFocus: boolean): void {
    if (!this.#isEditing || !this.hasInputTarget) return;
    // One normalization for all three consumers below, so the stored value, the
    // comparison, and the detail can never disagree about what was saved.
    const value = this.inputTarget.value.trim();
    const previous = this.#previousValue;
    this.#writeValue(value);
    this.#setMode("display");
    if (restoreFocus && this.hasDisplayTarget) this.displayTarget.focus();
    if (value !== previous) {
      this.#revertValue = previous;
      this.dispatch("change", { detail: { value, previous } });
    }
  }

  /** Stores `value` wherever the display element declares it. */
  #writeValue(value: string): void {
    if (!this.hasDisplayTarget) return;
    const display = this.displayTarget;
    // Text that renders the value is the consumer's to compose; overwriting it
    // with the raw value would destroy a rendering this controller cannot rebuild.
    if (display.hasAttribute("data-value")) display.dataset.value = value;
    else display.textContent = value;
  }

  /** Derives both elements' visibility from the mode currently in the DOM. */
  #applyMode(): void {
    const editing = this.#isEditing;
    if (this.hasDisplayTarget) this.displayTarget.hidden = editing;
    if (this.hasInputTarget) this.inputTarget.hidden = !editing;
  }

  /** Records the mode, then brings both elements in line with it. */
  #setMode(mode: "display" | "editing"): void {
    this.element.dataset.mode = mode;
    this.#applyMode();
  }

  /** The value the display element declares, trimmed. */
  get #currentValue(): string {
    const display = this.displayTarget;
    return (display.dataset.value ?? display.textContent ?? "").trim();
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
