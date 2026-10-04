import { Controller } from "@hotwired/stimulus";
import { actionSource } from "../utils/action_source";
import { syncActiveOption } from "../utils/active_option";
import { isReservedArrowChord } from "../utils/arrow_step";
import { AttributeLease } from "../utils/attribute_lease";
import { CompositionTracker } from "../utils/composition_tracker";
import { FocusTrap } from "../utils/focus_trap";
import { LivedMark } from "../utils/lived_mark";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import type { StateReason } from "../utils/state_reason";
import { targetSelector } from "../utils/target_selector";

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
 *         <li id="cmd-new" role="option" data-stimeo--command-palette-target="option"
 *             data-action="click->stimeo--command-palette#select">New…</li>
 *         <li id="cmd-heading" role="option" data-stimeo--command-palette-target="option"
 *             data-disabled="true">Disabled command (shown but not selectable)</li>
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
 * `select` dispatches `{ value: string, option: HTMLElement }`.
 *
 * @remarks
 * Behavior only. The combobox concerns (filtering, virtual focus, selection) live
 * here; the modal lifecycle — focus trap, scroll lock, background `inert`, focus
 * restore, and teardown reversal — is delegated to the shared `FocusTrap`
 * primitive (also used by dialog / alert-dialog / drawer). `Escape` closes and
 * `Tab`/`Shift+Tab` cycle focus regardless of which element inside the dialog holds
 * focus (input, close button, …), because the trap listens at the document level.
 * IME composition is tracked from start to end: intermediate input does not filter,
 * and conversion-confirming keys never select a command. Styling, transitions, and
 * the actual command handlers remain the consumer's. A Turbo morph that puts the
 * server's markup back over the palette is answered by writing the palette back: an
 * open palette stays open with its query's matches and its active option.
 */
