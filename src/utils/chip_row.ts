import { isReservedArrowChord, logicalArrowKey } from "./arrow_step";
import { RovingTabindex } from "./roving_tabindex";

/** Consumer-owned behavior that differs between removable-chip widgets. */
export interface ChipRowOptions {
  /** Element whose writing direction defines logical previous/next. */
  readonly directionElement: HTMLElement;
  /** Returns the current chip elements in navigation order. */
  readonly getItems: () => readonly HTMLElement[];
  /** Resolves the one remove button owned by a chip. Defaults to its first button. */
  readonly getButton?: (item: HTMLElement) => HTMLButtonElement | null;
  /** Removes the chip currently occupying `index`. */
  readonly onRemove: (index: number) => void;
  /** Receives focus when navigation moves past the logical end of the row. */
  readonly focusAfterEnd: () => void;
}

/**
 * Delegated interaction and roving-tabindex mechanics for a row of removable chips.
 *
 * The selection model stays in the consuming controller: this helper knows only
 * how to resolve one consumer-declared remove button per chip, move between those
 * buttons, delegate click/delete requests by index, and bind those listeners to
 * a replaceable row target. Restricting the button set to the declared chip items
 * deliberately excludes sibling controls such as an authored "Clear all" button.
 */
export class ChipRow {
  readonly #directionElement: HTMLElement;
  readonly #getItems: () => readonly HTMLElement[];
  readonly #getButton: (item: HTMLElement) => HTMLButtonElement | null;
  readonly #onRemove: (index: number) => void;
  readonly #focusAfterEnd: () => void;
  readonly #roving = new RovingTabindex(() => this.buttons);
  #container: HTMLElement | null = null;

  constructor(options: ChipRowOptions) {
    this.#directionElement = options.directionElement;
    this.#getItems = options.getItems;
    this.#getButton = options.getButton ?? ((item) => item.querySelector("button"));
    this.#onRemove = options.onRemove;
    this.#focusAfterEnd = options.focusAfterEnd;
  }

  /**
   * Binds delegation to `container`; any row currently bound is released first.
   * Idempotent for the same node, so target callbacks may call it freely.
   */
  connect(container: HTMLElement): void {
    if (this.#container === container) return;
    this.disconnect();
    this.#container = container;
    container.addEventListener("click", this.#onClick);
    container.addEventListener("keydown", this.#onKeydown);
  }

  /**
   * Releases the current row. When `container` is supplied, a stale disconnect
   * callback cannot tear listeners off a newer replacement target.
   */
  disconnect(container?: HTMLElement): void {
    const current = this.#container;
    if (!current || (container !== undefined && current !== container)) return;
    current.removeEventListener("click", this.#onClick);
    current.removeEventListener("keydown", this.#onKeydown);
    this.#container = null;
  }

  /** Current remove buttons, at most one consumer-resolved button per chip item. */
  get buttons(): HTMLButtonElement[] {
    return this.#entries.map(({ button }) => button);
  }

  /** Number of currently navigable remove buttons. */
  get length(): number {
    return this.buttons.length;
  }

  /** Declared-item index of the last navigable chip, or `-1` for an empty row. */
  get lastIndex(): number {
    return this.#entries.at(-1)?.itemIndex ?? -1;
  }

  /** Keeps exactly one button tabbable, preferring the first authored Tab stop. */
  ensureTabStop(): void {
    const buttons = this.#entries.map(({ button }) => button);
    const active = buttons.findIndex((button) => button.tabIndex === 0);
    const count = buttons.filter((button) => button.tabIndex === 0).length;
    if (buttons.length > 0 && count !== 1) {
      this.#roving.setActive(active === -1 ? 0 : active, { items: buttons });
    }
  }

  /** Focuses the last chip, returning false for an empty row. */
  focusLast(): boolean {
    const buttons = this.#entries.map(({ button }) => button);
    const last = buttons.length - 1;
    if (last < 0) return false;
    this.#roving.setActive(last, { focus: true, items: buttons });
    return true;
  }

  /**
   * Focuses the chip that followed a removed index, or the new last chip.
   * Returns false when removal emptied the row so the consumer can rescue focus.
   */
  focusAfterRemoval(index: number): boolean {
    const entries = this.#entries;
    if (entries.length === 0) return false;
    const following = entries.findIndex((entry) => entry.itemIndex >= index);
    this.#roving.setActive(following === -1 ? entries.length - 1 : following, {
      focus: true,
      items: entries.map(({ button }) => button),
    });
    return true;
  }

  /** Current remove-button entries, retaining each button's declared item index. */
  get #entries(): Array<{ button: HTMLButtonElement; itemIndex: number }> {
    return this.#getItems().flatMap((item, itemIndex) => {
      const button = this.#getButton(item);
      return button ? [{ button, itemIndex }] : [];
    });
  }

  /** Resolves a delegated event to the remove button owned by a declared chip. */
  #entry(event: Event): {
    button: HTMLButtonElement;
    buttonIndex: number;
    buttons: HTMLButtonElement[];
    itemIndex: number;
  } | null {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    const button = target.closest<HTMLButtonElement>("button");
    const entries = this.#entries;
    const buttonIndex = entries.findIndex((entry) => entry.button === button);
    if (buttonIndex === -1) return null;
    const entry = entries[buttonIndex] as { button: HTMLButtonElement; itemIndex: number };
    return { ...entry, buttonIndex, buttons: entries.map(({ button }) => button) };
  }

  /** Delegates removal clicks without waiting for Stimulus to wire a new chip. */
  readonly #onClick = (event: MouseEvent): void => {
    const entry = this.#entry(event);
    if (!entry) return;
    this.#onRemove(entry.itemIndex);
  };

  /** Applies the shared logical-arrow and removal policy within the chip row. */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || isReservedArrowChord(event)) return;
    const entry = this.#entry(event);
    if (!entry) return;
    const buttons = entry.buttons;
    const index = entry.buttonIndex;

    switch (logicalArrowKey(event.key, this.#directionElement)) {
      case "ArrowLeft":
        if (index > 0) {
          event.preventDefault();
          this.#roving.setActive(index - 1, { focus: true, items: buttons });
        }
        break;
      case "ArrowRight":
        event.preventDefault();
        if (index < buttons.length - 1) {
          this.#roving.setActive(index + 1, { focus: true, items: buttons });
        } else {
          this.#focusAfterEnd();
        }
        break;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        this.#onRemove(entry.itemIndex);
        break;
      default:
        break;
    }
  };
}
