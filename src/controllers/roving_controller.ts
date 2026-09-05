import { Controller } from "@hotwired/stimulus";
import { hasModifierChord, isReservedArrowChord } from "../utils/arrow_step";
import { inheritsFieldsetDisabled } from "../utils/focus_candidate";
import { isRtl } from "../utils/logical_scroll";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { RovingTabindex, type RovingWrap, rovingMove } from "../utils/roving_tabindex";

/** Attributes that change whether an item can hold the Tab stop. */
const STATE_ATTRIBUTES = ["disabled", "hidden"];

/**
 * Headless **roving tabindex**: makes a set of `item`s a single Tab stop and
 * moves focus between them with the arrow keys — the APG roving-tabindex
 * technique, surfaced as a standalone controller. It is the policy layer over the
 * shared {@link RovingTabindex} util (the same split `stimeo--focus` makes over its trap),
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
 * `change` when a key press or an incoming focus moves the tabbable item; connect
 * and target reconciliation re-establish the tab stop silently.
 *
 * Items that cannot take focus — `hidden` (their own attribute or a wrapper's up
 * to the container) and natively `disabled`, including through a disabled
 * `fieldset` — are neither move targets nor tab-stop candidates: the lone
 * `tabindex="0"` sitting on one would take the whole set out of the Tab sequence
 * while focus stayed behind. `aria-disabled` items stay reachable; suppressing
 * their activation belongs to the consuming pattern. A key that resolves to no
 * reachable item is left to the page (unlike Toolbar, which consumes it).
 *
 * `change` dispatches `{ index, item }`.
 *
 * @remarks
 * Behavior only: it owns `tabindex` and focus movement, nothing else. It does
 * **not** assign roles (`role="toolbar"`/`"radiogroup"` is the author's), manage
 * selection / selection-follows-focus, typeahead, or activation (`Enter`/`Space`)
 * — those stay with the consuming pattern. `connect()` is idempotent: it keeps an
 * existing tab stop (reads it back from the DOM) and only defaults to the first
 * reachable item when none is set, so a Turbo cache restore / morph never resets
 * the user's position. Re-establishing the stop after a batch of item changes
 * follows DOM focus first, so an item added and focused in the same task keeps it;
 * `connect()` deliberately does not, because the authored DOM is what it reads
 * back. The delegated listeners and the state observer are torn down on
 * `disconnect()`.
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
  readonly #reconcile = new MicrotaskCoalescer(() => this.#ensureTabStop(true));
  #connected = false;
  #observer: MutationObserver | null = null;

  override connect(): void {
    // Establish the single tab stop from the DOM (source of truth): keep an
    // existing tabbable item, else default to the first. Silent — no change event
    // for the initial mount.
    this.#ensureTabStop(false);
    this.element.addEventListener("keydown", this.#onKeydown);
    this.element.addEventListener("focusin", this.#onFocusin);
    this.#watchState();
    this.#connected = true;
    this.#reconcile.activate();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#reconcile.cancel();
    this.element.removeEventListener("keydown", this.#onKeydown);
    this.element.removeEventListener("focusin", this.#onFocusin);
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /** Drops a runtime-added item from the Tab sequence before batch reconciliation. */
  itemTargetConnected(item: HTMLElement): void {
    if (!this.#connected) return;
    item.tabIndex = -1;
    this.#reconcile.schedule();
  }

  /** Re-establishes the single Tab stop after an item leaves the target set. */
  itemTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Arrow keys move focus + the tab stop; Home/End jump to the ends. */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    // A descendant widget that already claimed the key (e.g. a grabbed
    // `stimeo--pointer-drag` handle consuming arrows to move an item) must not
    // ALSO move the roving focus — composition depends on this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    // A key pressed to steer an IME candidate list belongs to the composition.
    if (event.isComposing) return;
    const current = this.#indexOf(event.target);
    if (current === -1) return;

    const wrap: RovingWrap = this.wrapValue ? "wrap" : "clamp";
    const orientation = this.orientationValue;
    const horizontal = orientation === "horizontal" || orientation === "both";
    const vertical = orientation === "vertical" || orientation === "both";

    // Logical, not physical. APG defines these as "next / previous
    // control", and says a vertical arrangement swaps in Down/Up for the same
    // meaning — so the pair is one axis's spelling of an order, and the order
    // reverses with the writing direction. Read from the controller element: the
    // container is what lays the items out, and a child may carry its own `dir`
    // (an LTR input inside an RTL form is ordinary authoring).
    // Only the horizontal pair reverses; `orientation="both"` keeps Down/Up as-is.
    const rtl = horizontal && isRtl(this.element);
    const forwardKey = rtl ? "ArrowLeft" : "ArrowRight";
    const backwardKey = rtl ? "ArrowRight" : "ArrowLeft";

    let next: number;
    if ((horizontal && event.key === forwardKey) || (vertical && event.key === "ArrowDown")) {
      next = this.#step(current, 1, wrap);
    } else if ((horizontal && event.key === backwardKey) || (vertical && event.key === "ArrowUp")) {
      next = this.#step(current, -1, wrap);
    } else if (this.homeEndValue && (event.key === "Home" || event.key === "End")) {
      // Chorded Home/End are the browser's document jumps; APG gives the widget
      // no modifier combination for them.
      if (hasModifierChord(event)) return;
      next = event.key === "Home" ? this.#firstReachable() : this.#lastReachable();
    } else {
      return;
    }

    if (next === -1) return;
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
    if (index === -1 || !this.#reachable(index)) return;
    this.#activate(index, false);
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

  /**
   * Keeps the Tab stop on a reachable item.
   *
   * `followFocus` is on for re-establishment only: an item added and focused in
   * the same task has already claimed the stop through `focusin`, and the batch
   * that follows must not hand it back to the first item. `connect()` passes it
   * off so the authored DOM decides the initial stop. With nothing reachable the
   * DOM is left as it is — a group inside a collapsed region gets its stop back
   * when the region opens, instead of losing it for good.
   */
  #ensureTabStop(followFocus: boolean): void {
    const items = this.itemTargets;
    const focused = followFocus
      ? items.findIndex((item, i) => item === document.activeElement && this.#reachable(i))
      : -1;
    const active = this.#roving.activeIndex;
    const kept = active !== -1 && this.#reachable(active) ? active : -1;
    const index = focused !== -1 ? focused : kept !== -1 ? kept : this.#firstReachable();
    if (index === -1) return;
    this.#roving.setActive(index);
  }

  /**
   * Resolves the next reachable index in `delta`'s direction, honouring `wrap`.
   *
   * An arrow on the widget's own axis is the widget's to consume even when the
   * position does not change, so a clamped end resolves to the current item
   * rather than to nothing. An unreachable origin escapes to the first reachable
   * item instead of sitting in a dead end, and `-1` is left for the one case that
   * really is not ours: no reachable item anywhere.
   */
  #step(current: number, delta: number, wrap: RovingWrap): number {
    const length = this.itemTargets.length;
    let index = current;
    for (let taken = 0; taken < length; taken += 1) {
      const candidate = rovingMove(index, length, delta, wrap);
      if (candidate === index) break; // clamped at an end
      index = candidate;
      if (this.#reachable(index)) return index;
    }
    return this.#reachable(current) ? current : this.#firstReachable();
  }

  /** Index of the first reachable item, or `-1`. */
  #firstReachable(): number {
    return this.itemTargets.findIndex((_item, i) => this.#reachable(i));
  }

  /** Index of the last reachable item, or `-1`. */
  #lastReachable(): number {
    for (let i = this.itemTargets.length - 1; i >= 0; i -= 1) {
      if (this.#reachable(i)) return i;
    }
    return -1;
  }

  /**
   * Whether the item at `index` can hold the Tab stop and take focus.
   *
   * `aria-disabled` is deliberately not consulted: it keeps an item reachable and
   * only suppresses activation, which this part does not own.
   */
  #reachable(index: number): boolean {
    const item = this.itemTargets[index];
    if (!item) return false;
    if (this.#hidden(item)) return false;
    if (!("disabled" in item)) return true;
    if ((item as HTMLElement & { disabled: boolean }).disabled) return false;
    return !inheritsFieldsetDisabled(item);
  }

  /**
   * Whether `item`, or anything between it and the container, is `hidden`.
   *
   * The walk stops at the container on purpose: a group inside a hidden region is
   * already out of the page's Tab order, and calling every item unreachable there
   * would drop the stop with nothing left to restore it — the ancestor lies
   * outside the subtree whose state attributes are watched.
   */
  #hidden(item: HTMLElement): boolean {
    let node: HTMLElement | null = item;
    while (node && node !== this.element) {
      if (node.hasAttribute("hidden")) return true;
      node = node.parentElement;
    }
    return false;
  }

  /**
   * Watches the attributes that decide reachability, so disabling the item that
   * holds the Tab stop hands it to another one instead of taking the whole set
   * out of the Tab sequence. An enclosing `fieldset` disables items from outside
   * the observed subtree, so each one's own `disabled` is watched too.
   */
  #watchState(): void {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => this.#reconcile.schedule());
    observer.observe(this.element, {
      subtree: true,
      attributes: true,
      attributeFilter: STATE_ATTRIBUTES,
    });
    for (
      let fieldset = this.element.parentElement?.closest("fieldset") ?? null;
      fieldset;
      fieldset = fieldset.parentElement?.closest("fieldset") ?? null
    ) {
      observer.observe(fieldset, { attributes: true, attributeFilter: ["disabled"] });
    }
    this.#observer = observer;
  }
}
