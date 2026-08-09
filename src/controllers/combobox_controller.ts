import { Controller } from "@hotwired/stimulus";
import { syncActiveOption } from "../utils/active_option";
import { isReservedArrowChord } from "../utils/arrow_step";
import { CompositionTracker } from "../utils/composition_tracker";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { scrollOptionIntoView } from "../utils/option_scroll";

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

  /** Stable ID of the active option; the live element is resolved before every use. */
  #activeId: string | null = null;
  #connected = false;
  /** Collapses one mutation batch of target callbacks into a single pass. */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileOptions());
  /**
   * Suppresses {@link open} for the duration of the programmatic re-focus in
   * `#select`, so committing a value (which returns focus to the input)
   * does not immediately re-open the listbox via a `focus`-bound action.
   */
  #suppressOpen = false;
  /** Owns IME lifecycle state; confirmed text re-filters the list once. */
  readonly #composition = new CompositionTracker({ onEnd: () => this.filter() });

  /** Starts closed with no active option and registers the outside-click listener. */
  override connect(): void {
    if (this.hasInputTarget) this.#composition.observe(this.inputTarget);
    this.close();
    document.addEventListener("click", this.#onOutsideClick, true);
    this.#connected = true;
    this.#reconcile.activate();
  }

  /** Removes the document-level listener registered in {@link connect}. */
  override disconnect(): void {
    this.#connected = false;
    this.#reconcile.cancel();
    this.#composition.disconnect();
    document.removeEventListener("click", this.#onOutsideClick, true);
  }

  /** Tracks an input added initially or after connect. */
  inputTargetConnected(input: HTMLInputElement): void {
    this.#composition.observe(input);
    if (this.#connected) this.#queueOptionReconciliation();
  }

  /** Removes composition listeners when the active input is replaced or removed. */
  inputTargetDisconnected(input: HTMLInputElement): void {
    this.#composition.unobserve(input);
  }

  /** Establishes the active-state baseline, then reconciles a runtime addition. */
  optionTargetConnected(option: HTMLElement): void {
    option.setAttribute("aria-selected", "false");
    if (this.#connected) this.#queueOptionReconciliation();
  }

  /** Clears the disconnected node's active state, then reconciles the survivors. */
  optionTargetDisconnected(option: HTMLElement): void {
    option.setAttribute("aria-selected", "false");
    if (this.#connected) this.#queueOptionReconciliation();
  }

  /** Filters confirmed input text and opens the listbox. */
  filter(event?: InputEvent): void {
    if (this.#composition.isComposing(event)) return;
    this.open();
  }

  /**
   * Opens the listbox, re-filtering the options against the current input value
   * so the visible options and empty state always match what is typed (e.g.
   * re-opening with a stale non-matching value still surfaces the empty state).
   */
  open(): void {
    if (!this.hasListTarget || !this.hasInputTarget || this.#suppressOpen) return;
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

  /**
   * Closes the listbox, clears the active option, and updates ARIA state.
   *
   * Survives a missing input in both directions. {@link inputTargetConnected}
   * accepts an input added after connect, so dereferencing it here would abort
   * `connect()` before it registers the outside-click listener, and nothing
   * re-registers it later. Symmetrically, an input removed while the popup is
   * open must still let the popup come down — so hiding the list is
   * unconditional and only the ARIA half is guarded.
   */
  close(): void {
    if (!this.hasListTarget) return;
    this.listTarget.hidden = true;
    this.element.removeAttribute("data-stimeo--combobox-empty");
    if (this.hasInputTarget) this.inputTarget.setAttribute("aria-expanded", "false");
    this.#setActive(-1);
  }

  /** Routes keyboard interaction per the APG combobox model. */
  onKeydown(event: KeyboardEvent): void {
    // Ignore keys fired during IME composition: the `Enter` that confirms a
    // candidate (and arrows that move within it) must not select an option or
    // close the popup. Controller-owned lifecycle state covers confirming events
    // that omit the standard per-event signal.
    if (this.#composition.isComposing(event)) return;
    // A widget that already claimed the key (an enclosing composite consuming
    // arrows, a descendant editor) must not ALSO move the active option, commit
    // one, or drop the popup — composition depends on this yield.
    if (event.defaultPrevented) return;
    // A chorded arrow is the browser's, except the Alt+Down/Up this pattern
    // claims below. "Someone already consumed it" outranks it, so it is checked
    // after the yield above.
    if (isReservedArrowChord(event, ["alt"])) return;
    // The two chords the pattern claims. `Alt+Down` shows the popup *without*
    // moving focus into it, and `Alt+Up` returns focus and closes — which is
    // what separates them from the bare arrows below, where the point is to
    // move the active option.
    if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      // Each chord is bound in one popup state only. In the other state the
      // pattern defines nothing, so the press stays the browser's rather than
      // being swallowed on a no-op.
      if (event.key === "ArrowDown" ? !this.#isClosed : this.#isClosed) return;
      event.preventDefault();
      if (event.key === "ArrowDown") {
        this.open();
      } else {
        // The popup never holds DOM focus here (the active option is virtual, via
        // aria-activedescendant), so "return focus to the combobox" is already
        // true and closing is the whole action. Calling focus() would re-trigger
        // the focus-bound open().
        this.close();
      }
      return;
    }
    if (!this.#isClosed) this.#reconcileActive();
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        // open() re-filters, so read the visible set afterwards.
        if (this.#isClosed) this.open();
        const visible = this.#visibleOptions();
        if (visible.length > 0) {
          const activeIndex = this.#findActiveIndex(visible);
          const next = activeIndex === -1 ? 0 : (activeIndex + 1) % visible.length;
          this.#setActive(next);
        }
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        if (this.#isClosed) this.open();
        const visible = this.#visibleOptions();
        if (visible.length > 0) {
          const activeIndex = this.#findActiveIndex(visible);
          // From the input (no active option) ArrowUp jumps to the last option,
          // per the APG; otherwise it wraps backwards.
          const next =
            activeIndex === -1
              ? visible.length - 1
              : (activeIndex - 1 + visible.length) % visible.length;
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
        const activeIndex = this.#findActiveIndex(visible);
        const active = activeIndex === -1 ? undefined : visible[activeIndex];
        if (active) {
          event.preventDefault();
          this.#select(active);
        }
        break;
      }
      case "Escape":
        // A press an inner handler already owned is yielded at the top of this
        // handler. Escape is consumed only while the list is open: with it closed
        // the press stays free for the shared resolver, so an enclosing dialog
        // still closes from a focused input.
        if (this.#isClosed) break;
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
    if (option && this.optionTargets.includes(option)) this.#select(option);
  }

  /**
   * Commits an option: fills the input, closes the listbox, notifies listeners.
   *
   * An input removed while the popup is open leaves the options clickable, and
   * {@link close} already survives that state. Selection does too: the popup
   * comes down and listeners still hear the choice, with only the field-bound
   * half — the value write, the focus return, and the native `change` — skipped,
   * because there is no field to carry them.
   */
  #select(option: HTMLElement): void {
    const value = option.dataset.value ?? (option.textContent ?? "").trim();
    if (!this.hasInputTarget) {
      this.close();
      this.dispatch("selected", { detail: { value } });
      return;
    }
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
    const visible = this.#visibleOptions();
    const active = index === -1 ? null : (visible[index] ?? null);
    // The full target set, not just the visible ones: an option hidden by
    // filtering while active would otherwise keep a stale selected state.
    syncActiveOption(this.optionTargets, active);
    this.#activeId = active?.id || null;
    if (this.hasInputTarget) {
      if (active?.id) {
        this.inputTarget.setAttribute("aria-activedescendant", active.id);
      } else {
        this.inputTarget.removeAttribute("aria-activedescendant");
      }
    }
    // Virtual focus never triggers the browser's native focus-scrolling, so a
    // scrollable list must follow the active option itself (list-only scroll).
    if (active && this.hasListTarget) scrollOptionIntoView(this.listTarget, active);
  }

  /** Re-applies filtering and active state after a target collection change. */
  #reconcileOptions(): void {
    if (this.hasInputTarget && !this.#isClosed) this.#applyFilter();
    this.#reconcileActive();
    this.#reflectEmptyState();
  }

  /** Preserves a surviving active ID; disappearance deliberately clears active state. */
  #reconcileActive(): void {
    if (!this.hasInputTarget || this.#isClosed) {
      this.#setActive(-1);
      return;
    }
    const visible = this.#visibleOptions();
    const index = this.#findActiveIndex(visible);
    const active = index === -1 ? null : (visible[index] ?? null);
    const selected = this.optionTargets.filter(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    const idref = this.inputTarget.getAttribute("aria-activedescendant");
    const stateMatches = active
      ? this.#activeId === (active.id || null) &&
        selected.length === 1 &&
        selected[0] === active &&
        idref === (active.id || null)
      : this.#activeId === null && selected.length === 0 && idref === null;
    if (!stateMatches) this.#setActive(index);
  }

  /** Resolves the stable ID, with `aria-selected` as the ID-less compatibility marker. */
  #findActiveIndex(options: readonly HTMLElement[]): number {
    const activeId =
      (this.hasInputTarget ? this.inputTarget.getAttribute("aria-activedescendant") : null) ??
      this.#activeId;
    if (activeId) return options.findIndex((option) => option.id === activeId);
    return options.findIndex((option) => option.getAttribute("aria-selected") === "true");
  }

  /** Coalesces all target callbacks from one MutationObserver batch. */
  #queueOptionReconciliation(): void {
    this.#reconcile.schedule();
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
