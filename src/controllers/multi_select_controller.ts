import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { ensureId } from "../utils/aria_ids";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { ChipRow } from "../utils/chip_row";
import { CompositionTracker } from "../utils/composition_tracker";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { scrollOptionIntoView } from "../utils/option_scroll";
import { TabindexLoan } from "../utils/tabindex_loan";

/**
 * Headless, accessible multi-select combobox with chips.
 *
 * Markup contract (identifier: `stimeo--multi-select`):
 *   <div data-controller="stimeo--multi-select"
 *        data-stimeo--multi-select-announce-text-value="{label} selected; {count} total"
 *        data-stimeo--multi-select-announce-removed-text-value="{label} removed; {count} total">
 *     <ul data-stimeo--multi-select-target="tags" aria-label="Selected"></ul>
 *     <input type="text" role="combobox" aria-expanded="false"
 *            aria-autocomplete="list" aria-controls="ms-list"
 *            data-stimeo--multi-select-target="input"
 *            data-action="input->stimeo--multi-select#filter
 *                         keydown->stimeo--multi-select#onKeydown
 *                         focus->stimeo--multi-select#open" />
 *     <ul id="ms-list" role="listbox" aria-multiselectable="true" hidden
 *         data-stimeo--multi-select-target="list">
 *       <li id="ms-opt-1" role="option" aria-selected="false" data-value="apple"
 *           data-stimeo--multi-select-target="option"
 *           data-action="click->stimeo--multi-select#toggleOption">Apple</li>
 *     </ul>
 *     <!-- Optional: submit the selection as name="fruits[]" hidden inputs. -->
 *     <div data-stimeo--multi-select-target="fields"></div>
 *     <template data-stimeo--multi-select-target="tagTemplate">
 *       <li data-stimeo--multi-select-target="tag">
 *         <span data-stimeo--multi-select-target="label"></span>
 *         <button type="button" tabindex="-1" aria-label="Remove {label}"
 *                 data-stimeo--multi-select-target="remove">×</button>
 *       </li>
 *     </template>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Combobox** pattern in its list-autocomplete,
 * multi-select form. Focus stays on the input; the active option is tracked with
 * `aria-activedescendant` and selection with `aria-selected`. Selected options are
 * mirrored as removable chips. For single selection use {@link ListboxController}
 * or Combobox; for free-text tags use {@link TagsInputController}.
 *
 * Behavior provided:
 * - Typing filters options by substring and opens the list; `ArrowDown`/`ArrowUp`
 *   (wrapping), `Home`/`End` move the active option; `Enter` toggles it (the list
 *   stays open); `Escape`/`Tab`/outside click close.
 * - Toggling syncs `aria-selected`, expands the author-localized remove-button
 *   name from the chip template, adds/removes the chip, sends localized text to
 *   the shared announcer, and dispatches
 *   `stimeo--multi-select:change` with `values`; filtering dispatches
 *   `stimeo--multi-select:filter` for async candidates. Option churn or a lowered
 *   `max` that moves the selection without a user edit is reported as
 *   `stimeo--multi-select:reconcile`, carrying the same `values` detail.
 * - The chips are one roving Tab stop: `ArrowLeft`/`ArrowRight` move between them,
 *   `Delete`/`Backspace` remove the focused chip, and `Backspace` on an empty
 *   input removes the last and keeps input focus; removal from a chip re-homes
 *   focus to a neighbor or the input.
 * - `max` is a permanent selection invariant across initial markup, interaction,
 *   runtime options, and runtime cap changes (`0` = unlimited).
 * - With a `fields` target the selected values are mirrored into named hidden
 *   inputs (default name `options[]`), so the selection submits with a normal
 *   form and no consumer JS — parity with {@link TagsInputController}. An optional
 *   `form` value sets the hidden inputs' `form` attribute, associating them with a
 *   `<form>` by id even when the picker lives outside it. Without a `fields`
 *   target the hidden inputs are simply not written.
 * `change` and `reconcile` dispatch `{ values: string[] }`.
 * `filter` dispatches `{ query: string }`.
 */
