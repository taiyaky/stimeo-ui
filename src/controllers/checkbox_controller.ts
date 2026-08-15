import { Controller } from "@hotwired/stimulus";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

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
 * CSS (keyed off `:checked` / `:indeterminate` / `data-state`). The `parent`
 * target is optional: a child-only group still exposes its aggregate on the root,
 * while a lone tri-state checkbox can use just `parent` and drive
 * `indeterminate` externally — with no `child` target the parent's own `checked`
 * and `indeterminate` stay the consumer's, because only children are
 * authoritative over them. At most one `parent` may be present.
 *
 * Behavior provided:
 * - Parent toggle checks/unchecks every child and clears its own `indeterminate`.
 *   All child targets, including disabled ones, participate; omit the target to
 *   exclude an input. The cascade does not synthesize native child `change`
 *   events — one aggregate custom event describes the action.
 * - A child change recomputes the parent: all → checked, none → unchecked,
 *   some → `indeterminate`.
 * - The aggregate (`all` / `partial` / `none`) is mirrored to `data-state` on the
 *   root. Dynamic targets, checked-attribute changes, Turbo morphs, and native
 *   form resets are reconciled from the children. Callers that assign the live
 *   `checked` property directly must dispatch `change`, because property writes
 *   are not observable by a `MutationObserver`.
 * - `stimeo--checkbox:change` is dispatched for the two public change actions;
 *   `stimeo--checkbox:reconcile` is dispatched instead when a reconciliation —
 *   not the user — moves the aggregate. Both carry `{ checked: boolean,
 *   indeterminate: boolean, state: "all" | "partial" | "none" }` and describe
 *   the aggregate even without a parent. Neither fires on connect.
 */
export class CheckboxController extends Controller<HTMLElement> {
  static override targets = ["parent", "child"];
  static actions = ["onChildChange", "onParentChange"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly parentTarget: HTMLInputElement;
  declare readonly parentTargets: HTMLInputElement[];
  declare readonly hasParentTarget: boolean;
  declare readonly childTargets: HTMLInputElement[];

  /** Collapses every lifecycle signal from one DOM update into one derived pass. */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileFromChildren());
  /** Aggregate this root last settled on, so a derived repair is reported once. */
  #committedState: CheckboxState | null = null;
  /** Watches authored checked-attribute changes on retained target elements. */
  readonly #checkedObserver = new MutationObserver((records) => {
    if (records.some((record) => this.#isManagedCheckbox(record.target))) {
      this.#reconcile.schedule();
    }
  });

  /** Reflects the initial aggregate and starts retained-DOM reconciliation. */
  override connect(): void {
    this.#reconcile.activate();
    this.#syncFromChildren();
    this.#checkedObserver.observe(this.element, {
      attributes: true,
      attributeFilter: ["checked"],
      subtree: true,
    });
    this.element.addEventListener("turbo:morph-element", this.#onMorph);
    document.addEventListener("reset", this.#onReset, true);
  }

  /** Releases the observer, global reset listener, and every pending reconciliation. */
  override disconnect(): void {
    this.#reconcile.cancel();
    this.#checkedObserver.disconnect();
    this.element.removeEventListener("turbo:morph-element", this.#onMorph);
    document.removeEventListener("reset", this.#onReset, true);
  }

  /** Reconciles the aggregate for a parent added or replaced at runtime. */
  parentTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Reconciles the aggregate after a parent target leaves the group. */
  parentTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Reconciles the aggregate for a child added at runtime. */
  childTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Reconciles the aggregate after a child leaves the group. */
  childTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Cascades the parent's state to every child. Bound via `data-action` (change). */
  onParentChange(): void {
    if (!this.hasParentTarget) return;
    const checked = this.parentTarget.checked;
    for (const child of this.childTargets) {
      child.checked = checked;
    }
    this.#reflect(checked ? "all" : "none", true);
    const detail = this.#settledDetail();
    if (detail) this.dispatch("change", { detail });
  }

  /** Recomputes the parent from its children. Bound via `data-action` (change). */
  onChildChange(): void {
    this.#syncFromChildren();
    const detail = this.#settledDetail();
    if (detail) this.dispatch("change", { detail });
  }

  /**
   * Announces an aggregate this pass derived rather than the user. `change` stays
   * reserved for the two public actions, so automation never reads a repair as an edit.
   */
  #reconcileFromChildren(): void {
    const previous = this.#committedState;
    this.#syncFromChildren();
    if (this.#committedState === previous) return;
    const detail = this.#settledDetail();
    if (detail) this.dispatch("reconcile", { detail });
  }

  /**
   * Derives the parent's `checked`/`indeterminate` and the root `data-state` from
   * the children. Writing state and reporting it are separate so the caller — not
   * a flag threaded through the write — decides which event describes the cause.
   */
  #syncFromChildren(): void {
    // A childless root reads its aggregate off the parent itself, so writing the
    // derived value back would clear a `checked` the consumer drives alongside
    // `indeterminate`. Only the children are authoritative over the parent.
    this.#reflect(this.#aggregate(), this.childTargets.length > 0);
  }

  /**
   * Reflects one aggregate state.
   *
   * @param writeParent - whether the state is authoritative over the `parent`
   * target's own `checked` / `indeterminate`.
   */
  #reflect(state: CheckboxState, writeParent: boolean): void {
    if (writeParent && this.hasParentTarget) {
      this.parentTarget.checked = state === "all";
      this.parentTarget.indeterminate = state === "partial";
    }
    this.element.setAttribute("data-state", state);
    this.#committedState = state;
  }

  /** The settled aggregate as event detail, or `null` before anything has settled. */
  #settledDetail(): { checked: boolean; indeterminate: boolean; state: CheckboxState } | null {
    const state = this.#committedState;
    if (state === null) return null;
    return { checked: state === "all", indeterminate: state === "partial", state };
  }

  /** Reconciles retained targets after Turbo has finished morphing their live state. */
  readonly #onMorph = (): void => {
    this.#reconcile.schedule();
  };

  /** Reconciles after a non-cancelled reset restores any managed checkbox. */
  readonly #onReset = (event: Event): void => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !this.#hasCheckboxOwnedBy(form)) return;
    queueMicrotask(() => {
      if (!event.defaultPrevented) this.#reconcile.schedule();
    });
  };

  /** Whether a form owns at least one current parent or child target. */
  #hasCheckboxOwnedBy(form: HTMLFormElement): boolean {
    return [...this.parentTargets, ...this.childTargets].some((checkbox) => checkbox.form === form);
  }

  /** Whether an observed attribute mutation belongs to this controller's target set. */
  #isManagedCheckbox(node: Node): boolean {
    return (
      this.parentTargets.some((checkbox) => checkbox === node) ||
      this.childTargets.some((checkbox) => checkbox === node)
    );
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