export class CommandPaletteController extends Controller<HTMLElement> {
  static readonly #ORIGINAL_ARIA_DISABLED = "data-command-palette-original-aria-disabled";
  static readonly #ABSENT_ARIA_DISABLED = "absent";

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
    "select",
    "toggle",
  ] as const;
  static events = ["select"] as const;

  declare readonly dialogTarget: HTMLElement;
  declare readonly dialogTargets: HTMLElement[];
  declare readonly inputTarget: HTMLInputElement;
  declare readonly inputTargets: HTMLInputElement[];
  declare readonly listTarget: HTMLElement;
  declare readonly optionTargets: HTMLElement[];
  declare readonly emptyTarget: HTMLElement;
  declare readonly emptyTargets: HTMLElement[];

  declare readonly hasDialogTarget: boolean;
  declare readonly hasInputTarget: boolean;
  declare readonly hasListTarget: boolean;
  declare readonly hasEmptyTarget: boolean;

  declare hotkeyValue: string;
  declare openValue: boolean;

  /** Stable ID of the active option; the live target is resolved before every use. */
  #activeId: string | null = null;
  /** Visible/selectable target ID order captured for removal fallback. */
  #activeOrder: string[] = [];
  #connected = false;
  /**
   * Marks the element at each connection and tells a new instance on a copy of the page Turbo
   * restores from its cache from a fresh render and from a reconnect of this instance.
   */
  readonly #lived = new LivedMark(this.identifier);
  /** The dialog the open state was last applied to. */
  #dialog: HTMLElement | null = null;
  /** Borrows `hidden` on the dialog and the empty region, to give back when one stops being a target. */
  readonly #hidden = new AttributeLease<HTMLElement>("hidden", this.identifier);
  /** Borrows `aria-expanded` on the input, to give back when an element stops being the input. */
  readonly #expanded = new AttributeLease<HTMLElement>("aria-expanded", this.identifier);
  /** Borrows `aria-activedescendant` on the input, for the same return. */
  readonly #activeDescendant = new AttributeLease<HTMLElement>(
    "aria-activedescendant",
    this.identifier,
  );
  /** One pass per batch of target callbacks: `aria-expanded`, then the active option. */
  readonly #reconcile = new MicrotaskCoalescer(() => {
    if (this.hasInputTarget) this.#expanded.write(this.inputTarget, String(this.#isOpen));
    this.#reconcileActive();
  });

  /** Writes the palette back after a Turbo morph put the server's markup in its place. */
  readonly #morphRender = new MorphRenderWatcher(() => this.#repair());

  /** Owns IME lifecycle state; confirmed text re-filters an open palette once. */
  readonly #composition = new CompositionTracker({
    onEnd: () => {
      if (this.#isOpen) this.filter();
    },
  });

  /**
   * Owns the modal side effects (focus trap, scroll lock, background `inert`, focus
   * restore). Escape closes; focus on open goes to the first input inside the dialog the
   * trap is taken on, and is restored to whatever opened the palette on close.
   */
  readonly #trap = new FocusTrap(() => this.dialogTarget, {
    onEscape: () => this.close(),
    initialFocus: () => {
      const dialog = this.dialogTarget;
      return this.inputTargets.find((input) => dialog.contains(input)) ?? null;
    },
  });

  /**
   * Initializes the global hotkey handler and establishes the initial open state.
   *
   * A dialog the server renders without `hidden` opens, and so does an `open` Value of
   * `true`, which only seeds that first render. A reconnect of this instance (an in-page
   * move, a permanent element carried to the next page) keeps an open palette open, its
   * query and active option included, and takes the `FocusTrap` again. A copy of the page
   * Turbo restores from its cache comes back closed, whatever opened the palette — the
   * server's markup, the `open` Value or the user — and the `open` Value is written
   * `false`: every connection leaves `data-<identifier>-lived` on the element, a copy
   * carries it, and a new instance that finds it is on such a copy. Otherwise the baseline
   * is normalized closed first, so {@link CommandPaletteController.open | open} runs its
   * full setup.
   */
  override connect(): void {
    const connection = this.#lived.connect(this.element);
    this.#trap.connect();
    document.addEventListener("keydown", this.#onGlobalKeydown);
    if (this.hasInputTarget) this.#composition.observe(this.inputTarget);
    this.#syncOptionSemantics();
    if (connection === "reconnect" && this.#isOpen) {
      this.#trap.activate();
    } else {
      const shouldOpen = connection !== "restored" && (this.#isOpen || this.openValue);
      this.#resetToClosedState();
      if (shouldOpen) this.open();
    }
    this.#dialog = this.hasDialogTarget ? this.dialogTarget : null;
    this.#connected = true;
    this.#reconcile.activate();
    this.#morphRender.observe(this.element);
  }

  /**
   * Tears down the global hotkey listener and reverts the modal side effects. The open
   * state stays on the element: an in-page move reconnects this instance onto it, and a
   * restored copy of the page is closed by the instance that connects to it.
   */
  override disconnect(): void {
    this.#connected = false;
    this.#lived.disconnect();
    this.#morphRender.disconnect();
    this.#reconcile.cancel();
    document.removeEventListener("keydown", this.#onGlobalKeydown);
    this.#composition.disconnect();
    this.#trap.disconnect(this);
  }

  /** Initializes semantics for an option added before or after the controller connects. */
  optionTargetConnected(option: HTMLElement): void {
    this.#syncOptionSemanticsFor(option);
    // A newly-arrived option starts inactive. Set explicitly rather than relying
    // on the semantics sync, which does not own `aria-selected` — an option added
    // mid-session would otherwise carry whatever the author wrote, and a stray
    // `"true"` would read as a second active one until the next move.
    option.setAttribute("aria-selected", "false");
    option.removeAttribute("data-active");
    if (this.#connected) this.#queueOptionReconciliation();
  }

  /** Clears active residue on the old node and reconciles the surviving targets. */
  optionTargetDisconnected(option: HTMLElement): void {
    option.setAttribute("aria-selected", "false");
    option.removeAttribute("data-active");
    if (this.#connected) this.#queueOptionReconciliation();
  }

  /** Tracks an input added initially or after connect without extra consumer actions. */
  inputTargetConnected(input: HTMLInputElement): void {
    this.#composition.observe(input);
    if (this.#connected) this.#queueOptionReconciliation();
  }

  /**
   * Removes composition listeners, gives an input that no longer resolves as one back its
   * `aria-expanded` and `aria-activedescendant` — after `disconnect()` too, since dropping
   * the identifier leaves the element on the page — and reconciles the input that stays.
   */
  inputTargetDisconnected(input: HTMLInputElement): void {
    this.#composition.unobserve(input);
    if (!this.inputTargets.includes(input)) {
      this.#expanded.return(input);
      this.#activeDescendant.return(input);
    }
    this.#queueOptionReconciliation();
  }

  /** Applies the open state to a dialog that arrives after connect in front of the others. */
  dialogTargetConnected(): void {
    if (this.#connected) this.#adoptDialog();
  }

  /**
   * Gives a dialog that no longer resolves as the target its own `hidden` back — after
   * `disconnect()` too, since dropping the identifier leaves the element on the page — and,
   * while connected, applies the open state to the dialog left.
   */
  dialogTargetDisconnected(dialog: HTMLElement): void {
    if (this.dialogTargets.includes(dialog)) return;
    this.#hidden.return(dialog);
    if (this.#connected) this.#adoptDialog();
  }

  /** Reflects the empty state onto a region that arrives after connect. */
  emptyTargetConnected(): void {
    this.#queueOptionReconciliation();
  }

  /**
   * Gives a region that no longer resolves as the target its own `hidden` back, after
   * `disconnect()` too, and reflects the empty state onto the region left.
   */
  emptyTargetDisconnected(empty: HTMLElement): void {
    if (!this.emptyTargets.includes(empty)) this.#hidden.return(empty);
    this.#queueOptionReconciliation();
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
    this.#hidden.write(this.dialogTarget, null);
    this.openValue = true;
    if (this.hasInputTarget) this.#expanded.write(this.inputTarget, "true");
    this.#resetFilter();
    this.#trap.activate();
  }

  /** Closes the palette and restores focus back to the opener. */
  close(): void {
    this.#close(true);
  }

  /**
   * Applies the open state to the dialog that is now first, when that dialog changed. An
   * open palette moves its modal trap onto it, keeping the trap's place among the page's
   * modals and the opener focus returns to; focus moves inside unless it is already there or
   * a modal opened over this one takes `Tab`. An open palette left with no dialog closes,
   * `open` included.
   */
  #adoptDialog(): void {
    const dialog = this.hasDialogTarget ? this.dialogTarget : null;
    if (dialog === this.#dialog) return;
    this.#dialog = dialog;
    if (!this.#trap.active) {
      if (dialog) this.#hidden.write(dialog, "");
      return;
    }
    if (!dialog) {
      this.#resetToClosedState();
      this.#trap.deactivate();
      return;
    }
    this.#hidden.write(dialog, null);
    this.#trap.refreshContainer();
  }

  /** Releases the modal resources, optionally restoring the opener's focus. */
  #close(restoreFocus: boolean): void {
    if (!this.hasDialogTarget || !this.#isOpen) return;
    this.#resetToClosedState();
    this.#trap.deactivate({ restoreFocus });
  }

  /** Filters option elements in-memory matching the input value. Bound to input target. */
  filter(event?: InputEvent): void {
    // Match the library's Character Counter policy: do not react to intermediate
    // pre-conversion text. `compositionend` applies the confirmed query once.
    if (!this.hasInputTarget || this.#composition.isComposing(event)) return;
    this.#setActiveIndex(this.#applyQuery() ? 0 : -1);
  }

  /**
   * Shows the options that match the input's query, hides the rest and reflects the empty
   * state; says whether a match can be run.
   */
  #applyQuery(): boolean {
    const query = this.inputTarget.value.trim().toLowerCase();
    // `data-disabled` options (e.g. group headings) may still be shown, but they
    // do not count toward the empty state and are never navigable. An authored
    // `aria-disabled` counts and is navigable — only its activation is refused.
    let hasSelectableMatch = false;

    for (const option of this.optionTargets) {
      const searchText = (option.dataset.searchValue || option.textContent || "")
        .trim()
        .toLowerCase();
      const matches = searchText.includes(query);

      if (matches) {
        option.removeAttribute("hidden");
        // A match the user can see counts, even when it cannot be run: hiding the
        // list behind an empty state would deny that the command exists at all.
        if (this.#isNavigable(option)) hasSelectableMatch = true;
      } else {
        option.setAttribute("hidden", "true");
      }
    }

    if (this.hasEmptyTarget) {
      this.#hidden.write(this.emptyTarget, hasSelectableMatch ? "" : null);
    }
    return hasSelectableMatch;
  }

  /**
   * Writes the palette back over the server's markup a Turbo morph put in its place: the
   * dialog shown while the trap is active and hidden otherwise and, while open, the matches
   * of the query the input still holds. The reconcile pass it schedules puts `aria-expanded`,
   * the option semantics and the active option back.
   */
  #repair(): void {
    if (!this.hasDialogTarget) return;
    const open = this.#trap.active;
    this.#hidden.write(this.dialogTarget, open ? null : "");
    if (open && this.hasInputTarget) this.#applyQuery();
    this.#reconcile.schedule();
  }

  /** Selects an owned option or descendant; API calls preserve external focus. */
  select(source: Event | HTMLElement): void {
    const { event, host, origin, reason } = actionSource(source);
    if (origin && origin.closest(`[data-controller~="${this.identifier}"]`) !== this.element)
      return;
    const option = host?.closest<HTMLElement>(targetSelector(this.identifier, "option"));
    if (!option || !this.optionTargets.includes(option)) return;
    this.#syncOptionSemanticsFor(option);
    // Ignore clicks on disabled options (e.g. group headings) so they never fire select.
    if (!option.hasAttribute("hidden") && !this.#isDisabled(option)) {
      this.#confirmSelection(
        option,
        reason,
        event !== null || this.element.contains(document.activeElement),
      );
    }
  }

  /** Closes when the backdrop (the dialog target itself) is clicked, ignoring inner clicks. */
  closeOnBackdrop(event: MouseEvent): void {
    if (event.target === this.dialogTarget) this.close();
  }

  /**
   * Combobox navigation keys (arrows / Home / End / Enter), bound to the input.
   * `Tab` (focus trap) and `Escape` (close) are owned by the shared `FocusTrap` at
   * the document level, so they work no matter which element inside the dialog has
   * focus — not only the input.
   */
  onKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key (a grabbed drag handle, a
    // nested menu) must not ALSO act on it — composition depends on this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    // Composition-confirming Enter must stay with the IME instead of selecting a
    // command. Controller-owned lifecycle state covers events that omit isComposing.
    if (this.#composition.isComposing(event) || !this.#isOpen) return;
    this.#reconcileActive();

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
        const visible = this.#visibleOptions;
        const activeIndex = this.#findActiveIndex(visible);
        const activeOption = activeIndex < 0 ? undefined : visible[activeIndex];
        if (activeOption) this.#confirmSelection(activeOption);
        break;
      }
    }
  }

  #navigate(direction: number): void {
    const visible = this.#visibleOptions;
    if (visible.length === 0) return;

    let newIndex = this.#findActiveIndex(visible) + direction;
    if (newIndex >= visible.length) newIndex = 0;
    if (newIndex < 0) newIndex = visible.length - 1;

    this.#setActiveIndex(newIndex);
  }

  #setActiveIndex(index: number): void {
    this.#syncOptionSemantics();
    const visible = this.#visibleOptions;
    const activeOption = visible[index] ?? null;

    syncActiveOption(this.optionTargets, activeOption);
    // `data-active` is a styling hook, not ARIA, so it stays here. It carries the
    // literal value `"true"` (not a bare attribute) because the reconciliation
    // path compares against it, so `toggleAttribute` — which writes `""` — would
    // change what a same-id replacement reads back.
    for (const option of this.optionTargets) {
      if (option === activeOption) option.setAttribute("data-active", "true");
      else option.removeAttribute("data-active");
    }

    if (activeOption) {
      activeOption.scrollIntoView({ block: "nearest" });
    }

    this.#activeId = activeOption?.id || null;
    this.#activeOrder = activeOption ? visible.map((option) => option.id).filter(Boolean) : [];

    if (this.hasInputTarget) {
      this.#activeDescendant.write(this.inputTarget, activeOption?.id || null);
    }
  }

  /** Re-resolves active identity and component-specific fallback against live targets. */
  #reconcileActive(): void {
    if (!this.#isOpen) {
      this.#setActiveIndex(-1);
      this.#reflectEmptyState();
      return;
    }

    const visible = this.#visibleOptions;
    const currentIndex = this.#findActiveIndex(visible);
    if (currentIndex >= 0) {
      const active = visible[currentIndex] ?? null;
      const options = this.optionTargets;
      const marked = options.filter((option) => option.hasAttribute("data-active"));
      const selected = options.filter((option) => option.getAttribute("aria-selected") === "true");
      const stateMatches =
        this.#activeId === (active?.id || null) &&
        marked.length === 1 &&
        marked[0] === active &&
        selected.length === 1 &&
        selected[0] === active &&
        (!this.hasInputTarget ||
          this.inputTarget.getAttribute("aria-activedescendant") === (active?.id || null));

      if (stateMatches) {
        // Refresh the fallback order after target churn without invoking
        // scrollIntoView for an option whose active state is already coherent.
        this.#activeOrder = visible.map((option) => option.id).filter(Boolean);
      } else {
        this.#setActiveIndex(currentIndex);
      }
      this.#reflectEmptyState();
      return;
    }

    const activeId =
      (this.hasInputTarget ? this.inputTarget.getAttribute("aria-activedescendant") : null) ??
      this.#activeId;
    this.#setActiveIndex(activeId ? this.#findFallbackIndex(visible, activeId) : -1);
    this.#reflectEmptyState();
  }

  /** Resolves stable ID first, then active markers for the existing ID-less case. */
  #findActiveIndex(options: readonly HTMLElement[]): number {
    const activeId =
      (this.hasInputTarget ? this.inputTarget.getAttribute("aria-activedescendant") : null) ??
      this.#activeId;
    if (activeId) return options.findIndex((option) => option.id === activeId);
    return options.findIndex(
      (option) =>
        option.hasAttribute("data-active") || option.getAttribute("aria-selected") === "true",
    );
  }

  /** Chooses a surviving former successor, then predecessor, from selectable targets only. */
  #findFallbackIndex(options: readonly HTMLElement[], activeId: string): number {
    const oldIndex = this.#activeOrder.indexOf(activeId);
    if (oldIndex < 0) return -1;
    const indexesById = new Map(options.map((option, index) => [option.id, index]));
    for (let index = oldIndex + 1; index < this.#activeOrder.length; index += 1) {
      const fallback = indexesById.get(this.#activeOrder[index] ?? "");
      if (fallback !== undefined) return fallback;
    }
    for (let index = oldIndex - 1; index >= 0; index -= 1) {
      const fallback = indexesById.get(this.#activeOrder[index] ?? "");
      if (fallback !== undefined) return fallback;
    }
    return -1;
  }

  /** Reflects whether any visible, navigable command remains. */
  #reflectEmptyState(): void {
    if (this.hasEmptyTarget) {
      this.#hidden.write(this.emptyTarget, this.#visibleOptions.length > 0 ? "" : null);
    }
  }

  /** Coalesces all target callbacks from one MutationObserver batch. */
  #queueOptionReconciliation(): void {
    this.#reconcile.schedule();
  }

  /**
   * Runs `option`: dispatches `select` and closes.
   *
   * **Activation is refused here, not at the call sites.** Every path that runs a
   * command funnels through this method, so one check covers keyboard, pointer,
   * and anything added later. Per-call-site guards would leave `aria-disabled`
   * options — which stay within the keyboard's reach — runnable from whichever
   * path forgets to consult the predicate.
   */
  #confirmSelection(option: HTMLElement, reason: StateReason = "user", restoreFocus = true): void {
    if (this.#isDisabled(option)) return;
    const value = option.dataset.value || option.textContent || "";
    this.dispatch("select", { detail: { value, option, reason } });
    this.#close(
      restoreFocus && (reason !== "api" || this.element.contains(document.activeElement)),
    );
  }

  #resetFilter(): void {
    if (this.hasInputTarget) this.inputTarget.value = "";
    for (const option of this.optionTargets) {
      option.removeAttribute("hidden");
    }
    const hasSelectableOption = this.#visibleOptions.length > 0;
    this.#reflectEmptyState();
    this.#setActiveIndex(hasSelectableOption ? 0 : -1);
  }

  get #visibleOptions(): HTMLElement[] {
    // Shown and navigable. Activation is refused separately, in
    // `#confirmSelection`, so an `aria-disabled` command belongs in this set.
    return this.optionTargets.filter(
      (option) => !option.hasAttribute("hidden") && this.#isNavigable(option),
    );
  }

  /**
   * Whether virtual focus may land on `option`.
   *
   * Only `data-disabled` disqualifies. That attribute is this controller's own —
   * authors reach for it to mark a row that is not a destination at all, such as
   * a group heading — so it can mean "skip entirely" without contradicting ARIA.
   *
   * **`aria-disabled` does not disqualify.** It marks a command that must stay
   * *discoverable*: `aria-activedescendant` names it, so a reader announces it as
   * unavailable rather than hiding its existence. Virtual focus does
   * not change that — pointing `aria-activedescendant` at a disabled option is
   * ordinary ARIA. Keeping the two attributes distinct is what leaves both
   * meanings expressible; collapsing them would take "show it, say it is
   * unavailable, do not run it" away from consumers.
   */
  #isNavigable(option: HTMLElement): boolean {
    return option.dataset.disabled !== "true";
  }

  /** Whether activating `option` may run. Suppressed for either disabled marker. */
  #isDisabled(option: HTMLElement): boolean {
    return option.dataset.disabled === "true" || option.getAttribute("aria-disabled") === "true";
  }

  /** Synchronizes every option's controller-owned disabled semantics. */
  #syncOptionSemantics(): void {
    for (const option of this.optionTargets) this.#syncOptionSemanticsFor(option);
  }

  /**
   * Reflects `data-disabled` to ARIA without losing a pre-existing authored value.
   * Active-option synchronization owns `aria-selected` separately.
   */
  #syncOptionSemanticsFor(option: HTMLElement): void {
    // `aria-selected` is deliberately NOT written here. This runs over every
    // option on each active move, so clearing unconditionally would re-dirty the
    // whole set microseconds before `syncActiveOption` diffs it — the O(n) writes
    // the shared helper exists to avoid. Ownership of that attribute belongs to
    // the active-option sync alone; this method owns the disabled semantics.

    const originalAttribute = CommandPaletteController.#ORIGINAL_ARIA_DISABLED;
    const originalValue = option.getAttribute(originalAttribute);
    if (option.dataset.disabled === "true") {
      if (originalValue === null) {
        option.setAttribute(
          originalAttribute,
          option.getAttribute("aria-disabled") ?? CommandPaletteController.#ABSENT_ARIA_DISABLED,
        );
      }
      option.setAttribute("aria-disabled", "true");
      return;
    }

    if (originalValue === null) return;
    if (originalValue === CommandPaletteController.#ABSENT_ARIA_DISABLED) {
      option.removeAttribute("aria-disabled");
    } else {
      option.setAttribute("aria-disabled", originalValue);
    }
    option.removeAttribute(originalAttribute);
  }

  get #isOpen(): boolean {
    return this.hasDialogTarget && !this.dialogTarget.hidden;
  }

  readonly #onGlobalKeydown = (event: KeyboardEvent): void => {
    if (this.#composition.isComposing(event) || !this.#matchesHotkey(event)) return;

    event.preventDefault();
    this.toggle();
  };

  /** Matches the configured `mod+key` or bare-key hotkey without extra modifiers. */
  #matchesHotkey(event: KeyboardEvent): boolean {
    const hotkey = this.#parseHotkey();
    if (!hotkey || event.altKey || event.shiftKey) return false;

    if (hotkey.requiresMod) {
      // "mod" accepts exactly one of Cmd or Ctrl on every platform.
      const hasExactlyOneModKey = event.metaKey !== event.ctrlKey;
      if (!hasExactlyOneModKey) return false;
    } else if (event.metaKey || event.ctrlKey) {
      return false;
    }

    return event.key.toLowerCase() === hotkey.key;
  }

  /** Parses the intentionally small public hotkey grammar. */
  #parseHotkey(): { key: string; requiresMod: boolean } | null {
    const parts = this.hotkeyValue.toLowerCase().split("+");
    if (parts.length === 1 && parts[0] && parts[0] !== "mod") {
      return { key: parts[0], requiresMod: false };
    }
    if (parts.length === 2 && parts[0] === "mod" && parts[1]) {
      return { key: parts[1], requiresMod: true };
    }
    return null;
  }

  /** Resets transient open state so reconnect starts from a predictable closed snapshot. */
  #resetToClosedState(): void {
    this.#activeId = null;
    this.#activeOrder = [];
    this.openValue = false;

    // Nothing is active once the palette is closed, so the options have to say so
    // too. Clearing only the input's `aria-activedescendant` would leave the last
    // active option reading `aria-selected="true"` with `data-active` still on it
    // for the rest of the session, and ride that stale pair into Turbo's cache.
    for (const option of this.optionTargets) {
      option.setAttribute("aria-selected", "false");
      option.removeAttribute("data-active");
    }

    if (this.hasDialogTarget) {
      this.#hidden.write(this.dialogTarget, "");
    }

    if (this.hasInputTarget) {
      this.#expanded.write(this.inputTarget, "false");
      this.#activeDescendant.write(this.inputTarget, null);
    }
  }
}
