import { Controller } from "@hotwired/stimulus";

/** Trigger controls whose state drives region visibility. */
type Trigger = HTMLInputElement | HTMLSelectElement;
/** Form controls inside a region that get disabled while hidden. */
type Disableable = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement;

/** Marker on inputs this controller disabled (so we never re-enable authored-disabled ones). */
const DISABLED_MARKER = "data-conditional-disabled";

/**
 * Headless dependent-fields behavior: shows/hides (and enables/disables) regions
 * based on trigger control values, keeping `hidden` / `aria-hidden` / `disabled` in
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
 * Each region declares its condition with a data attribute: `data-when-checked`,
 * `data-when-unchecked`, or `data-when-value="x"`. When the condition (combined
 * across triggers per `match`) holds the region is shown and its inputs enabled;
 * otherwise it is hidden, `aria-hidden`, and — with `disableHidden` — its inputs are
 * disabled so they drop out of the submission. Hiding a region that holds focus
 * first retreats focus to a trigger.
 *
 * @remarks
 * Behavior only. Visibility/enabled state lives entirely on the elements' `hidden` /
 * `disabled` / `aria-hidden`, re-derived from triggers on `connect()` (Morph-safe).
 * The change/input listener is removed on `disconnect()` (Turbo navigation included).
 */
export class ConditionalFieldsController extends Controller<HTMLElement> {
  static override targets = ["trigger", "region"];
  static override values = {
    disableHidden: { type: Boolean, default: true },
    match: { type: String, default: "any" },
  };
  static actions = ["evaluate"] as const;
  static events = ["change"] as const;

  declare readonly triggerTargets: Trigger[];
  declare readonly regionTargets: HTMLElement[];
  declare readonly hasTriggerTarget: boolean;

  declare disableHiddenValue: boolean;
  declare matchValue: string;

  readonly #lastVisible = new WeakMap<HTMLElement, boolean>();

  readonly #onChange = (): void => {
    this.evaluate();
  };

  override connect(): void {
    this.evaluate();
    this.element.addEventListener("change", this.#onChange);
    this.element.addEventListener("input", this.#onChange);
  }

  override disconnect(): void {
    this.element.removeEventListener("change", this.#onChange);
    this.element.removeEventListener("input", this.#onChange);
  }

  /** Re-evaluates every region against the current trigger state. */
  evaluate(): void {
    // Resolved once per pass: this runs per keystroke (input/change bubble up from
    // the whole form) and every Stimulus target access re-queries the scope.
    const triggers = this.triggerTargets;
    for (const region of this.regionTargets) {
      this.#applyRegion(region, this.#isVisible(region, triggers));
    }
  }

  /** Applies a region's visibility, syncing hidden/aria/disabled and emitting change. */
  #applyRegion(region: HTMLElement, visible: boolean): void {
    const previous = this.#lastVisible.get(region) ?? !region.hidden;
    if (visible === previous && this.#lastVisible.has(region)) return;
    this.#lastVisible.set(region, visible);

    if (visible) {
      region.hidden = false;
      region.removeAttribute("aria-hidden");
      region.setAttribute("data-visible", "true");
      this.#setRegionDisabled(region, false);
    } else {
      this.#retreatFocus(region);
      region.hidden = true;
      region.setAttribute("aria-hidden", "true");
      region.removeAttribute("data-visible");
      this.#setRegionDisabled(region, true);
    }

    if (visible !== previous) {
      this.dispatch("change", { detail: { region, visible } });
    }
  }

  /** Whether a region's declared condition holds across `triggers` per `match`. */
  #isVisible(region: HTMLElement, triggers: Trigger[]): boolean {
    const predicate = this.#predicateFor(region);
    if (predicate === null) return !region.hidden; // no condition declared → leave as-is
    if (triggers.length === 0) return false;
    return this.matchValue === "all" ? triggers.every(predicate) : triggers.some(predicate);
  }

  /** Builds the per-trigger predicate from the region's `data-when-*` attribute. */
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

  /** A trigger "has" a value: selected radio/checkbox value, or the control value. */
  #matchesValue(trigger: Trigger, wanted: string): boolean {
    if (
      trigger instanceof HTMLInputElement &&
      (trigger.type === "checkbox" || trigger.type === "radio")
    ) {
      return trigger.checked && trigger.value === wanted;
    }
    return trigger.value === wanted;
  }

  /** Enables/disables a region's inputs, tracking only the ones we disabled. */
  #setRegionDisabled(region: HTMLElement, disabled: boolean): void {
    if (!this.disableHiddenValue) return;
    const controls = region.querySelectorAll<Disableable>("input, textarea, select, button");
    for (const control of Array.from(controls)) {
      if (disabled) {
        if (!control.disabled) {
          control.disabled = true;
          control.setAttribute(DISABLED_MARKER, "true");
        }
      } else if (control.hasAttribute(DISABLED_MARKER)) {
        control.disabled = false;
        control.removeAttribute(DISABLED_MARKER);
      }
    }
  }

  /** Moves focus out of a region about to be hidden, to a trigger when possible. */
  #retreatFocus(region: HTMLElement): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !region.contains(active)) return;
    active.blur();
    if (this.hasTriggerTarget) this.triggerTargets[0]?.focus();
  }
}
