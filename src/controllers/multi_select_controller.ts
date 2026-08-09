import { Controller } from "@hotwired/stimulus";
import { ensureId } from "../utils/aria_ids";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { CompositionTracker } from "../utils/composition_tracker";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { scrollOptionIntoView } from "../utils/option_scroll";
import { RovingTabindex } from "../utils/roving_tabindex";
import { TabindexLoan } from "../utils/tabindex_loan";

/**
 * Headless, accessible multi-select combobox with chips.
 *
 * Markup contract (identifier: `stimeo--multi-select`):
 *   <div data-controller="stimeo--multi-select">
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
 *     <span role="status" aria-live="polite" class="visually-hidden"
 *           data-stimeo--multi-select-target="status"></span>
 *     <!-- Optional: submit the selection as name="fruits[]" hidden inputs. -->
 *     <div data-stimeo--multi-select-target="fields"></div>
 *     <template data-stimeo--multi-select-target="tagTemplate">…</template>
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
 * - Toggling syncs `aria-selected`, adds/removes a `Remove {label}` chip, mirrors
 *   the live region, and dispatches `stimeo--multi-select:change` with `values`;
 *   filtering dispatches `stimeo--multi-select:filter` for async candidates.
 * - The chips are one roving Tab stop: `ArrowLeft`/`ArrowRight` move between them,
 *   `Delete`/`Backspace` remove the focused chip, and `Backspace` on an empty
 *   input removes the last; removal re-homes focus to a neighbor or the input.
 * - `max` caps the selection (`0` = unlimited).
 * - With a `fields` target the selected values are mirrored into named hidden
 *   inputs (default name `options[]`), so the selection submits with a normal
 *   form and no consumer JS — parity with {@link TagsInputController}. An optional
 *   `form` value sets the hidden inputs' `form` attribute, associating them with a
 *   `<form>` by id even when the picker lives outside it. Without a `fields`
 *   target the hidden inputs are simply not written.
 */
