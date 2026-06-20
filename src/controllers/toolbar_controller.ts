import { Controller } from "@hotwired/stimulus";
import { RovingTabindex, type RovingWrap, rovingMove } from "../utils/roving_tabindex";

/**
 * Headless, accessible toolbar behavior.
 *
 * Markup contract (identifier: `stimeo--toolbar`):
 *   <div data-controller="stimeo--toolbar" role="toolbar" aria-label="Text formatting"
 *        data-stimeo--toolbar-orientation-value="horizontal">
 *     <button type="button" data-stimeo--toolbar-target="control"
 *             data-action="keydown->stimeo--toolbar#onKeydown">Bold</button>
 *     <!-- more controls; exactly one tabindex=0 -->
 *   </div>
 *
 * Implements the WAI-ARIA APG **Toolbar** pattern: the group is a single Tab
 * stop (roving tabindex) and the arrow keys move focus between controls. Each
 * control's own function (press, toggle, open a menu) stays with that element or
 * its own controller — the toolbar only owns navigation.
 *
 * @remarks
 * Behavior only. The roving mechanics are delegated to {@link RovingTabindex};
 * orientation and wrap policy stay here per the APG (they differ per widget).
 *
 * Behavior provided:
 * - Exactly one control is tabbable (`tabindex="0"`); the rest are `-1`.
 * - `ArrowRight`/`ArrowLeft` (horizontal) or `ArrowDown`/`ArrowUp` (vertical)
 *   move focus to the next/previous control; `Home`/`End` to the first/last.
 * - With `wrap=true` movement cycles past the ends; with `wrap=false` it stops.
 * - Returning focus from outside lands on the most recently active control,
 *   because that is the one left tabbable.
 */
export class ToolbarController extends Controller<HTMLElement> {
  static override targets = ["control"];
  static override values = {
    orientation: { type: String, default: "horizontal" },
    wrap: { type: Boolean, default: true },
  };
  static actions = ["onKeydown"] as const;

  declare readonly controlTargets: HTMLElement[];
  declare orientationValue: string;
  declare wrapValue: boolean;

  readonly #roving = new RovingTabindex(() => this.controlTargets);

  /**
   * Establishes the single tab stop: keep an existing one if it is still
   * navigable, else the first navigable control. Disabled / hidden controls are
   * skipped so the toolbar's lone Tab stop never lands on an unfocusable element
   * (which would make the whole group unreachable on Tab re-entry).
   */
  override connect(): void {
    const active = this.#roving.activeIndex;
    const activeEl = active === -1 ? null : this.controlTargets[active];
    if (activeEl && this.#isNavigable(activeEl)) {
      this.#roving.setActive(active);
      return;
    }
    const first = this.#navigableControls[0];
    this.#roving.setActive(first ? this.controlTargets.indexOf(first) : -1);
  }

  /** Arrow/Home/End move focus and the single tab stop. Bound via `data-action`. */
  onKeydown(event: KeyboardEvent): void {
    const navigable = this.#navigableControls;
    const current = navigable.indexOf(event.currentTarget as HTMLElement);
    if (current === -1) return;

    const length = navigable.length;
    const wrap: RovingWrap = this.wrapValue ? "wrap" : "clamp";
    const vertical = this.orientationValue === "vertical";
    const forwardKey = vertical ? "ArrowDown" : "ArrowRight";
    const backwardKey = vertical ? "ArrowUp" : "ArrowLeft";

    let next: number;
    if (event.key === forwardKey) {
      next = rovingMove(current, length, 1, wrap);
    } else if (event.key === backwardKey) {
      next = rovingMove(current, length, -1, wrap);
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const target = navigable[next];
    if (target) this.#roving.setActive(this.controlTargets.indexOf(target), { focus: true });
  }

  /** Controls eligible for the roving tab stop (excludes disabled / hidden). */
  get #navigableControls(): HTMLElement[] {
    return this.controlTargets.filter((control) => this.#isNavigable(control));
  }

  /**
   * A control can hold the tab stop unless it is `hidden`, `aria-disabled`, or a
   * natively `disabled` form control. CSS-only visibility cannot be detected
   * headlessly and stays the consumer's responsibility.
   */
  #isNavigable(control: HTMLElement): boolean {
    if (control.hasAttribute("hidden")) return false;
    if (control.getAttribute("aria-disabled") === "true") return false;
    return !(control as HTMLButtonElement | HTMLInputElement).disabled;
  }
}
