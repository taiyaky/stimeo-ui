import { Controller } from "@hotwired/stimulus";

/** A control whose "on" state contributes its token to the active filter set. */
type FilterControl = HTMLElement;

/**
 * Headless faceted-filter behavior: shows or hides a collection of items based on the
 * set of currently-active facet tokens, decoupled from how those tokens are toggled
 * (native checkboxes/radios, or button toggles such as `stimeo--toggle-group`).
 *
 * Markup contract (identifier: `stimeo--filter`):
 *   <div data-controller="stimeo--filter" data-stimeo--filter-match-value="all">
 *     <!-- controls: each contributes its token while "on" (aria-pressed / checked) -->
 *     <button type="button" aria-pressed="false" data-value="apg:dialog"
 *             data-stimeo--filter-target="control">Dialog</button>
 *     <!-- items: filtered in/out by their space-separated tokens -->
 *     <li data-stimeo--filter-target="item"
 *         data-stimeo--filter-tokens="apg:dialog overlay">…</li>
 *     <!-- optional: a container hidden once it holds no visible item -->
 *     <section data-stimeo--filter-target="group">…</section>
 *     <!-- optional: an element revealed when nothing matches -->
 *     <p data-stimeo--filter-target="empty" hidden>No matches</p>
 *   </div>
 *
 * `match` decides how multiple active tokens combine: `all` (default — an item must
 * carry every active token) or `any` (at least one). With no active token every item
 * is shown. Items are toggled via `hidden`; groups with zero visible items and the
 * `empty` element are kept in sync, and `stimeo--filter:change` is dispatched.
 *
 * `change` dispatches `{ active, visible, total }`.
 *
 * @remarks
 * Behavior only — the consumer owns all styling and the controls' own accessible
 * state (e.g. `aria-pressed`); the one exception is `clear`, which writes those
 * controls one way, to off. Visibility is re-derived from the live DOM on
 * `connect()`, on every native `change` that bubbles to the root, on the `apply`
 * and `clear` actions, and when `match` changes at runtime — the declaration
 * decides what is shown, so an element kept across a morph still follows it.
 * Button toggles that emit no native `change` wire their event to the `apply`
 * action (e.g. `stimeo--toggle-group:change->stimeo--filter#apply`).
 */
export class FilterController extends Controller<HTMLElement> {
  static override targets = ["item", "control", "group", "empty"];
  static override values = { match: { type: String, default: "all" } };
  static actions = ["apply", "clear"] as const;
  static events = ["change"] as const;

  declare readonly itemTargets: HTMLElement[];
  declare readonly controlTargets: FilterControl[];
  declare readonly groupTargets: HTMLElement[];
  declare readonly emptyTargets: HTMLElement[];

  declare matchValue: string;

  readonly #onChange = (): void => {
    this.apply();
  };

  /**
   * Gates the declaration callback to the connected window.
   *
   * Stimulus delivers a Value callback ahead of `connect()` and again for every
   * runtime change; without the gate, merely connecting would emit an evaluation
   * — and its `change` — before `connect()` runs its own.
   */
  #connected = false;

  override connect(): void {
    this.#evaluate();
    this.element.addEventListener("change", this.#onChange);
    this.#connected = true;
  }

  override disconnect(): void {
    this.#connected = false;
    this.element.removeEventListener("change", this.#onChange);
  }

  /**
   * Re-evaluates when the match declaration changes at runtime.
   *
   * The declaration decides which items are shown, so an element kept across a
   * morph — where `connect()` does not run again — still has to follow it instead
   * of waiting for the next control interaction. The evaluation is the ordinary
   * one, `change` included: a declaration swap is an evaluation like any other.
   */
  matchValueChanged(): void {
    if (!this.#connected) return;
    this.#evaluate();
  }

  /** Re-derives every item's visibility from the active tokens and syncs groups/empty. */
  apply(): void {
    this.#evaluate();
  }

  /**
   * The evaluation itself: every item's visibility from the active tokens, then
   * the groups and the empty element, then the `change` event.
   *
   * @stimeoRenderRoot
   */
  #evaluate(): void {
    const active = this.#activeTokens();
    let visibleCount = 0;
    for (const item of this.itemTargets) {
      const visible = this.#matches(item, active);
      item.hidden = !visible;
      if (visible) visibleCount += 1;
    }

    for (const group of this.groupTargets) {
      group.hidden = !this.#hasVisibleItem(group);
    }
    for (const empty of this.emptyTargets) {
      empty.hidden = visibleCount > 0;
    }

    this.dispatch("change", {
      detail: { active, visible: visibleCount, total: this.itemTargets.length },
    });
  }

  /** Turns every control off (uncheck / aria-pressed="false") and re-applies. */
  clear(): void {
    for (const control of this.controlTargets) {
      if (control instanceof HTMLInputElement) {
        control.checked = false;
      } else if (control.hasAttribute("aria-pressed")) {
        control.setAttribute("aria-pressed", "false");
      }
    }
    this.apply();
  }

  /** The tokens of every control currently "on" (checked or aria-pressed="true"). */
  #activeTokens(): string[] {
    const tokens: string[] = [];
    for (const control of this.controlTargets) {
      if (this.#isOn(control)) tokens.push(this.#tokenOf(control));
    }
    return tokens.filter(Boolean);
  }

  /** Whether a control is in its "on" state. */
  #isOn(control: FilterControl): boolean {
    if (control instanceof HTMLInputElement) return control.checked;
    return control.getAttribute("aria-pressed") === "true";
  }

  /** A control's token: explicit `data-stimeo--filter-token`, else `data-value` / value. */
  #tokenOf(control: FilterControl): string {
    const explicit = control.getAttribute("data-stimeo--filter-token") ?? control.dataset.value;
    if (explicit) return explicit;
    return control instanceof HTMLInputElement ? control.value : "";
  }

  /** Whether an item satisfies the active token set per `match` (empty active → shown). */
  #matches(item: HTMLElement, active: string[]): boolean {
    if (active.length === 0) return true;
    const tokens = this.#tokensOf(item);
    return this.matchValue === "any"
      ? active.some((token) => tokens.includes(token))
      : active.every((token) => tokens.includes(token));
  }

  /** An item's declared tokens (`data-stimeo--filter-tokens`, space-separated). */
  #tokensOf(item: HTMLElement): string[] {
    return (item.getAttribute("data-stimeo--filter-tokens") ?? "").split(/\s+/).filter(Boolean);
  }

  /** Whether a group still contains at least one non-hidden item. */
  #hasVisibleItem(group: HTMLElement): boolean {
    return this.itemTargets.some((item) => !item.hidden && group.contains(item));
  }
}
