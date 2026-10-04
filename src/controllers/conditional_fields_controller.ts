import { Controller } from "@hotwired/stimulus";
import { ownerIndex } from "../utils/event_owner";
import { canTakeFocus } from "../utils/focus_candidate";
import { FormResetWatcher } from "../utils/form_reset_watcher";
import { ListenerSet } from "../utils/listener_set";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { TabindexLoan } from "../utils/tabindex_loan";

/** Trigger controls whose live state drives region visibility. */
type Trigger = HTMLInputElement | HTMLSelectElement;
/** Form controls inside a region that can be excluded from submission. */
type Disableable = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement;
/** One logical visibility transition settled during an evaluation pass. */
type RegionTransition = { region: HTMLElement; visible: boolean };

/** Marker on controls this component disabled, so authored disabled state remains untouched. */
const DISABLED_MARKER = "data-conditional-disabled";

/** Descendant controls whose `disabled` state a region manages. */
const CONTROLS = "input, textarea, select, button";

/** Retained-DOM inputs and controller outputs that can require reconciliation. */
const OBSERVED_ATTRIBUTES = [
  "hidden",
  "aria-hidden",
  "data-visible",
  DISABLED_MARKER,
  "disabled",
  "data-when-checked",
  "data-when-unchecked",
  "data-when-value",
  "checked",
  "selected",
  "value",
  "type",
];

/** Attribute value expected after one controller-owned DOM write. */
type ExpectedAttribute = string | null;

/**
 * Headless dependent-fields behavior: shows/hides (and enables/disables) regions
 * from trigger control values while keeping submission and accessibility state in
 * sync (no dedicated APG pattern).
 *
 * Markup contract (identifier: `stimeo--conditional-fields`):
 *   <form data-controller="stimeo--conditional-fields">
 *     <input type="checkbox" data-stimeo--conditional-fields-target="trigger">
 *     <fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
 *       …address…
 *     </fieldset>
 *   </form>
 *
 * A region declares one condition: `data-when-checked`, `data-when-unchecked`,
 * or `data-when-value="x"`. The condition is combined across all triggers using
 * `match` (`"any"` by default, or `"all"`). A region with no condition preserves
 * its authored `hidden` state; a declared condition with no triggers is false.
 *
 * Hidden regions receive `hidden` and `aria-hidden="true"`; visible regions expose
 * `data-visible="true"`. With `disableHidden`, descendant controls are disabled and
 * marked with `data-conditional-disabled="true"`, and only marked controls are
 * re-enabled. Before a focused region is hidden, focus moves to the first trigger
 * that can actually receive it. If every trigger is unsafe — including one inside
 * another region being hidden in the same pass — the controller root temporarily
 * receives `tabindex="-1"` and focus.
 *
 * An element that stops being a region gets back what this controller wrote on
 * it: `aria-hidden`, `data-visible`, the `hidden` a declared condition set, and
 * the marked `disabled` of each control no hidden region still covers. The
 * `hidden` of a region without a condition and every authored `disabled` stay.
 *
 * `change` and `reconcile` dispatch `{ region, visible }`.
 *
 * @remarks
 * Behavior only. Trigger `input` / `change`, dynamic targets and descendants,
 * condition attributes, Values, native form reset, and Turbo retained-element
 * morphs all reconcile against the live DOM. Direct writes to an input's live
 * `checked` / `value` property remain observable only when the caller also emits
 * the corresponding native event. DOM repair is silent. User input or the public
 * action dispatches `stimeo--conditional-fields:change`; a lifecycle, Value,
 * reset, mutation, or morph reconciliation dispatches
 * `stimeo--conditional-fields:reconcile` instead. Initial connection is silent.
 * Every listener, observer, queued pass, and borrowed root `tabindex` is released
 * on `disconnect()`.
 */