export class MultiSelectController extends Controller<HTMLElement> {
  static override targets = [
    "input",
    "list",
    "option",
    "tags",
    "tag",
    "tagTemplate",
    "label",
    "remove",
    "fields",
  ];
  static override values = {
    max: { type: Number, default: 0 },
    name: { type: String, default: "options[]" },
    form: { type: String, default: "" },
    announceText: { type: String, default: "" },
    announceRemovedText: { type: String, default: "" },
  };
  static actions = ["close", "filter", "onKeydown", "open", "toggleOption"] as const;
  static events = ["change", "filter", "reconcile"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly listTarget: HTMLElement;
  declare readonly optionTargets: HTMLElement[];
  declare readonly tagsTarget: HTMLElement;
  declare readonly tagTargets: HTMLElement[];
  declare readonly tagTemplateTarget: HTMLTemplateElement;
  declare readonly labelTargets: HTMLElement[];
  declare readonly removeTargets: HTMLButtonElement[];
  declare readonly fieldsTarget: HTMLElement;
  declare readonly hasListTarget: boolean;
  declare readonly hasInputTarget: boolean;
  declare readonly hasTagsTarget: boolean;
  declare readonly hasTagTemplateTarget: boolean;
  declare readonly hasFieldsTarget: boolean;

  declare maxValue: number;
  declare nameValue: string;
  declare formValue: string;
  declare readonly hasFormValue: boolean;
  declare announceTextValue: string;
  declare announceRemovedTextValue: string;

  /** Stable id of the active option; the current target is resolved from the DOM. */
  #activeOptionId: string | null = null;
  /** Whether the root borrowed a tab stop to catch focus, so teardown can undo it. */
  readonly #tabindex = new TabindexLoan();
  /** Last reconciled selection, used to distinguish state changes from derived-DOM repair. */
  #selectionValues: string[] = [];
  /** Whether initial normalization finished, so a fields callback cannot mirror stale state. */
  #connected = false;
  /** Collapses one batch of target callbacks into a single final-DOM reconciliation. */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileOptions());
  /** Absorbs the browser's redundant final input after compositionend. */
  #ignorePostCompositionInput = false;
  /** Owns IME lifecycle state; confirmed text emits one filter result. */
  readonly #composition = new CompositionTracker({
    onStart: () => {
      this.#ignorePostCompositionInput = false;
    },
    onEnd: () => {
      // Apply the confirmed query even in browsers that omit a final input event.
      // When the usual final input follows synchronously, absorb it so async
      // consumers receive one filter event for the confirmed text, not two.
      this.#ignorePostCompositionInput = true;
      queueMicrotask(() => {
        this.#ignorePostCompositionInput = false;
      });
      this.filter();
    },
  });
  /** Whether this connection already reported its unusable chip template. */
  #warnedTemplate = false;
  /** Shared delegated interaction for the replaceable row of removable chips. */
  readonly #chipRow = new ChipRow({
    directionElement: this.element,
    getItems: () => this.tagTargets,
    getButton: (tag) =>
      tag.querySelector<HTMLButtonElement>('button[data-stimeo--multi-select-target~="remove"]'),
    onRemove: (index) => this.#removeTagAt(index),
    focusAfterEnd: () => this.#focusInput(),
  });

  /** Starts closed, syncs chips for any pre-selected options, and listens out. */
  override connect(): void {
    this.#warnedTemplate = false;
    // A fresh connection has no prior selection to preserve: deterministic DOM
    // order decides which authored selections survive a finite max.
    this.#normalizeSelection([]);
    this.close();
    if (this.hasTagsTarget) {
      this.#chipRow.connect(this.tagsTarget);
      this.#rebuildTags();
    }
    this.#selectionValues = this.#values;
    // Seed the hidden fields from any pre-selected options so the form submits
    // the initial selection without an interaction.
    this.#syncFields();
    document.addEventListener("click", this.#onOutsideClick, true);
    this.#connected = true;
    this.#reconcile.activate();
  }

  /**
   * Derives the chips from the selected options, idempotently: a Turbo Drive cache
   * restore or morph can re-connect with chips already in the DOM, so they are
   * cleared before deriving afresh to avoid duplicates.
   */
  #rebuildTags(): void {
    if (!this.hasTagsTarget || !this.hasTagTemplateTarget) return;
    const fragments: DocumentFragment[] = [];
    for (const option of this.#selectedOptions) {
      const fragment = this.#buildTag(option);
      if (!fragment) return;
      fragments.push(fragment);
    }
    for (const tag of this.tagTargets) tag.remove();
    this.tagsTarget.append(...fragments);
    this.#chipRow.ensureTabStop();
  }

  /** Tears down document and chip listeners on disconnect (Turbo included). */
  override disconnect(): void {
    this.#connected = false;
    this.#reconcile.cancel();
    this.#composition.disconnect();
    this.#ignorePostCompositionInput = false;
    this.#chipRow.disconnect();
    document.removeEventListener("click", this.#onOutsideClick, true);
    this.#releaseTabindex();
  }

  /** Reconciles active state after an option target is added at runtime. */
  optionTargetConnected(): void {
    this.#scheduleOptionReconcile();
  }

  /** Cleans a removed target and reconciles active state against the surviving DOM. */
  optionTargetDisconnected(option: HTMLElement): void {
    // `#setActive` can only scan current targets; clean the old node explicitly in
    // case a Turbo morph reuses it elsewhere.
    option.removeAttribute("data-active");
    this.#scheduleOptionReconcile();
  }

  /** Rebinds delegated chip interaction when Turbo replaces the tags container. */
  tagsTargetConnected(tags: HTMLElement): void {
    this.#chipRow.connect(tags);
    this.#scheduleOptionReconcile();
  }

  /** Releases only the row that actually disconnected, never a newer replacement. */
  tagsTargetDisconnected(tags: HTMLElement): void {
    this.#chipRow.disconnect(tags);
    this.#scheduleOptionReconcile();
  }

  /** Seeds a fields target inserted after connect from the current selection. */
  fieldsTargetConnected(): void {
    if (this.#connected) this.#syncFields();
  }

  /** Reconciles a runtime max change, including dropping any newly invalid overflow. */
  maxValueChanged(): void {
    this.#scheduleOptionReconcile();
  }

  /** Rebuilds submitted fields when their public name changes at runtime. */
  nameValueChanged(): void {
    this.#scheduleOptionReconcile();
  }

  /** Rebuilds submitted fields when their associated form changes at runtime. */
  formValueChanged(): void {
    this.#scheduleOptionReconcile();
  }

  /** Schedules one reconciliation after all callbacks in the mutation batch. */
  #scheduleOptionReconcile(): void {
    this.#reconcile.schedule();
  }

  /**
   * Keeps a surviving/same-id active target, otherwise falls back to the first
   * visible one — and brings the derived state back in line with the new option set.
   *
   * The baseline pass fills in any missing `aria-selected`, and the chips and
   * hidden fields are re-derived from it, because the options are the truth source
   * for the selection. The chips are rebuilt **only when the selected value set
   * actually moved**: the rebuild removes and recreates every chip, so running it
   * for an unrelated option would drop focus from a chip's remove button to
   * `<body>`, losing the keyboard user's place for something that did not concern
   * them.
   */
  #reconcileOptions(): void {
    const visible = this.#visibleOptions;
    const active = this.#activeOption;
    const next = this.#isClosed ? null : active && !active.hidden ? active : (visible[0] ?? null);
    this.#setActive(next);
    this.#reflectEmpty();

    const previous = this.#selectionValues;
    const previousLabels = new Map(
      this.tagTargets.map((tag) => [
        tag.dataset.value ?? "",
        (
          tag.querySelector<HTMLElement>('[data-stimeo--multi-select-target~="label"]')
            ?.textContent ?? ""
        ).trim(),
      ]),
    );
    // Prefer the interaction order represented by live chips. A tags target can
    // be replaced with an empty container, so the last reconciled option set is
    // the fallback that prevents a derived-DOM repair from evicting user choices.
    const priority = [
      ...new Set([...this.tagTargets.map((tag) => tag.dataset.value ?? ""), ...previous]),
    ];
    this.#normalizeSelection(priority);
    const selected = this.#selectedOptions;
    // Compared as a set, not a sequence: the chips are in selection order while
    // the options are in DOM order, so an index-wise comparison reports a change
    // for every selection the user made out of DOM order and rebuilds forever.
    const nextValues = selected.map((option) => this.#optionValue(option)).sort();
    const tagValues = this.tagTargets.map((tag) => tag.dataset.value ?? "").sort();
    const unchanged =
      nextValues.length === tagValues.length &&
      nextValues.every((value, index) => value === tagValues[index]);
    if (unchanged) this.#refreshTagLabels(selected);
    else this.#rebuildTags();
    this.#syncFields();

    const values = this.#values;
    const changed = !this.#sameSelection(previous, values);
    this.#selectionValues = values;
    if (!changed) return;

    const options = new Map(selected.map((option) => [this.#optionValue(option), option]));
    for (const value of previous) {
      if (!values.includes(value)) {
        this.#announceTransition(false, previousLabels.get(value) || value, value, values.length);
      }
    }
    for (const value of values) {
      if (previous.includes(value)) continue;
      // `values` is derived from `selected`, so this lookup is total.
      const option = options.get(value) as HTMLElement;
      this.#announceTransition(true, this.#optionLabel(option), value, values.length);
    }
    // Runtime option churn and the `max` cap move the selection by this
    // controller's rules, so the repair is reported apart from `change`, which
    // stays reserved for the user's own add and remove.
    this.dispatch("reconcile", { detail: { values } });
  }

  /**
   * Gives every option an explicit `aria-selected` and enforces the current cap.
   * Priority preserves existing chip order at runtime; a fresh connection passes
   * no priority, so deterministic option DOM order chooses the initial survivors.
   */
  #normalizeSelection(priority: readonly string[]): void {
    const selected = this.optionTargets.filter(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    const limit = this.#selectionLimit;
    const kept = new Set<HTMLElement>();

    if (limit === 0) {
      for (const option of selected) kept.add(option);
    } else {
      for (const value of priority) {
        if (kept.size >= limit) break;
        const option = selected.find(
          (candidate) => !kept.has(candidate) && this.#optionValue(candidate) === value,
        );
        if (option) kept.add(option);
      }
      for (const option of selected) {
        if (kept.size >= limit) break;
        kept.add(option);
      }
    }

    for (const option of this.optionTargets) {
      option.setAttribute("aria-selected", String(kept.has(option)));
    }
  }

  /**
   * Tracks an input added initially or after connect, and makes it describe the
   * widget that is actually on screen: a swapped-in input arrives with the
   * authored ARIA of a fresh node while this controller still holds the popup
   * state, and the open path cannot repair that (it seeds an active option only
   * when there is none), so a live list would go unannounced.
   */
  inputTargetConnected(input: HTMLInputElement): void {
    this.#composition.observe(input);
    input.setAttribute("aria-expanded", String(!this.#isClosed));
    const active = this.#activeOption;
    if (active) input.setAttribute("aria-activedescendant", ensureId(active, "stimeo-ms-opt"));
    else input.removeAttribute("aria-activedescendant");
  }

  /** Removes composition listeners when the active input is replaced or removed. */
  inputTargetDisconnected(input: HTMLInputElement): void {
    this.#composition.unobserve(input);
    this.#ignorePostCompositionInput = false;
  }

  /** Filters confirmed input text, opens, and re-seeds the active option. */
  filter(event?: InputEvent): void {
    if (!this.hasInputTarget) return;
    if (event && this.#ignorePostCompositionInput) {
      this.#ignorePostCompositionInput = false;
      return;
    }
    if (this.#composition.isComposing(event)) return;
    const query = this.inputTarget.value.trim().toLowerCase();
    for (const option of this.optionTargets) {
      const label = (option.textContent ?? "").trim().toLowerCase();
      option.hidden = query !== "" && !label.includes(query);
    }
    this.open();
    const visible = this.#visibleOptions;
    this.#reflectEmpty();
    this.#setActive(visible[0] ?? null);
    this.dispatch("filter", { detail: { query } });
  }

  /**
   * Opens the list and activates the first visible option when none is active.
   *
   * Needs the input, which owns `aria-expanded` and `aria-activedescendant`: a
   * list shown without one is a popup no assistive technology is told about. So
   * opening is skipped entirely, where {@link close} still closes.
   */
  open(): void {
    if (!this.hasListTarget || !this.hasInputTarget) {
      this.#reflectEmpty();
      return;
    }
    this.listTarget.hidden = false;
    this.inputTarget.setAttribute("aria-expanded", "true");
    if (!this.#activeOption) this.#setActive(this.#visibleOptions[0] ?? null);
    this.#reflectEmpty();
  }

  /**
   * Closes the list and clears the active option.
   *
   * Survives a missing input in both directions. `connect()` calls this second,
   * so dereferencing the input here would throw before the chips, the roving
   * seed, the chip listeners, the hidden fields and the outside-click listener —
   * and Stimulus keeps the controller alive after that throw, so none of them
   * would ever run and the selection would silently stop submitting. An input
   * removed while the list is open must still let it come down *and* forget its
   * active option, so only the `aria-expanded` write is guarded.
   */
  close(): void {
    if (this.hasListTarget) this.listTarget.hidden = true;
    this.#setActive(null);
    if (this.hasInputTarget) this.inputTarget.setAttribute("aria-expanded", "false");
    this.#reflectEmpty();
  }

  /** Routes input keyboard interaction per the multi-select combobox model. */
  onKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key must not ALSO open the
    // list or move the active option — composition depends on this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    if (!this.hasInputTarget) return;
    // Ignore keys fired during IME composition: the `Enter` that confirms a
    // candidate (and arrows that move within it) must not select an option or
    // navigate the chip list. Controller-owned lifecycle state covers confirming
    // events that omit the standard per-event signal.
    if (this.#composition.isComposing(event)) return;
    // Target callbacks are MutationObserver-driven. Resolve a replacement now, or
    // clear a removed id now, so a synchronously dispatched key cannot commit a
    // detached node before the callback gets its turn.
    this.#reconcileActiveForInteraction();
    // Logical, not physical. The key is normalised rather than a new case added:
    // the two horizontal branches are not mirror images — only one guards its
    // edge, and the other hands focus back to the input — so swapping the key
    // keeps each branch, guards and all, with its own direction. Both handlers
    // read the same element on purpose; probing the focused child would let the
    // input and the chips disagree at the boundary between them.
    switch (logicalArrowKey(event.key, this.element)) {
      case "ArrowDown":
        event.preventDefault();
        if (this.#isClosed) this.open();
        else this.#moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (this.#isClosed) this.open();
        else this.#moveActive(-1);
        break;
      case "Home":
        if (!this.#isClosed) {
          event.preventDefault();
          this.#setActive(this.#visibleOptions[0] ?? null);
        }
        break;
      case "End": {
        if (!this.#isClosed) {
          event.preventDefault();
          const visible = this.#visibleOptions;
          this.#setActive(visible[visible.length - 1] ?? null);
        }
        break;
      }
      case "Enter": {
        const active = this.#activeOption;
        if (!this.#isClosed && active) {
          event.preventDefault();
          this.#toggleSelection(active);
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
      case "Backspace":
        if (this.inputTarget.value === "") {
          const last = this.#chipRow.lastIndex;
          if (last >= 0) {
            event.preventDefault();
            this.#removeTagAt(last, "input");
          }
        }
        break;
      case "ArrowLeft":
        if (this.inputTarget.value === "" && this.#chipRow.length > 0) {
          event.preventDefault();
          this.#chipRow.focusLast();
        }
        break;
      case "Tab":
        this.close();
        break;
      default:
        break;
    }
  }

  /**
   * Toggles the clicked option's selection. Bound via `data-action`. Focus is
   * re-homed to the input afterwards: options are non-focusable, so the click blurs
   * the input to `body` — and with the list deliberately staying open, every
   * keyboard affordance (Escape, arrows, typing) is bound to the input and would
   * otherwise go dead until the user clicks back in ("focus stays on the input").
   */
  toggleOption(event: Event): void {
    const option = (event.currentTarget as HTMLElement).closest<HTMLElement>('[role="option"]');
    if (!option || !this.optionTargets.includes(option)) return;
    this.#toggleSelection(option);
    this.#focusInput();
  }

  /**
   * Re-homes focus to the input, or leaves it where it is when there is none.
   *
   * All three callers run *after* an option or a chip already took focus, and all
   * three are reachable without an input — options and chips carry their own
   * `data-action`. Throwing here would leave the chip removed but focus stranded
   * on a detached button.
   */
  #focusInput(): void {
    if (this.hasInputTarget) this.inputTarget.focus();
  }

  /**
   * Re-homes focus after the last chip was removed: to the input, else the root.
   *
   * Unlike the other {@link #focusInput} callers, the element that held focus has
   * just left the DOM, so "leave it alone" is not an option — the browser already
   * dropped it to `<body>`. The root borrows a `tabindex="-1"` just-in-time (not a
   * Tab stop, handed back before Turbo caches or on teardown). Focus that landed
   * on a real element is left alone, so a chip removed out of band never steals it.
   */
  #focusAfterLastTag(): void {
    if (this.hasInputTarget) {
      this.inputTarget.focus();
      return;
    }
    const doc = this.element.ownerDocument;
    const active = doc.activeElement;
    // Anything else still holding focus keeps it; only `<body>`, the root element
    // and a detached node mean the browser had nowhere to put it.
    if (active && active !== doc.body && active !== doc.documentElement && active.isConnected) {
      return;
    }
    this.#tabindex.lend(this.element);
    this.element.focus();
  }

  /**
   * Returns the borrowed tab stop. Owning the borrow is not enough — the value
   * has to still be the one this instance wrote, since a consumer that changed it
   * afterwards owns it now.
   */
  #releaseTabindex(): void {
    this.#tabindex.returnAll();
  }

  /** Moves the active option by `delta` among visible options, wrapping. */
  #moveActive(delta: number): void {
    const visible = this.#visibleOptions;
    const active = this.#activeOption;
    // `null` is the deliberate "not found" sentinel; Array#indexOf accepts it
    // at runtime and returns -1, although this array's static item type excludes it.
    const current = visible.indexOf(active as HTMLElement);
    const candidate = current === -1 ? (delta > 0 ? 0 : visible.length - 1) : current + delta;
    const next = (candidate + visible.length) % visible.length;
    this.#setActive(visible[next] ?? null);
  }

  /** Selects/deselects `option`, honoring `max`, and syncs chip + announcement. */
  #toggleSelection(option: HTMLElement): void {
    const selected = option.getAttribute("aria-selected") === "true";
    const limit = this.#selectionLimit;
    if (!selected && limit > 0 && this.#selectedOptions.length >= limit) {
      return;
    }
    if (selected) {
      option.setAttribute("aria-selected", "false");
      this.#removeTagFor(option);
    } else {
      // Chips are a display affordance here, not the value model: the selection
      // lives on `aria-selected` and the hidden fields, so a field authored
      // without a chip template still selects. An authored template that cannot
      // be completed is the opposite case — leaving a selection whose chip is
      // missing would be the half-applied state, so that one aborts instead.
      if (this.hasTagTemplateTarget && !this.#appendTag(option)) return;
      option.setAttribute("aria-selected", "true");
    }
    this.#refreshRoving();
    this.#syncFields();
    const values = this.#values;
    this.#selectionValues = values;
    this.#announceTransition(
      !selected,
      this.#optionLabel(option),
      this.#optionValue(option),
      values.length,
    );
    this.dispatch("change", { detail: { values } });
  }

  /**
   * Re-reads each chip's label from its option, in place.
   *
   * The value order alone does not say the chips are still correct: a server can
   * re-render the same candidate with a new label ("Apple" → "Green Apple"), and
   * the chip text and its `Remove {label}` name are both derived from the option.
   * Updating them here keeps the rebuild — which would drop focus — for the case
   * that actually needs it, a changed selection.
   */
  #refreshTagLabels(selected: readonly HTMLElement[]): void {
    // Paired by value rather than by position: the chips are in selection order
    // and the options in DOM order, so the two lists hold the same values in
    // different places and an index-wise pairing would relabel the wrong chip.
    const options = new Map(selected.map((option) => [this.#optionValue(option), option]));
    for (const tag of this.tagTargets) {
      // The caller established equal selected/tag value sets before refreshing.
      const option = options.get(tag.dataset.value ?? "") as HTMLElement;
      const text = this.#optionLabel(option);
      const label = tag.querySelector<HTMLElement>('[data-stimeo--multi-select-target~="label"]');
      const button = tag.querySelector<HTMLButtonElement>(
        'button[data-stimeo--multi-select-target~="remove"]',
      );
      const name = this.#removeName(text, this.#optionValue(option));
      // Relabelling is one transaction, like building the chip is. Writing the
      // visible text without its accessible name would leave the button naming
      // a value the chip no longer shows, so a name this template cannot produce
      // holds the old text in place too.
      if (!label || !button || !name) continue;
      if (label.textContent !== text) label.textContent = text;
      if (button.getAttribute("aria-label") !== name) button.setAttribute("aria-label", name);
    }
  }

  /** Builds one chip from the template for `option`. */
  #appendTag(option: HTMLElement): boolean {
    if (!this.hasTagsTarget) {
      this.#warnTemplate('a "tags" target to append the chip to');
      return false;
    }
    const fragment = this.#buildTag(option);
    if (!fragment) return false;
    this.tagsTarget.appendChild(fragment);
    return true;
  }

  /**
   * Builds one fully named chip without mutating the live tag row, or `null`
   * when the authored template cannot produce one. Both callers establish the
   * template first: a field authored without `tagTemplate` renders no chips at
   * all — a supported configuration — and never reaches here.
   */
  #buildTag(option: HTMLElement): DocumentFragment | null {
    const fragment = this.tagTemplateTarget.content.cloneNode(true) as DocumentFragment;
    const tag = fragment.querySelector<HTMLElement>('[data-stimeo--multi-select-target~="tag"]');
    const label = fragment.querySelector<HTMLElement>(
      '[data-stimeo--multi-select-target~="label"]',
    );
    const button = fragment.querySelector<HTMLButtonElement>(
      'button[data-stimeo--multi-select-target~="remove"]',
    );
    const text = this.#optionLabel(option);
    const value = this.#optionValue(option);
    const removeName = button?.getAttribute("aria-label")?.trim() ?? "";
    if (!tag) return this.#warnTemplate('a "tag" target');
    if (!label) return this.#warnTemplate('a "label" target');
    if (!button) return this.#warnTemplate('a "remove" target <button>');
    if (removeName === "") {
      return this.#warnTemplate('a non-empty aria-label on its "remove" target');
    }
    tag.dataset.value = value;
    label.textContent = text;
    button.setAttribute("aria-label", fillTemplate(removeName, { label: text, value }));
    button.tabIndex = -1;
    return fragment;
  }

  /**
   * Reports an unusable chip template to the author, once per connection.
   *
   * The selection itself stays untouched — no `aria-selected`, chip, hidden
   * field, announcement, or event moves. Without this line the only symptom is
   * a listbox whose options refuse to select, and the two causes the Inspector
   * cannot see statically (a name that renders empty from a missing
   * translation, a server-rendered template) would have no diagnostic anywhere.
   */
  #warnTemplate(missing: string): null {
    if (!this.#warnedTemplate) {
      this.#warnedTemplate = true;
      console.warn(
        `Stimeo UI: "${this.identifier}" changed no selection because its chip template lacks ${missing}.`,
      );
    }
    return null;
  }

  /** Expands the current template's localized remove-button name. */
  #removeName(label: string, value: string): string | null {
    if (!this.hasTagTemplateTarget) return null;
    const template = this.tagTemplateTarget.content
      .querySelector<HTMLButtonElement>('button[data-stimeo--multi-select-target~="remove"]')
      ?.getAttribute("aria-label")
      ?.trim();
    return template ? fillTemplate(template, { label, value }) : null;
  }

  /** Removes the chip mirroring `option`, if present. */
  #removeTagFor(option: HTMLElement): void {
    const value = this.#optionValue(option);
    const tag = this.tagTargets.find((candidate) => candidate.dataset.value === value);
    tag?.remove();
  }

  /** Removes chip `index` and deselects its option, re-homing focus. */
  #removeTagAt(index: number, focus: "neighbor" | "input" = "neighbor"): void {
    const tag = this.tagTargets[index];
    if (!tag) return;
    const value = tag.dataset.value ?? "";
    // Match by the option's stable value, which falls back to its label when no
    // data-value is present, so a label-keyed chip still finds its option.
    const option = this.optionTargets.find((candidate) => this.#optionValue(candidate) === value);
    if (option) option.setAttribute("aria-selected", "false");
    tag.remove();
    // Prefer the option's display label for the announcement (e.g. "Apple"),
    // which can differ from its data-value (e.g. "apple").
    this.#refreshRoving();
    this.#syncFields();
    const values = this.#values;
    this.#selectionValues = values;
    this.#announceTransition(
      false,
      option ? this.#optionLabel(option) : value,
      value,
      values.length,
    );
    this.dispatch("change", { detail: { values } });

    if (focus === "input") {
      this.#focusInput();
      return;
    }
    if (!this.#chipRow.focusAfterRemoval(index)) this.#focusAfterLastTag();
  }

  /**
   * Marks `option` active via `data-active` and the input's
   * `aria-activedescendant` (the attribute is removed, not emptied, when null).
   *
   * The state half runs even with no input, so a `close()` that cannot touch ARIA
   * still clears it: {@link open} seeds an active option only when there is none,
   * so a stale one makes the next open skip the seeding and a replacement input
   * gets no `aria-activedescendant` at all.
   */
  #setActive(option: HTMLElement | null): void {
    const activeId = option ? ensureId(option, "stimeo-ms-opt") : null;
    this.#activeOptionId = activeId;
    for (const candidate of this.optionTargets) {
      candidate.toggleAttribute("data-active", candidate === option);
    }
    // Virtual focus never triggers the browser's native focus-scrolling, so a
    // scrollable list must follow the active option itself (list-only scroll).
    if (option && this.hasListTarget) scrollOptionIntoView(this.listTarget, option);
    if (!this.hasInputTarget) return;
    if (activeId !== null) {
      this.inputTarget.setAttribute("aria-activedescendant", activeId);
    } else {
      this.inputTarget.removeAttribute("aria-activedescendant");
    }
  }

  /** Repairs only active identity before a key; the fallback waits for the target callback. */
  #reconcileActiveForInteraction(): void {
    const activeId = this.#activeOptionId;
    if (activeId === null) return;
    const resolved = this.#activeOption;
    const active = resolved && !resolved.hidden ? resolved : null;
    const marked = this.optionTargets.filter((candidate) => candidate.hasAttribute("data-active"));
    // The only caller returns before reaching here when the input is absent.
    const idref = this.inputTarget.getAttribute("aria-activedescendant");
    if (!active || marked.length !== 1 || marked[0] !== active || idref !== activeId) {
      this.#setActive(active);
    }
  }

  /** Reflects whether the open list currently has no visible option targets. */
  #reflectEmpty(): void {
    this.element.toggleAttribute(
      "data-stimeo--multi-select-empty",
      !this.#isClosed && this.#visibleOptions.length === 0,
    );
  }

  /**
   * Mirrors the selected values into named hidden inputs under the `fields`
   * target so the selection submits with a normal form (parity with tags-input).
   * No-ops without a `fields` target. When the
   * `form` value is set, each input gets a matching `form` attribute so the picker
   * can submit with a `<form>` it lives outside of.
   */
  #syncFields(): void {
    if (!this.hasFieldsTarget) return;
    this.fieldsTarget.replaceChildren(
      ...this.#values.map((value) => {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = this.nameValue;
        input.value = value;
        if (this.hasFormValue && this.formValue !== "") input.setAttribute("form", this.formValue);
        return input;
      }),
    );
  }

  /** Keeps exactly one chip remove button tabbable after the set changes. */
  #refreshRoving(): void {
    this.#chipRow.ensureTabStop();
  }

  /** Sends one localized selection transition through the page's shared announcer. */
  #announceTransition(selected: boolean, label: string, value: string, count: number): void {
    const template = selected ? this.announceTextValue : this.announceRemovedTextValue;
    announce(fillTemplate(template, { label, value, count }));
  }

  /** Whether two arrays represent the same selection set, independent of DOM order. */
  #sameSelection(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    const a = [...left].sort();
    const b = [...right].sort();
    return a.every((value, index) => value === b[index]);
  }

  /** Closes the list on a click outside the controller element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (!this.#isClosed && !this.element.contains(event.target as Node)) this.close();
  };

  /** Trimmed visible label of an option. */
  #optionLabel(option: HTMLElement): string {
    return (option.textContent ?? "").trim();
  }

  /** An option's stable value: its `data-value`, else its display label. */
  #optionValue(option: HTMLElement): string {
    return option.dataset.value ?? this.#optionLabel(option);
  }

  /** Options not hidden by the current filter. */
  get #visibleOptions(): HTMLElement[] {
    return this.optionTargets.filter((option) => !option.hidden);
  }

  /** Current active target resolved by stable id, never a detached node reference. */
  get #activeOption(): HTMLElement | null {
    return this.optionTargets.find((option) => option.id === this.#activeOptionId) ?? null;
  }

  /** Options currently selected. */
  get #selectedOptions(): HTMLElement[] {
    return this.optionTargets.filter((option) => option.getAttribute("aria-selected") === "true");
  }

  /** Selected values in option order. */
  get #values(): string[] {
    return this.#selectedOptions.map((option) => this.#optionValue(option));
  }

  /** Normalized cardinality cap: zero is unlimited and positive fractions round down. */
  get #selectionLimit(): number {
    if (!Number.isFinite(this.maxValue) || this.maxValue <= 0) return 0;
    return Math.max(1, Math.floor(this.maxValue));
  }

  /** Whether the list is currently hidden. */
  get #isClosed(): boolean {
    return !this.hasListTarget || this.listTarget.hidden !== false;
  }
}
