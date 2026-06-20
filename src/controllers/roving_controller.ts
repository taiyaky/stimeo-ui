import { Controller } from "@hotwired/stimulus";
import { RovingTabindex, type RovingWrap, rovingMove } from "../utils/roving_tabindex";

/**
 * Headless **roving tabindex**: makes a set of `item`s a single Tab stop and
 * moves focus between them with the arrow keys — the APG roving-tabindex
 * technique, surfaced as a standalone controller. It is the policy layer over the
 * shared {@link RovingTabindex} util (counterpart to Focus Scope over `FocusTrap`),
 * giving the orientation / wrap / Home-End the util deliberately leaves out. No
 * dedicated APG pattern; it is the keyboard primitive Toolbar / Menu / Radio Group
 * and friends build on. Core (zero dependencies).
 *
 * Markup contract (identifier: `stimeo--roving`):
 *   <div data-controller="stimeo--roving"
 *        data-stimeo--roving-orientation-value="horizontal">
 *     <button data-stimeo--roving-target="item">A</button>
 *     <button data-stimeo--roving-target="item">B</button>
 *     <button data-stimeo--roving-target="item">C</button>
 *   </div>
 *
 * Exactly one item is tabbable (`tabindex="0"`); the arrow keys (per
 * `orientation`) move focus and that tab stop together, `Home`/`End` jump to the
 * ends (`homeEnd`), and `wrap` cycles past the ends or clamps at them. Listeners
 * are **delegated on the container** — `keydown` for movement and `focusin` to
 * sync the tab stop when focus arrives by click or programmatically — so
 * dynamically added/removed items need no per-item `data-action`. It emits
 * `change` whenever the tabbable item changes.
 *
 * @remarks
 * Behavior only: it owns `tabindex` and focus movement, nothing else. It does
 * **not** assign roles (`role="toolbar"`/`"radiogroup"` is the author's), manage
 * selection / selection-follows-focus, typeahead, or activation (`Enter`/`Space`)
 * — those stay with the consuming pattern. `connect()` is idempotent: it keeps an
 * existing tab stop (reads it back from the DOM) and only defaults to the first
 * item when none is set, so a Turbo cache restore / morph never resets the user's
 * position. The delegated listeners are torn down on `disconnect()`.
 */
export class RovingController extends Controller<HTMLElement> {
  static override targets = ["item"];
  static override values = {
    orientation: { type: String, default: "horizontal" },
    wrap: { type: Boolean, default: true },
    homeEnd: { type: Boolean, default: true },
  };
  static events = ["change"] as const;

  declare readonly itemTargets: HTMLElement[];
  declare orientationValue: string;
  declare wrapValue: boolean;
  declare homeEndValue: boolean;

  readonly #roving = new RovingTabindex(() => this.itemTargets);

  override connect(): void {
    // Establish the single tab stop from the DOM (source of truth): keep an
    // existing tabbable item, else default to the first. Silent — no change event
    // for the initial mount.
    const active = this.#roving.activeIndex;
    this.#roving.setActive(active === -1 ? 0 : active);
    this.element.addEventListener("keydown", this.#onKeydown);
    this.element.addEventListener("focusin", this.#onFocusin);
  }

  override disconnect(): void {
    this.element.removeEventListener("keydown", this.#onKeydown);
    this.element.removeEventListener("focusin", this.#onFocusin);
  }

  /** Arrow keys move focus + the tab stop; Home/End jump to the ends. */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    const items = this.itemTargets;
    const current = this.#indexOf(event.target);
    if (current === -1) return;

    const length = items.length;
    const wrap: RovingWrap = this.wrapValue ? "wrap" : "clamp";
    const orientation = this.orientationValue;
    const horizontal = orientation === "horizontal" || orientation === "both";
    const vertical = orientation === "vertical" || orientation === "both";

    let next: number;
    if ((horizontal && event.key === "ArrowRight") || (vertical && event.key === "ArrowDown")) {
      next = rovingMove(current, length, 1, wrap);
    } else if ((horizontal && event.key === "ArrowLeft") || (vertical && event.key === "ArrowUp")) {
      next = rovingMove(current, length, -1, wrap);
    } else if (this.homeEndValue && event.key === "Home") {
      next = 0;
    } else if (this.homeEndValue && event.key === "End") {
      next = length - 1;
    } else {
      return;
    }

    event.preventDefault();
    this.#activate(next, true);
  };

  /**
   * Syncs the single tab stop to an item that received focus by other means
   * (click, programmatic `focus()`), so returning via Tab lands on it. The
   * keyboard path's own `focus()` re-enters here but is a no-op (index unchanged).
   */
  readonly #onFocusin = (event: FocusEvent): void => {
    const index = this.#indexOf(event.target);
    if (index !== -1) this.#activate(index, false);
  };

  /** Resolves the item index owning an event target (the item or a descendant). */
  #indexOf(target: EventTarget | null): number {
    const node = target as Node | null;
    if (!node) return -1;
    return this.itemTargets.findIndex((item) => item === node || item.contains(node));
  }

  /** Makes `index` the tab stop (optionally focusing it), emitting `change` once. */
  #activate(index: number, focus: boolean): void {
    const previous = this.#roving.activeIndex;
    this.#roving.setActive(index, { focus });
    if (index !== previous) {
      this.dispatch("change", { detail: { index, item: this.itemTargets[index] } });
    }
  }
}