export class ConditionalFieldsController extends Controller<HTMLElement> {
  static override targets = ["trigger", "region"];
  static override values = {
    disableHidden: { type: Boolean, default: true },
    match: { type: String, default: "any" },
  };
  static actions = ["evaluate"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly triggerTargets: Trigger[];
  declare readonly regionTargets: HTMLElement[];

  declare disableHiddenValue: boolean;
  declare matchValue: string;

  /** Logical state last committed for each current region; rebuilt on every connect. */
  #lastVisible = new WeakMap<HTMLElement, boolean>();
  /** Controller writes awaiting an observer callback, separated from authored morphs. */
  #internalWrites = new WeakMap<Element, Map<string, ExpectedAttribute>>();
  #observing = false;
  /** Elements that left the region set, held until a pass gives back what was written on them. */
  readonly #departed = new Set<HTMLElement>();
  /** Regions whose `hidden` this controller set because their declared condition is false. */
  readonly #concealed = new WeakSet<HTMLElement>();

  /** Coalesces one target/morph/mutation batch into one full DOM reconciliation. */
  readonly #reconcile = new MorphRenderWatcher(() => this.#reconcileDom());
  readonly #listeners = new ListenerSet();
  readonly #formReset = new FormResetWatcher(
    (form) => this.#hasTriggerOwnedBy(form),
    () => this.#reconcile.schedule(),
  );
  /** Provides the last-resort focus landmark without claiming an authored tabindex. */
  readonly #rootTabindex = new TabindexLoan<HTMLElement>("-1", this.identifier);
  /** Watches retained targets and controls whose declarative or reflected state changed. */
  readonly #observer = new MutationObserver((records) => this.#onMutations(records));

