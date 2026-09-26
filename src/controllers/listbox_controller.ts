import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";
import { commitField, writeField } from "../utils/field_mirror";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { scrollOptionIntoView } from "../utils/option_scroll";
import { findTypeaheadMatch, isTypeaheadKey, Typeahead } from "../utils/typeahead";

/** Option attributes a page can rewrite in place that move the published selection. */
const OBSERVED_ATTRIBUTES = ["aria-selected", "data-value"];

/**
 * Sets `name` on `element` only when its value differs. A same-value write still
 * queues a mutation record for every observer on the page, so an unchanged state
 * writes nothing.
 */
function setAttributeIfChanged(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** The published selection: the selected option and the value its field submits. */
interface Selection {
  readonly option: HTMLElement | null;
  readonly value: string;
}

/**
 * Headless, accessible select-only listbox behavior.
 *
 * Markup contract (identifier: `stimeo--listbox`):
 *   <div data-controller="stimeo--listbox">
 *     <span id="lb-label">Favorite fruit</span>
 *     <button type="button" role="combobox" aria-haspopup="listbox"
 *             aria-expanded="false" aria-controls="lb-list"
 *             aria-labelledby="lb-label lb-value"
 *             data-stimeo--listbox-target="trigger"
 *             data-action="click->stimeo--listbox#toggle
 *                          keydown->stimeo--listbox#onTriggerKeydown">
 *       <span id="lb-value" data-stimeo--listbox-target="value">Choose…</span>
 *     </button>
 *     <ul id="lb-list" role="listbox" aria-label="Options" hidden
 *         data-stimeo--listbox-target="list">
 *       <li id="opt-1" role="option" aria-selected="false" data-value="1"
 *           data-stimeo--listbox-target="option"
 *           data-action="click->stimeo--listbox#select">Option 1</li>
 *       <!-- more options -->
 *     </ul>
 *     <input type="hidden" data-stimeo--listbox-target="field" />
 *   </div>
 *
 * Implements the WAI-ARIA APG **Listbox** pattern in its collapsed
 * (Select-Only Combobox) form. Focus stays on the trigger; the active option is
 * tracked with `aria-activedescendant` rather than by moving DOM focus. For a
 * text-filtered popup use {@link ComboboxController | Combobox}; for multiple
 * selection use {@link MultiSelectController | Multi-Select}.
 *
 * `change` dispatches `{ value: string, option: HTMLElement }` when the user
 * selects. `reconcile` dispatches `{ value: string, option: HTMLElement | null }`
 * — the shape of `change`, with `option: null` and `value: ""` once nothing is
 * selected — when the page moves the selection instead.
 *
 * @remarks
 * Behavior only. Static placement is the consumer's CSS; dynamic placement is
 * delegated to the opt-in `stimeo-ui/positioning` module. The look is keyed off
 * `aria-selected` / `data-active`. Because `role="combobox"` is not named by its
 * contents, give the trigger an accessible name via `aria-labelledby` (a visible
 * label plus the value span) or `aria-label`.
 *
 * Behavior provided:
 * - Open/close the list, syncing `aria-expanded` and the list's `hidden`.
 * - `ArrowDown`/`ArrowUp` (wrapping), `Home`/`End`, and printable-character
 *   typeahead move the active option; opening picks the selected option (else
 *   the first).
 * - Single selection syncs `aria-selected`, reflects the label into the trigger
 *   value and the field's value, and dispatches `stimeo--listbox:change` plus a
 *   native bubbling `change` on the field when its value actually changed.
 *   Making the field a validatable mirror (`<input type="text" hidden required>`
 *   instead of `type="hidden"`) lets `stimeo--form-validation` enforce native
 *   constraints on the committed value with no extra JavaScript.
 * - With nothing selected the trigger value shows `placeholder` when it is set,
 *   else the text it held before the controller first wrote into it; it keeps no
 *   text of an option that is not selected. A value the page rewrote, or added an
 *   element to, after the controller wrote into it is the page's instead, and stays
 *   exactly as the page left it until the next selection.
 * - A selection the page moves — the selected option removed or dropped from the
 *   targets, a morph or a script writing an option's `aria-selected` or the
 *   selected option's `data-value`, a selected option that arrives ahead of the
 *   selection — updates the label and the field silently and dispatches
 *   `stimeo--listbox:reconcile`: once per batch, and only when the selected
 *   option or its value differs from the selection last settled (on connect, by
 *   the user, or by the previous `reconcile`). Connecting reports nothing. While
 *   connected a `MutationObserver` watches the options' `aria-selected` and
 *   `data-value`; `disconnect()` releases it.
 * - `Enter`/`Space` select and close; `Escape` and outside click / `Tab` close;
 *   closing via select/Escape returns focus to the trigger.
 */
export class ListboxController extends Controller<HTMLElement> {
  static override targets = ["trigger", "value", "list", "option", "field"];
  static override values = {
    placeholder: { type: String, default: "" },
  };
  static actions = ["close", "onTriggerKeydown", "open", "select", "toggle"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly valueTarget: HTMLElement;
  declare readonly listTarget: HTMLElement;
  declare readonly optionTargets: HTMLElement[];
  declare readonly fieldTarget: HTMLInputElement;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasValueTarget: boolean;
  declare readonly hasListTarget: boolean;
  declare readonly hasFieldTarget: boolean;
  declare placeholderValue: string;

  /** Stable ID of the active option; DOM targets are resolved afresh before use. */
  #activeId: string | null = null;
  /** Target ID order captured while an option is active, used only for removal fallback. */
  #activeOrder: string[] = [];
  /**
   * Collapses the target callbacks, Value changes and observed option writes of
   * one DOM mutation into a single pass; refused before `connect()` and after
   * `disconnect()`.
   */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileOptions());
  /** Watches the option attributes a page can rewrite in place; set while connected. */
  #observer: MutationObserver | null = null;
  /** The selection last settled: on connect, by the user, or by a reported pass. */
  #settled: Selection = { option: null, value: "" };
  /** Accumulated typeahead query and its idle-reset timer. */
  readonly #typeahead = new Typeahead();

  /**
   * Establishes the ARIA baseline, settles the selection without reporting it,
   * starts closed, and listens for outside clicks.
   */
  override connect(): void {
    this.#normalizeSelection();
    this.close();
    document.addEventListener("click", this.#onOutsideClick, true);
    this.#settled = this.#selection();
    this.#reconcile.activate();
    this.#observeOptions();
  }

  /**
   * Establishes an inactive baseline for a late option, then re-applies the
   * selection baseline and re-resolves active identity once the batch is in.
   */
  optionTargetConnected(option: HTMLElement): void {
    option.removeAttribute("data-active");
    this.#reconcile.schedule();
  }

  /**
   * Removes controller-owned active state, then settles the selection and the
   * active option among the surviving targets once the batch is in.
   */
  optionTargetDisconnected(option: HTMLElement): void {
    option.removeAttribute("data-active");
    this.#reconcile.schedule();
  }

  /** Fills a form field inserted or replaced at runtime with the current selection. */
  fieldTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Writes the current selection into a trigger value inserted or replaced at runtime. */
  valueTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /**
   * Re-renders the empty-selection label when application code (or a Turbo morph)
   * changes `placeholder` at runtime.
   */
  placeholderValueChanged(): void {
    this.#reconcile.schedule();
  }

  /**
   * Brings the authored DOM to the shape the APG requires, and derives the state
   * that follows from the selection.
   *
   * Three things happen, and only these three — which option is chosen is the
   * author's, and is never changed:
   *
   * 1. Every option gets an explicit value. An absent `aria-selected` means "not
   *    selectable" in ARIA, so a forgotten attribute hides a selectable option
   *    from assistive technology.
   * 2. At most one stays `true`. The first in DOM order wins, since that is the
   *    only deterministic reading of "which one did the author mean"; an option
   *    the page inserts ahead of the selection, already selected, takes it over.
   * 3. The trigger label and the hidden field are derived from that selection,
   *    an empty one included. Without this the widget announces a choice it does
   *    not submit: the popup says "Banana", the trigger still says "Choose…", and
   *    the form posts "".
   *
   * Nothing is reported here: `connect()` describes the initial state, and a
   * page-driven pass reports a moved selection itself. The scan is the `option`
   * target set: a `role="option"` without the target is outside the contract and
   * is neither counted nor written.
   */
  #normalizeSelection(): void {
    const selected = this.optionTargets.find(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    this.#applySelection(selected);
  }

  /**
   * The pass the page's changes run: the selection is normalized and mirrored,
   * the active option re-resolved, then a selection that moved is reported. The
   * report comes last, so options a subscriber rewrites are the next pass's to
   * settle.
   */
  #reconcileOptions(): void {
    this.#normalizeSelection();
    this.#reconcileActive();
    this.#reportMove();
  }

  /**
   * Reports the selection as `reconcile` when its option or value differs from the
   * selection last settled. The settled selection is replaced before dispatching,
   * so a move a subscriber makes is measured against what it was told.
   */
  #reportMove(): void {
    const { option, value } = this.#selection();
    if (option === this.#settled.option && value === this.#settled.value) return;
    this.#settled = { option, value };
    this.dispatch("reconcile", { detail: { value, option } });
  }

  /** The selected option target, if any, and the value its field submits. */
  #selection(): Selection {
    const option =
      this.optionTargets.find((candidate) => candidate.getAttribute("aria-selected") === "true") ??
      null;
    return { option, value: option ? this.#optionValue(option) : "" };
  }

  /**
   * Releases the outside-click listener and the option observer, drops a queued
   * pass, and clears the typeahead timer.
   */
  override disconnect(): void {
    this.#reconcile.cancel();
    this.#observer?.disconnect();
    this.#observer = null;
    document.removeEventListener("click", this.#onOutsideClick, true);
    // The typeahead keeps its idle reset in a `SafeTimeout` of its own, so this is
    // the only teardown that reaches it — there is no controller-level registry to
    // fall back on. Every timer this controller can schedule lives in there.
    this.#typeahead.reset();
  }

  /**
   * Toggles the list on a real mouse click. Keyboard activation of the
   * `<button>` also fires a click (`detail === 0`); the keydown handler already
   * drives that, so the synthetic click is ignored to avoid double-toggling.
   */
  toggle(event: MouseEvent): void {
    if (event.detail === 0) return;
    if (this.#isClosed) {
      this.open();
    } else {
      this.close();
    }
  }

  /** Yields claimed keys; otherwise routes the APG select-only keyboard model. */
  onTriggerKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    if (!this.#isClosed) this.#reconcileActive();
    const options = this.optionTargets;
    const length = options.length;
    const activeIndex = this.#findActiveIndex(options);
    if (this.#isClosed) {
      switch (event.key) {
        case "Enter":
        case " ":
        case "ArrowDown":
        case "ArrowUp":
          event.preventDefault();
          this.open();
          break;
        default:
          break;
      }
      return;
    }

    // With no options, only Escape/Tab are meaningful; ignore navigation and
    // typeahead so the active index can never become NaN (`% 0`).
    if (length === 0 && event.key !== "Escape" && event.key !== "Tab") {
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.#setActive(activeIndex < 0 ? 0 : (activeIndex + 1) % length);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.#setActive(activeIndex < 0 ? length - 1 : (activeIndex - 1 + length) % length);
        break;
      case "Home":
        event.preventDefault();
        this.#setActive(0);
        break;
      case "End":
        event.preventDefault();
        this.#setActive(length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        this.#commitActive();
        break;
      case "Escape":
        // The entry guard already yields a press another handler owned. A press
        // during IME composition never dismisses, keeping one rule across the
        // widgets (the trigger is a button, so composition does not start here).
        if (event.isComposing) break;
        event.preventDefault();
        this.close();
        this.triggerTarget.focus();
        break;
      case "Tab":
        // Let focus leave naturally; just don't keep a stale popup open.
        this.close();
        break;
      default:
        if (isTypeaheadKey(event)) {
          event.preventDefault();
          this.#typeaheadTo(options, activeIndex, event.key);
        }
        break;
    }
  }

  /** Selects the clicked option and closes, returning focus to the trigger. */
  select(event: Event): void {
    const option = (event.currentTarget as HTMLElement).closest<HTMLElement>('[role="option"]');
    if (!option || !this.optionTargets.includes(option)) return;
    this.#selectOption(option);
    this.close();
    this.triggerTarget.focus();
  }

  /** Opens the list and activates the selected option (else the first). */
  open(): void {
    if (!this.hasListTarget) return;
    this.listTarget.hidden = false;
    this.triggerTarget.setAttribute("aria-expanded", "true");
    if (this.optionTargets.length === 0) {
      // An empty listbox has nothing to activate; leave activedescendant cleared.
      this.#setActive(-1);
      return;
    }
    const selected = this.optionTargets.findIndex(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    this.#setActive(selected === -1 ? 0 : selected);
  }

  /** Closes the list, clears the active option, and resets the typeahead buffer. */
  close(): void {
    if (!this.hasListTarget) return;
    this.listTarget.hidden = true;
    this.triggerTarget.setAttribute("aria-expanded", "false");
    this.#setActive(-1);
    this.#typeahead.reset();
  }

  /** Commits the active option (keyboard) and closes, returning focus. */
  #commitActive(): void {
    this.#reconcileActive();
    const options = this.optionTargets;
    const activeIndex = this.#findActiveIndex(options);
    const option = activeIndex < 0 ? undefined : options[activeIndex];
    if (option) this.#selectOption(option);
    this.close();
    this.triggerTarget.focus();
  }

  /** Applies selection: `aria-selected`, trigger label, hidden field, `change`. */
  #selectOption(option: HTMLElement): void {
    const { value, fieldChanged } = this.#applySelection(option);
    // Settled before anything is reported, so a listener that moves the selection
    // again is measured against this one.
    this.#settled = { option, value };
    // Matching <select> semantics: only on an actual value change, so
    // form-level behaviors — validation re-checks, auto-submit — hear the
    // commit without knowing this widget.
    if (fieldChanged) commitField(this.fieldTarget);
    this.dispatch("change", { detail: { value, option } });
  }

  /**
   * Writes `option` — or, when it is `undefined`, no selection — into
   * `aria-selected`, the trigger label and the hidden field. Emits nothing: the
   * user's commit and a page-driven pass each report it their own way, and
   * `connect()` only describes the state it finds.
   */
  #applySelection(option: HTMLElement | undefined): { value: string; fieldChanged: boolean } {
    for (const candidate of this.optionTargets) {
      setAttributeIfChanged(candidate, "aria-selected", candidate === option ? "true" : "false");
    }
    this.#dropOwnRecords();
    const value = option ? this.#optionValue(option) : "";
    this.#renderLabel(option);
    const fieldChanged = this.hasFieldTarget && writeField(this.fieldTarget, value);
    return { value, fieldChanged };
  }

  /**
   * Keeps the trigger value on the selection: the selected option's text, or, with
   * nothing selected, `placeholder` when it is set, else the text the value held
   * before this controller first wrote into it.
   *
   * The value is this controller's only while it holds the text last written into
   * it and nothing else — the `owns-label` marker carries that text — and the text
   * it held before is kept in the `original-label` marker. A value the page
   * rewrote or added an element to after that — the marker is still there but no
   * longer matches — is the page's: with nothing selected it is left exactly as it
   * is, `placeholder` or not, and the next selection remembers its text before
   * replacing it. A value with no marker at all — the author's, or one a morph put
   * back without the markers — is taken over the same way by `placeholder` or by a
   * selection. A value that only ever showed a selection has no text of its own to
   * return to, so it is emptied rather than left naming an option that is not
   * selected.
   *
   * @stimeoRenderRoot
   */
  #renderLabel(option: HTMLElement | undefined): void {
    if (!this.hasValueTarget) return;
    const label = this.valueTarget;
    const ownsLabel = `data-${this.identifier}-owns-label`;
    const originalLabel = `data-${this.identifier}-original-label`;
    const owned =
      label.getAttribute(ownsLabel) === label.textContent && label.childElementCount === 0;
    if (option === undefined && !owned && label.hasAttribute(ownsLabel)) return;
    const text = option ? this.#optionLabel(option) : this.placeholderValue || null;
    if (text === null) {
      if (!owned) return;
      label.textContent = label.getAttribute(originalLabel) ?? "";
      label.removeAttribute(ownsLabel);
      label.removeAttribute(originalLabel);
      return;
    }
    if (!owned) {
      const current = (label.textContent ?? "").trim();
      // Text that already shows this selection is not an empty-state label.
      if (option === undefined || current !== text) {
        setAttributeIfChanged(label, originalLabel, current);
      }
    }
    if (label.textContent !== text) label.textContent = text;
    setAttributeIfChanged(label, ownsLabel, text);
  }

  /** An option's visible label: its own text, trimmed. */
  #optionLabel(option: HTMLElement): string {
    return (option.textContent ?? "").trim();
  }

  /** The value an option submits: its `data-value`, else its label. */
  #optionValue(option: HTMLElement): string {
    return option.dataset.value ?? this.#optionLabel(option);
  }

  /**
   * Watches the options' `aria-selected` and `data-value`. The listbox's own writes
   * to them are dropped from the queue as they happen, so each record the callback
   * receives is the page's, and only a record on one of the listbox's own options
   * schedules a pass.
   */
  #observeOptions(): void {
    const observer = new MutationObserver((records) => {
      if (this.#concernsOptions(records)) this.#reconcile.schedule();
    });
    observer.observe(this.element, {
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    });
    this.#observer = observer;
  }

  /**
   * Whether any record is about one of this listbox's own options. A widget nested
   * inside it writes the same attributes on its own elements, and those are no
   * reason to reconcile the listbox.
   */
  #concernsOptions(records: readonly MutationRecord[]): boolean {
    const options = new Set<Node>(this.optionTargets);
    return records.some((record) => options.has(record.target));
  }

  /**
   * Drops the records the listbox's own writes just queued, so the observer never
   * takes them for the page's. A page write queued just before goes with them and
   * owes nothing: every such write leaves every option's `aria-selected` at the
   * value the selection gives it, and the selection is then read back from the DOM,
   * so it already holds what the page wrote.
   */
  #dropOwnRecords(): void {
    this.#observer?.takeRecords();
  }

  /**
   * Marks the option at `index` active via `data-active` and the trigger's
   * `aria-activedescendant`. Pass `-1` to clear it (the attribute is removed, not
   * set to empty, per the APG).
   */
  #setActive(index: number): void {
    const options = this.optionTargets;
    const active = index < 0 ? null : (options[index] ?? null);
    // Only the options whose marker actually changes are written, so a held arrow
    // key costs two attribute writes rather than one per option. The whole set is
    // still read: that is what makes a stray marker — one a morph left behind on
    // an element that never re-connected as a target — heal on the next move.
    for (const option of options) {
      const marked = option.hasAttribute("data-active");
      if (option === active) {
        if (!marked) option.setAttribute("data-active", "");
      } else if (marked) {
        option.removeAttribute("data-active");
      }
    }
    if (active?.id) {
      this.#activeId = active.id;
      this.triggerTarget.setAttribute("aria-activedescendant", active.id);
    } else {
      this.#activeId = null;
      this.triggerTarget.removeAttribute("aria-activedescendant");
    }
    this.#activeOrder = active ? options.map((option) => option.id).filter(Boolean) : [];
    // Virtual focus never triggers the browser's native focus-scrolling, so a
    // scrollable list must follow the active option itself (list-only scroll).
    if (active && this.hasListTarget) scrollOptionIntoView(this.listTarget, active);
  }

  /** Resolves active state against the current target collection. */
  #reconcileActive(): void {
    if (!this.hasTriggerTarget || this.#isClosed) {
      if (this.hasTriggerTarget) this.#setActive(-1);
      return;
    }

    const options = this.optionTargets;
    const currentIndex = this.#findActiveIndex(options);
    if (currentIndex >= 0) {
      const active = options[currentIndex] ?? null;
      const marked = options.filter((option) => option.hasAttribute("data-active"));
      const stateMatches =
        this.#activeId === (active?.id || null) &&
        marked.length === 1 &&
        marked[0] === active &&
        this.triggerTarget.getAttribute("aria-activedescendant") === (active?.id || null);

      if (stateMatches) {
        // Keep the deletion fallback snapshot current without re-scrolling the
        // already-active option before every keyboard command.
        this.#activeOrder = options.map((option) => option.id).filter(Boolean);
      } else {
        this.#setActive(currentIndex);
      }
      return;
    }

    const activeId = this.triggerTarget.getAttribute("aria-activedescendant") ?? this.#activeId;
    this.#setActive(activeId ? this.#findFallbackIndex(options, activeId) : -1);
  }

  /** Finds the live target carrying the stable ID, or the active marker for an ID-less option. */
  #findActiveIndex(options: readonly HTMLElement[]): number {
    const activeId =
      (this.hasTriggerTarget ? this.triggerTarget.getAttribute("aria-activedescendant") : null) ??
      this.#activeId;
    if (activeId) return options.findIndex((option) => option.id === activeId);
    return options.findIndex((option) => option.hasAttribute("data-active"));
  }

  /** Chooses a surviving former successor, then a former predecessor. */
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

  /**
   * Advances the typeahead query and activates the next matching option.
   *
   * The search resumes just after the active option so repeating a character
   * cycles through the options starting with it, rather than re-activating the
   * same first match on every press.
   */
  #typeaheadTo(options: HTMLElement[], activeIndex: number, char: string): void {
    const index = findTypeaheadMatch(options, activeIndex, this.#typeahead.push(char));
    if (index !== -1) this.#setActive(index);
  }

  /** Closes on an outside click before an inside handler can detach its target. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (!this.#isClosed && !this.element.contains(event.target as Node)) this.close();
  };

  /** Whether the list is currently hidden. */
  get #isClosed(): boolean {
    return !this.hasListTarget || this.listTarget.hidden !== false;
  }
}
