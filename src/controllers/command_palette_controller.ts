import { Controller } from "@hotwired/stimulus";
import { FocusTrap } from "../utils/focus_trap";

/**
 * Headless, highly accessible Command Palette behavior.
 *
 * Markup contract (identifier: `stimeo--command-palette`):
 *   <div data-controller="stimeo--command-palette"
 *        data-stimeo--command-palette-hotkey-value="mod+k">
 *     <div data-stimeo--command-palette-target="dialog" role="dialog"
 *          aria-modal="true" aria-label="Command palette"
 *          data-action="click->stimeo--command-palette#closeOnBackdrop" hidden>
 *       <input data-stimeo--command-palette-target="input" role="combobox"
 *              aria-expanded="false" aria-controls="cmdk-list"
 *              aria-autocomplete="list" aria-label="Search commands"
 *              data-action="input->stimeo--command-palette#filter
 *                           keydown->stimeo--command-palette#onKeydown" />
 *       <ul id="cmdk-list" data-stimeo--command-palette-target="list" role="listbox">
 *         <li id="cmd-new" role="option"
 *             data-stimeo--command-palette-target="option"
 *             data-action="click->stimeo--command-palette#selectByClick">New…</li>
 *         <li role="option" data-stimeo--command-palette-target="option"
 *             data-disabled="true">Section heading (shown but not selectable)</li>
 *       </ul>
 *       <p data-stimeo--command-palette-target="empty" hidden>No commands</p>
 *     </div>
 *   </div>
 *
 * Implements a composite **Dialog (Modal)** + **Combobox** (Listbox options) pattern.
 * A customizable global hotkey (Command/Ctrl + K) toggles it, focus is trapped
 * within the dialog, virtual focus roves via `aria-activedescendant`, and filtering
 * is performed in memory.
 *
 * @remarks
 * Behavior only. The combobox concerns (filtering, virtual focus, selection) live
 * here; the modal lifecycle — focus trap, scroll lock, background `inert`, focus
 * restore, and teardown reversal — is delegated to the shared {@link FocusTrap}
 * primitive (also used by dialog / alert-dialog / drawer). `Escape` closes and
 * `Tab`/`Shift+Tab` cycle focus regardless of which element inside the dialog holds
 * focus (input, close button, …), because the trap listens at the document level.
 * Styling, transitions, and the actual command handlers remain the consumer's.
 */
export class CommandPaletteController extends Controller<HTMLElement> {
  static override targets = ["dialog", "input", "list", "option", "empty"];
  static override values = {
    hotkey: { type: String, default: "mod+k" },
    open: { type: Boolean, default: false },
  };
  static actions = [
    "close",
    "closeOnBackdrop",
    "filter",
    "onKeydown",
    "open",
    "selectByClick",
    "toggle",
  ] as const;
  static events = ["select"] as const;

  declare readonly dialogTarget: HTMLElement;
  declare readonly inputTarget: HTMLInputElement;
  declare readonly listTarget: HTMLElement;
  declare readonly optionTargets: HTMLElement[];
  declare readonly emptyTarget: HTMLElement;

  declare readonly hasDialogTarget: boolean;
  declare readonly hasInputTarget: boolean;
  declare readonly hasListTarget: boolean;
  declare readonly hasEmptyTarget: boolean;

  declare hotkeyValue: string;
  declare openValue: boolean;

  /** The index of the currently active option within the visible subset. */
  #activeIndex = -1;