export class MultiSelectController extends Controller<HTMLElement> {
  static override targets = [
    "input",
    "list",
    "option",
    "tags",
    "tag",
    "tagTemplate",
    "status",
    "fields",
  ];
  static override values = {
    max: { type: Number, default: 0 },
    name: { type: String, default: "options[]" },
    form: { type: String, default: "" },
  };
  static actions = ["close", "filter", "onKeydown", "open", "toggleOption"] as const;
  static events = ["change", "filter"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly listTarget: HTMLElement;
  declare readonly optionTargets: HTMLElement[];
  declare readonly tagsTarget: HTMLElement;
  declare readonly tagTargets: HTMLElement[];
  declare readonly tagTemplateTarget: HTMLTemplateElement;
  declare readonly statusTarget: HTMLElement;
  declare readonly fieldsTarget: HTMLElement;
  declare readonly hasListTarget: boolean;
  declare readonly hasInputTarget: boolean;
  declare readonly hasTagsTarget: boolean;
  declare readonly hasTagTemplateTarget: boolean;
  declare readonly hasStatusTarget: boolean;
  declare readonly hasFieldsTarget: boolean;

  declare maxValue: number;
  declare nameValue: string;
  declare formValue: string;
  declare readonly hasFormValue: boolean;

  /** Stable id of the active option; the current target is resolved from the DOM. */
  #activeOptionId: string | null = null;
  /** Whether the root borrowed a tab stop to catch focus, so teardown can undo it. */
  readonly #tabindex = new TabindexLoan();
  /** Prevents initial/teardown target callbacks from mutating authored DOM. */
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
  readonly #roving = new RovingTabindex(() => this.#removeButtons);

  /** Starts closed, syncs chips for any pre-selected options, and listens out. */
  override connect(): void {
    if (this.hasInputTarget) this.#composition.observe(this.inputTarget);
    this.#normalizeSelection();
    this.close();
    if (this.hasTagsTarget) {
      this.tagsTarget.addEventListener("keydown", this.#onTagKeydown);
      this.tagsTarget.addEventListener("click", this.#onTagClick);
      this.#rebuildTags();
    }
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
    if (!this.hasTagsTarget) return;
    for (const tag of this.tagTargets) tag.remove();
    for (const option of this.#selectedOptions) this.#appendTag(option);
    if (this.#removeButtons.length > 0) this.#roving.setActive(0);
  }

  /** Tears down document and chip listeners on disconnect (Turbo included). */
  override disconnect(): void {
    this.#connected = false;
    this.#reconcile.cancel();
    this.#composition.disconnect();
    this.#ignorePostCompositionInput = false;
    if (this.hasTagsTarget) {
      this.tagsTarget.removeEventListener("keydown", this.#onTagKeydown);
      this.tagsTarget.removeEventListener("click", this.#onTagClick);
    }
    document.removeEventListener("click", this.#onOutsideClick, true);
    this.#releaseTabindex();
  }

  /** Reconciles active state after an option target is added at runtime. */
  optionTargetConnected(): void {
    this.#scheduleOptionReconcile();
  }

  /** Cleans a removed target and reconciles active state against the surviving DOM. */
  optionTargetDisconnected(option: HTMLElement): void {
    if (!this.#connected) return;
    // `#setActive` can only scan current targets; clean the old node explicitly in
    // case a Turbo morph reuses it elsewhere.
    option.removeAttribute("data-active");
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

    this.#normalizeSelection();
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
  }

  /**
   * Gives every option an explicit `aria-selected`, without changing which ones
   * the author chose. An absent value means "not selectable" in ARIA, so a
   * forgotten attribute hides a selectable option. Several `true` is the normal
   * case here — the list is `aria-multiselectable` — so nothing is dropped.
   */
  #normalizeSelection(): void {
    for (const option of this.optionTargets) {
      if (option.getAttribute("aria-selected") !== "true") {
        option.setAttribute("aria-selected", "false");
      }
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
    if (!this.hasListTarget || !this.hasInputTarget) return;
    this.listTarget.hidden = false;
    this.inputTarget.setAttribute("aria-expanded", "true");
    if (!this.#activeOption) this.#setActive(this.#visibleOptions[0] ?? null);
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
    if (!this.hasListTarget) return;
    this.listTarget.hidden = true;
    this.#setActive(null);
    if (!this.hasInputTarget) return;
    this.inputTarget.setAttribute("aria-expanded", "false");
  }

  /** Routes input keyboard interaction per the multi-select combobox model. */
  onKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key must not ALSO open the
    // list or move the active option — composition depends on this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
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
          const buttons = this.#removeButtons;
          if (buttons.length > 0) {
            event.preventDefault();
            this.#removeTagAt(buttons.length - 1);
          }
        }
        break;
      case "ArrowLeft":
        if (this.inputTarget.value === "" && this.#removeButtons.length > 0) {
          event.preventDefault();
          this.#roving.setActive(this.#removeButtons.length - 1, { focus: true });
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
   * Tab stop, handed back on teardown). Focus that landed on a real element is
   * left alone, so a chip removed out of band never steals it.
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

  /**
   * Removes the chip whose remove button was clicked, deselecting its option.
   * Delegated on the tags container (like `#onTagKeydown`) rather than bound
   * per chip via `data-action`, so it works the instant a chip is appended without
   * waiting on Stimulus to wire a freshly created element.
   */
  readonly #onTagClick = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement).closest("button");
    if (!button || !this.tagsTarget.contains(button)) return;
    const index = this.#removeButtons.indexOf(button as HTMLButtonElement);
    if (index !== -1) this.#removeTagAt(index);
  };

  /** Moves the active option by `delta` among visible options, wrapping. */
  #moveActive(delta: number): void {
    const visible = this.#visibleOptions;
    if (visible.length === 0) return;
    const current = this.#activeOption ? visible.indexOf(this.#activeOption) : -1;
    const candidate = current === -1 ? (delta > 0 ? 0 : visible.length - 1) : current + delta;
    const next = (candidate + visible.length) % visible.length;
    this.#setActive(visible[next] ?? null);
  }

  /** Selects/deselects `option`, honoring `max`, and syncs chip + live region. */
  #toggleSelection(option: HTMLElement): void {
    const selected = option.getAttribute("aria-selected") === "true";
    if (!selected && this.maxValue > 0 && this.#selectedOptions.length >= this.maxValue) {
      return;
    }
    option.setAttribute("aria-selected", String(!selected));
    if (selected) {
      this.#removeTagFor(option);
    } else {
      this.#appendTag(option);
    }
    this.#announce(this.#optionLabel(option));
    this.#refreshRoving();
    this.#syncFields();
    this.dispatch("change", { detail: { values: this.#values } });
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
      const option = options.get(tag.dataset.value ?? "");
      if (!option) continue;
      const text = this.#optionLabel(option);
      const label = tag.querySelector<HTMLElement>('[data-multi-select-slot="label"]');
      if (label && label.textContent !== text) label.textContent = text;
      const button = tag.querySelector("button");
      const name = `Remove ${text}`;
      if (button && button.getAttribute("aria-label") !== name) {
        button.setAttribute("aria-label", name);
      }
    }
  }

  /** Builds one chip from the template for `option`. */
  #appendTag(option: HTMLElement): void {
    if (!this.hasTagTemplateTarget || !this.hasTagsTarget) return;
    const fragment = this.tagTemplateTarget.content.cloneNode(true) as DocumentFragment;
    const tag = fragment.querySelector<HTMLElement>('[data-stimeo--multi-select-target="tag"]');
    const label = fragment.querySelector<HTMLElement>('[data-multi-select-slot="label"]');
    const button = fragment.querySelector<HTMLButtonElement>("button");
    if (!tag || !button) return;
    const text = this.#optionLabel(option);
    tag.dataset.value = this.#optionValue(option);
    if (label) label.textContent = text;
    button.setAttribute("aria-label", `Remove ${text}`);
    button.tabIndex = -1;
    this.tagsTarget.appendChild(fragment);
  }

  /** Removes the chip mirroring `option`, if present. */
  #removeTagFor(option: HTMLElement): void {
    const value = this.#optionValue(option);
    const tag = this.tagTargets.find((candidate) => candidate.dataset.value === value);
    tag?.remove();
  }

  /** Removes chip `index` and deselects its option, re-homing focus. */
  #removeTagAt(index: number): void {
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
    this.#announce(option ? this.#optionLabel(option) : value);
    this.#refreshRoving();
    this.#syncFields();
    this.dispatch("change", { detail: { values: this.#values } });

    const remaining = this.#removeButtons;
    if (remaining.length === 0) {
      this.#focusAfterLastTag();
    } else {
      this.#roving.setActive(Math.min(index, remaining.length - 1), { focus: true });
    }
  }

  /** Arrow navigation and deletion within the chip list (delegated). */
  readonly #onTagKeydown = (event: KeyboardEvent): void => {
    // A descendant widget that already claimed the key must not ALSO move the
    // chip focus — composition depends on this yield. Chips render from the
    // consumer's template, so an arbitrary widget can live inside one.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    const button = (event.target as HTMLElement).closest("button");
    if (!button) return;
    const buttons = this.#removeButtons;
    const index = buttons.indexOf(button);
    if (index === -1) return;
    // Logical, not physical. The key is normalised rather than a new case added:
    // the two horizontal branches are not mirror images — only one guards its
    // edge, and the other hands focus back to the input — so swapping the key
    // keeps each branch, guards and all, with its own direction. Both handlers
    // read the same element on purpose; probing the focused child would let the
    // input and the chips disagree at the boundary between them.
    switch (logicalArrowKey(event.key, this.element)) {
      case "ArrowLeft":
        if (index > 0) {
          event.preventDefault();
          this.#roving.setActive(index - 1, { focus: true });
        }
        break;
      case "ArrowRight":
        event.preventDefault();
        if (index < buttons.length - 1) this.#roving.setActive(index + 1, { focus: true });
        else this.#focusInput();
        break;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        this.#removeTagAt(index);
        break;
      default:
        break;
    }
  };

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
    const idref = this.hasInputTarget
      ? this.inputTarget.getAttribute("aria-activedescendant")
      : null;
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
    if (this.#removeButtons.length > 0 && this.#roving.activeIndex === -1)
      this.#roving.setActive(0);
  }

  /** Mirrors the changed option label into the live region. */
  #announce(text: string): void {
    if (this.hasStatusTarget) this.statusTarget.textContent = text;
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
    const activeId = this.#activeOptionId;
    if (activeId === null) return null;
    return this.optionTargets.find((option) => option.id === activeId) ?? null;
  }

  /** Options currently selected. */
  get #selectedOptions(): HTMLElement[] {
    return this.optionTargets.filter((option) => option.getAttribute("aria-selected") === "true");
  }

  /** Selected values in option order. */
  get #values(): string[] {
    return this.#selectedOptions.map((option) => this.#optionValue(option));
  }

  /** The chip remove buttons in order (the roving navigation set). */
  get #removeButtons(): HTMLButtonElement[] {
    return this.hasTagsTarget
      ? Array.from(this.tagsTarget.querySelectorAll<HTMLButtonElement>("button"))
      : [];
  }

  /** Whether the list is currently hidden. */
  get #isClosed(): boolean {
    return !this.hasListTarget || this.listTarget.hidden !== false;
  }
}