  /** Evaluates only events whose source is one of this instance's live trigger targets. */
  readonly #onTriggerInput = (event: Event): void => {
    const target = event.target;
    const triggers = this.triggerTargets;
    if (target instanceof Element && triggers.some((trigger) => trigger === target)) {
      this.#commitChange(triggers);
    }
  };

  /** Reflects initial live state and opens every retained-DOM reconciliation path. */
  override connect(): void {
    this.#rootTabindex.reclaim(this.element);
    this.#lastVisible = new WeakMap();
    this.#internalWrites = new WeakMap();
    this.#settle();
    this.#reconcile.observe(this.element);
    this.#observer.observe(this.element, {
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
      childList: true,
      subtree: true,
    });
    this.#observing = true;
    this.#listeners.add(this.element, "change", this.#onTriggerInput);
    this.#listeners.add(this.element, "input", this.#onTriggerInput);
    this.#formReset.observe();
  }

  /** Releases all external resources and returns the temporary focus landmark loan. */
  override disconnect(): void {
    this.#reconcile.disconnect();
    this.#observing = false;
    this.#observer.disconnect();
    this.#listeners.dispose();
    this.#formReset.disconnect();
    this.#rootTabindex.returnAll();
  }

  /** Reconciles after a trigger target is inserted or restored. */
  triggerTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Reconciles after a trigger target is removed or replaced. */
  triggerTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Initializes a region target inserted or restored at runtime. */
  regionTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /**
   * Queues a departed region for the return of its written state and reconciles the rest.
   *
   * The return is queued rather than immediate because teardown reports every
   * region as disconnected, and a disconnected controller leaves its derived state
   * in the DOM. The pass that drains the queue skips an element that is still a
   * region, which drops what teardown queued, and keeps a departure queued before
   * a disconnect for the pass after the reconnect.
   */
  regionTargetDisconnected(region: HTMLElement): void {
    this.#departed.add(region);
    this.#reconcile.schedule();
  }

  /** Reconciles when application code or a morph changes the match policy. */
  matchValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Reconciles control ownership when hidden controls become enabled or excluded. */
  disableHiddenValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Re-evaluates every region and repairs all reflected DOM state. */
  evaluate(): void {
    this.#commitChange();
  }

  /**
   * Computes one settled plan, gives back what departed regions carry, shows
   * destinations before hiding sources, and then returns logical transitions in
   * DOM order after every region is internally coherent.
   *
   * @stimeoRenderRoot
   */
  #settle(triggers: Trigger[] = this.triggerTargets): RegionTransition[] {
    const regions = this.regionTargets;
    const plan = new Map<HTMLElement, boolean>();
    for (const region of regions) plan.set(region, this.#isVisible(region, triggers));
    for (const departed of this.#departed) {
      if (!plan.has(departed)) this.#release(departed, plan);
    }
    this.#departed.clear();

    const changed = new Set<HTMLElement>();
    const applicationOrder = [
      ...regions.filter((region) => plan.get(region) === true),
      ...regions.filter((region) => plan.get(region) === false),
    ];
    for (const region of applicationOrder) {
      const visible = plan.get(region);
      if (visible !== undefined && this.#applyRegion(region, visible, plan)) {
        changed.add(region);
      }
    }

    return regions
      .filter((region) => changed.has(region))
      .map((region) => ({ region, visible: plan.get(region) === true }));
  }

  /** Reports logical transitions caused by user input or the public action. */
  #commitChange(triggers: Trigger[] = this.triggerTargets): void {
    for (const detail of this.#settle(triggers)) {
      this.dispatch("change", { detail });
    }
  }

  /** Reports logical transitions derived from DOM, lifecycle, reset, or Value state. */
  #reconcileDom(): void {
    for (const detail of this.#settle()) {
      this.dispatch("reconcile", { detail });
    }
  }

  /** Applies one planned state while keeping event history separate from DOM repair. */
  #applyRegion(
    region: HTMLElement,
    visible: boolean,
    plan: ReadonlyMap<HTMLElement, boolean>,
  ): boolean {
    const previous = this.#lastVisible.get(region) ?? !region.hidden;
    const changed = visible !== previous;
    this.#lastVisible.set(region, visible);

    if (!visible) this.#retreatFocus(region, plan);
    this.#syncRegionState(region, visible);
    this.#syncRegionControls(region, visible);
    return changed;
  }

  /**
   * Reflects visibility idempotently, recording writes so the observer ignores its
   * own work, and notes whether the `hidden` comes from a declared condition.
   */
  #syncRegionState(region: HTMLElement, visible: boolean): void {
    if (!visible && this.#predicateFor(region) !== null) this.#concealed.add(region);
    else this.#concealed.delete(region);
    this.#writeAttribute(region, "hidden", visible ? null : "");
    this.#writeAttribute(region, "aria-hidden", visible ? null : "true");
    this.#writeAttribute(region, "data-visible", visible ? "true" : null);
  }

  /** Enables/disables descendant controls, touching only state carrying our marker. */
  #syncRegionControls(region: HTMLElement, visible: boolean): void {
    const shouldDisable = !visible && this.disableHiddenValue;
    for (const control of region.querySelectorAll<Disableable>(CONTROLS)) {
      const marked = control.hasAttribute(DISABLED_MARKER);
      if (shouldDisable) {
        if (!control.disabled) {
          this.#writeAttribute(control, "disabled", "");
          this.#writeAttribute(control, DISABLED_MARKER, "true");
        } else if (marked && control.getAttribute(DISABLED_MARKER) !== "true") {
          this.#writeAttribute(control, DISABLED_MARKER, "true");
        }
      } else if (marked) {
        this.#enable(control);
      }
    }
  }

  /** Removes a `disabled` this controller owns together with its marker. */
  #enable(control: Disableable): void {
    this.#writeAttribute(control, "disabled", null);
    this.#writeAttribute(control, DISABLED_MARKER, null);
  }

  /**
   * Gives back what this controller wrote on an element that left the region set.
   * A marked control inside a region this pass hides stays disabled for that region.
   */
  #release(element: HTMLElement, plan: ReadonlyMap<HTMLElement, boolean>): void {
    this.#lastVisible.delete(element);
    if (this.#concealed.delete(element)) this.#writeAttribute(element, "hidden", null);
    this.#writeAttribute(element, "aria-hidden", null);
    this.#writeAttribute(element, "data-visible", null);
    for (const control of element.querySelectorAll<Disableable>(CONTROLS)) {
      if (control.hasAttribute(DISABLED_MARKER) && this.#survivesPlan(control, plan)) {
        this.#enable(control);
      }
    }
  }

  /** Whether a region's declared condition holds across `triggers` per `match`. */
  #isVisible(region: HTMLElement, triggers: Trigger[]): boolean {
    const predicate = this.#predicateFor(region);
    if (predicate === null) return !region.hidden;
    return (
      triggers.length > 0 &&
      (this.matchValue === "all" ? triggers.every(predicate) : triggers.some(predicate))
    );
  }

  /** Builds the deterministic per-trigger predicate from the region's condition. */
  #predicateFor(region: HTMLElement): ((trigger: Trigger) => boolean) | null {
    if (region.hasAttribute("data-when-checked")) {
      return (trigger) => this.#isChecked(trigger);
    }
    if (region.hasAttribute("data-when-unchecked")) {
      return (trigger) => !this.#isChecked(trigger);
    }
    const wanted = region.dataset.whenValue;
    if (wanted !== undefined) {
      return (trigger) => this.#matchesValue(trigger, wanted);
    }
    return null;
  }

  #isChecked(trigger: Trigger): boolean {
    return trigger instanceof HTMLInputElement && trigger.checked;
  }

  /** A trigger has a value when a radio/checkbox is selected, or its control value matches. */
  #matchesValue(trigger: Trigger, wanted: string): boolean {
    if (
      trigger instanceof HTMLInputElement &&
      (trigger.type === "checkbox" || trigger.type === "radio")
    ) {
      return trigger.checked && trigger.value === wanted;
    }
    return trigger.value === wanted;
  }

  /** Moves focus to the first safe trigger, or to the controller landmark as a fallback. */
  #retreatFocus(region: HTMLElement, plan: ReadonlyMap<HTMLElement, boolean>): void {
    const active = document.activeElement;
    if (active && region.contains(active)) this.#moveFocus(plan);
  }

  /** Moves focus after the caller establishes that the active node is being hidden. */
  #moveFocus(plan: ReadonlyMap<HTMLElement, boolean>): void {
    const destination = this.triggerTargets.find(
      (trigger) => canTakeFocus(trigger) && this.#survivesPlan(trigger, plan),
    );
    if (destination) {
      this.#rootTabindex.returnAll();
      destination.focus();
      return;
    }

    this.#rootTabindex.lend(this.element);
    this.element.focus();
  }

  /** Whether a focus candidate or a control sits outside every region this pass will hide. */
  #survivesPlan(candidate: HTMLElement, plan: ReadonlyMap<HTMLElement, boolean>): boolean {
    return [...plan].every(([region, visible]) => visible || !region.contains(candidate));
  }

  /** Records one idempotent attribute write before MutationObserver sees it. */
  #writeAttribute(element: Element, name: string, value: ExpectedAttribute): void {
    if (element.getAttribute(name) !== value) {
      if (this.#observing) {
        let writes = this.#internalWrites.get(element);
        if (!writes) {
          writes = new Map();
          this.#internalWrites.set(element, writes);
        }
        writes.set(name, value);
      }
      if (value === null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    }
  }

  /** Separates authored records from controller writes and queues one relevant repair. */
  #onMutations(records: MutationRecord[]): void {
    const triggers = this.triggerTargets;
    const regions = this.regionTargets;
    const touchedWrites = new Map<Element, Set<string>>();
    let needsReconcile = false;

    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof Element) {
        const name = record.attributeName;
        const writes = this.#internalWrites.get(record.target);
        if (name && writes?.has(name)) {
          let names = touchedWrites.get(record.target);
          if (!names) {
            names = new Set();
            touchedWrites.set(record.target, names);
          }
          names.add(name);
          if (record.target.getAttribute(name) === writes.get(name)) continue;
        }
      }
      if (
        record.target instanceof Element &&
        this.#elementAffectsState(record.target, triggers, regions)
      ) {
        needsReconcile = true;
      }
    }

    for (const [element, names] of touchedWrites) {
      const writes = this.#internalWrites.get(element);
      for (const name of names) writes?.delete(name);
    }
    if (needsReconcile) this.#reconcile.schedule();
  }

  /** Whether an authored mutation target belongs to a trigger, region, or managed control. */
  #elementAffectsState(target: Element, triggers: Trigger[], regions: HTMLElement[]): boolean {
    return ownerIndex(triggers, target) !== -1 || ownerIndex(regions, target) !== -1;
  }

  /** Whether a form owns at least one current trigger, including `form=` associations. */
  #hasTriggerOwnedBy(form: HTMLFormElement): boolean {
    return this.triggerTargets.some((trigger) => trigger.form === form);
  }
}