  /**
   * Owns the modal side effects (focus trap, scroll lock, background `inert`, focus
   * restore). Escape closes; focus on open goes to the input, and is restored to
   * whatever opened the palette on close.
   */
  readonly #trap = new FocusTrap(() => this.dialogTarget, {
    onEscape: () => this.close(),
    initialFocus: () => (this.hasInputTarget ? this.inputTarget : null),
  });

  /**
   * Initializes the global hotkey handler and establishes the initial open state.
   *
   * The DOM is the source of truth on reconnect (Turbo cache restore / morph): if
   * the restored snapshot already shows the dialog open, honor that rather than
   * re-deriving from the declarative `open` Value (which would slam a user-opened
   * palette shut). The `open` Value only seeds the initial state of a genuinely
   * fresh render. We normalize to a clean closed baseline first so {@link open}
   * runs its full setup — the {@link FocusTrap} is a fresh instance after a
   * reconnect and must be re-activated.
   */
  override connect(): void {
    document.addEventListener("keydown", this.#onGlobalKeydown);
    const shouldOpen = this.#isOpen || this.openValue;
    this.#resetToClosedState();
    if (shouldOpen) this.open();
  }

  /** Tears down the global hotkey listener and reverts the modal side effects. */
  override disconnect(): void {
    document.removeEventListener("keydown", this.#onGlobalKeydown);
    this.#trap.deactivate({ restoreFocus: false });
    this.#resetToClosedState();
  }

  /** Toggles the open state of the command palette. */
  toggle(): void {
    if (this.#isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /** Opens the palette, traps focus, and shifts focus to the input. */
  open(): void {
    if (!this.hasDialogTarget || this.#isOpen) return;
    this.dialogTarget.hidden = false;
    this.openValue = true;
    if (this.hasInputTarget) this.inputTarget.setAttribute("aria-expanded", "true");
    this.#resetFilter();
    this.#trap.activate();
  }

  /** Closes the palette and restores focus back to the opener. */
  close(): void {
    if (!this.hasDialogTarget || !this.#isOpen) return;
    this.#resetToClosedState();
    this.#trap.deactivate();
  }

  /** Filters option elements in-memory matching the input value. Bound to input target. */
  filter(): void {
    if (!this.hasInputTarget) return;
    const query = this.inputTarget.value.trim().toLowerCase();
    // Disabled options (e.g. group headings) may still be shown, but they do not
    // count toward the empty state and are never navigable/selectable.
    let hasSelectableMatch = false;

    for (const option of this.optionTargets) {
      const searchText = (option.dataset.searchValue || option.textContent || "")
        .trim()
        .toLowerCase();
      const matches = searchText.includes(query);

      if (matches) {
        option.removeAttribute("hidden");
        if (!this.#isDisabled(option)) hasSelectableMatch = true;
      } else {
        option.setAttribute("hidden", "true");
      }
    }

    if (this.hasEmptyTarget) {
      this.emptyTarget.hidden = hasSelectableMatch;
    }

    this.#setActiveIndex(hasSelectableMatch ? 0 : -1);
  }

  /** Selects the clicked option. Bound to option targets. */
  selectByClick(event: MouseEvent): void {
    const target = event.currentTarget as HTMLElement | null;
    if (!target) return;
    const option = target.closest("[role='option']") as HTMLElement | null;
    // Ignore clicks on disabled options (e.g. group headings) so they never fire select.
    if (option && !this.#isDisabled(option)) {
      this.#confirmSelection(option);
    }
  }

  /** Closes when the backdrop (the dialog target itself) is clicked, ignoring inner clicks. */
  closeOnBackdrop(event: MouseEvent): void {
    if (event.target === this.dialogTarget) this.close();
  }

  /**
   * Combobox navigation keys (arrows / Home / End / Enter), bound to the input.
   * `Tab` (focus trap) and `Escape` (close) are owned by the {@link FocusTrap} at
   * the document level, so they work no matter which element inside the dialog has
   * focus — not only the input.
   */
  onKeydown(event: KeyboardEvent): void {
    if (!this.#isOpen) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.#navigate(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.#navigate(-1);
        break;
      case "Home":
        event.preventDefault();
        this.#setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        this.#setActiveIndex(this.#visibleOptions.length - 1);
        break;
      case "Enter": {
        event.preventDefault();
        const activeOption = this.#visibleOptions[this.#activeIndex];
        if (activeOption) this.#confirmSelection(activeOption);
        break;
      }
    }
  }

  #navigate(direction: number): void {
    const visible = this.#visibleOptions;
    if (visible.length === 0) return;

    let newIndex = this.#activeIndex + direction;
    if (newIndex >= visible.length) newIndex = 0;
    if (newIndex < 0) newIndex = visible.length - 1;

    this.#setActiveIndex(newIndex);
  }

  #setActiveIndex(index: number): void {
    const visible = this.#visibleOptions;
    this.#activeIndex = index;

    visible.forEach((option, i) => {
      if (i === index) {
        option.setAttribute("aria-selected", "true");
        option.setAttribute("data-active", "true");
        if (this.hasInputTarget) {
          this.inputTarget.setAttribute("aria-activedescendant", option.id || "");
        }
        option.scrollIntoView({ block: "nearest" });
      } else {
        option.setAttribute("aria-selected", "false");
        option.removeAttribute("data-active");
      }
    });

    if (index === -1 && this.hasInputTarget) {
      this.inputTarget.removeAttribute("aria-activedescendant");
    }
  }

  #confirmSelection(option: HTMLElement): void {
    const value = option.dataset.value || option.textContent || "";
    this.dispatch("select", { detail: { value, option } });
    this.close();
  }

  #resetFilter(): void {
    if (this.hasInputTarget) this.inputTarget.value = "";
    for (const option of this.optionTargets) {
      option.removeAttribute("hidden");
    }
    if (this.hasEmptyTarget) this.emptyTarget.hidden = true;
    this.#setActiveIndex(0);
  }

  get #visibleOptions(): HTMLElement[] {
    // Only options that are both shown and not disabled are navigable/selectable.
    return this.optionTargets.filter(
      (option) => !option.hasAttribute("hidden") && !this.#isDisabled(option),
    );
  }

  #isDisabled(option: HTMLElement): boolean {
    return option.dataset.disabled === "true";
  }

  get #isOpen(): boolean {
    return this.hasDialogTarget && !this.dialogTarget.hidden;
  }

  readonly #onGlobalKeydown = (event: KeyboardEvent): void => {
    const hotkey = this.hotkeyValue.toLowerCase();
    const isMod = hotkey.includes("mod+");
    const key = hotkey.split("+").pop();

    if (!key) return;

    // "mod" accepts *either* Cmd or Ctrl so the documented "Cmd+K / Ctrl+K" works
    // on every platform — including Ctrl+K on macOS, not just Cmd+K. Without "mod",
    // the hotkey is a bare key that must be pressed with no Cmd/Ctrl held.
    const modPressed = isMod ? event.metaKey || event.ctrlKey : !event.metaKey && !event.ctrlKey;
    const keyMatch = event.key.toLowerCase() === key;

    if (modPressed && keyMatch) {
      event.preventDefault();
      this.toggle();
    }
  };

  /** Resets transient open state so reconnect starts from a predictable closed snapshot. */
  #resetToClosedState(): void {
    this.#activeIndex = -1;
    this.openValue = false;

    if (this.hasDialogTarget) {
      this.dialogTarget.hidden = true;
    }

    if (this.hasInputTarget) {
      this.inputTarget.setAttribute("aria-expanded", "false");
      this.inputTarget.removeAttribute("aria-activedescendant");
    }
  }
}
