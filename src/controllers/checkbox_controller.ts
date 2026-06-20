import { Controller } from "@hotwired/stimulus";

/** Aggregate selection state of a parent/child checkbox group. */
type CheckboxState = "all" | "partial" | "none";

/**
 * Headless, accessible checkbox behavior (including the tri-state / parent-child
 * "select all" pattern).
 *
 * Markup contract (identifier: `stimeo--checkbox`):
 *   <fieldset data-controller="stimeo--checkbox" role="group" aria-labelledby="all-label">
 *     <label id="all-label">
 *       <input type="checkbox" data-stimeo--checkbox-target="parent"
 *              data-action="change->stimeo--checkbox#onParentChange" /> Select all
 *     </label>
 *     <label><input type="checkbox" data-stimeo--checkbox-target="child"
 *              data-action="change->stimeo--checkbox#onChildChange" /> Item A</label>
 *     <!-- more children -->
 *   </fieldset>
 *
 * Implements the WAI-ARIA APG **Checkbox** pattern. Native `<input type="checkbox">`
 * is used throughout (so Space toggle, focus order, and `mixed` exposure are the
 * browser's); the controller adds what HTML cannot express: the parent's
 * `indeterminate` property (announced as `mixed`) derived from its children, and
 * the cascade from a parent toggle to its children.
 *
 * @remarks
 * Behavior only — the check mark and any "mixed" affordance are the consumer's
 * CSS (keyed off `:checked` / `:indeterminate` / `data-state`). A lone tri-state
 * checkbox can use just `parent` and drive `indeterminate` externally.
 *
 * Behavior provided:
 * - Parent toggle checks/unchecks every child and clears its own `indeterminate`.
 * - A child change recomputes the parent: all → checked, none → unchecked,
 *   some → `indeterminate`.
 * - The aggregate (`all` / `partial` / `none`) is mirrored to `data-state` on the
 *   root, and `stimeo--checkbox:change` is dispatched on every change.
 */
export class CheckboxController extends Controller<HTMLElement> {
  static override targets = ["parent", "child"];
  static actions = ["onChildChange", "onParentChange"] as const;
  static events = ["change"] as const;

  declare readonly parentTarget: HTMLInputElement;
  declare readonly hasParentTarget: boolean;
  declare readonly childTargets: HTMLInputElement[];

  /** Reflects the initial aggregate (e.g. from server-rendered child states). */
  override connect(): void {
    if (this.childTargets.length > 0) {
      this.#syncFromChildren(false);
    } else {
      this.element.setAttribute("data-state", this.#aggregate());
    }
  }

  /** Cascades the parent's state to every child. Bound via `data-action` (change). */
  onParentChange(): void {
    if (!this.hasParentTarget) return;
    const checked = this.parentTarget.checked;
    for (const child of this.childTargets) {
      child.checked = checked;
    }
    this.parentTarget.indeterminate = false;
    const state: CheckboxState = checked ? "all" : "none";
    this.element.setAttribute("data-state", state);
    this.dispatch("change", { detail: { checked, indeterminate: false, state } });
  }

  /** Recomputes the parent from its children. Bound via `data-action` (change). */
  onChildChange(): void {
    this.#syncFromChildren(true);
  }

  /**
   * Derives the parent's `checked`/`indeterminate` and the root `data-state` from
   * the children, optionally dispatching `change`.
   */
  #syncFromChildren(dispatch: boolean): void {
    const state = this.#aggregate();
    if (this.hasParentTarget) {
      this.parentTarget.checked = state === "all";
      this.parentTarget.indeterminate = state === "partial";
    }
    this.element.setAttribute("data-state", state);
    if (dispatch) {
      this.dispatch("change", {
        detail: {
          checked: this.hasParentTarget ? this.parentTarget.checked : state === "all",
          indeterminate: this.hasParentTarget ? this.parentTarget.indeterminate : false,
          state,
        },
      });
    }
  }

  /**
   * Computes the aggregate state. With children it counts them; with none it
   * reads the parent so a lone tri-state checkbox still reports a state without
   * its externally-set `indeterminate` being clobbered.
   */
  #aggregate(): CheckboxState {
    const children = this.childTargets;
    if (children.length === 0) {
      if (this.hasParentTarget && this.parentTarget.indeterminate) return "partial";
      return this.hasParentTarget && this.parentTarget.checked ? "all" : "none";
    }
    const checked = children.filter((child) => child.checked).length;
    if (checked === 0) return "none";
    if (checked === children.length) return "all";
    return "partial";
  }
}
