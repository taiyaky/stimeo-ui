import { Controller } from "@hotwired/stimulus";
import { setDefaultAttribute } from "../utils/default_attribute";
import { inheritsFieldsetDisabled } from "../utils/focus_candidate";
import { isInteractiveHost } from "../utils/interactive_host";

/** Attributes whose in-place changes can alter the host or its required defaults. */
const OBSERVED_ATTRIBUTES = [
  "role",
  "aria-checked",
  "tabindex",
  "type",
  "href",
  "contenteditable",
  "controls",
];

/** Ancestor attributes whose inherited state can change the supported host. */
const OBSERVED_ANCESTOR_ATTRIBUTES = ["contenteditable"];

/**
 * Headless, accessible switch (toggle) behavior.
 *
 * Markup contract (identifier: `stimeo--switch`):
 *   <button type="button" data-controller="stimeo--switch"
 *           data-action="stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
 *           role="switch" aria-checked="false">…</button>
 *
 * Implements the WAI-ARIA APG **Switch** pattern. The controller element is the
 * switch itself; its on/off state is reflected solely through `aria-checked`.
 *
 * `changed` dispatches `{ checked: boolean }`.
 *
 * @remarks
 * Behavior only — the consumer owns all styling (typically keyed off the
 * `[aria-checked="true"]` attribute). On a native `<button>` host, the browser
 * already synthesizes a click for Space/Enter, so {@link onKeydown} leaves the
 * initial key to the browser and suppresses repeated keydowns. Non-button hosts
 * such as `<div role="switch" tabindex="0">` are driven directly. Other native
 * interactive hosts stand down because their checked/navigation semantics would
 * conflict with `aria-checked` as this controller's sole source of truth.
 *
 * Behavior provided:
 * - Click (or Space/Enter) toggles `aria-checked` between `"true"` and `"false"`.
 * - A `stimeo--switch:changed` event is dispatched on every toggle so the
 *   consumer can react (its `detail.checked` carries the new boolean state).
 */
export class SwitchController extends Controller<HTMLElement> {
  static actions = ["onKeydown", "toggle"] as const;
  static events = ["changed"] as const;

  /** Defaults this instance introduced and may therefore remove safely. */
  readonly #ownedDefaults = new Set<string>();
  /** Controller writes that must not be mistaken for authored morph changes. */
  readonly #internalAttributeValues = new Map<string, string>();

  readonly #attributeObserver = new MutationObserver((records) => {
    this.#releaseAuthoredDefaults(records);
    // Stop observation while restoring defaults so the writes do not schedule a
    // second, empty callback batch. Re-observe synchronously before returning.
    this.#attributeObserver.disconnect();
    this.#reconcileDefaults();
    this.#observeAttributes();
  });

  /** Blocks disabled pointer/native-key activation before consumer click handlers. */
  readonly #onClickCapture = (event: MouseEvent): void => {
    if (!this.#isSupportedHost || !this.#isActivationDisabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /** Ensures the switch exposes a role and is keyboard-reachable. */
  override connect(): void {
    this.#reconcileDefaults();
    this.element.addEventListener("click", this.#onClickCapture, true);
    this.#observeAttributes();
  }

  /** Releases the explicit click guard and retained-element attribute observer. */
  override disconnect(): void {
    this.element.removeEventListener("click", this.#onClickCapture, true);
    this.#attributeObserver.disconnect();
    this.#internalAttributeValues.clear();
  }

  /** Toggles the checked state. Bound via `data-action` (click). */
  toggle(): void {
    if (!this.#isSupportedHost || this.#isActivationDisabled) return;
    this.#checked = !this.#checked;
  }

  /**
   * Activates the switch on Space/Enter for non-native hosts and suppresses key
   * repeat. Bound via `data-action` (keydown). A native `<button type="button">`
   * owns the initial key-to-click synthesis; repeated keydowns are canceled before
   * the browser can synthesize additional clicks.
   */
  onKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key must not ALSO toggle the switch —
    // composition depends on this yield.
    if (event.defaultPrevented) return;
    if (!this.#isSupportedHost) return;
    if (event.key !== " " && event.key !== "Enter") return;
    if (this.#isActivationDisabled) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (this.element instanceof HTMLButtonElement) {
      if (event.repeat) event.preventDefault();
      return;
    }
    event.preventDefault();
    if (event.repeat) return;
    this.toggle();
  }

  /** Re-adds only missing defaults, preserving every authored attribute value. */
  #reconcileDefaults(): void {
    if (!this.#isSupportedHost) {
      this.#removeOwnedDefaults();
      return;
    }
    this.#setOwnedDefault("role", "switch");
    this.#setOwnedDefault("aria-checked", "false");
    // Native buttons are focusable already; generic hosts need a Tab stop for
    // the keyboard action above to be reachable.
    if (!(this.element instanceof HTMLButtonElement)) {
      this.#setOwnedDefault("tabindex", "0");
    }
  }

  /** Records a newly introduced default without claiming authored markup. */
  #setOwnedDefault(name: string, value: string): void {
    if (setDefaultAttribute(this.element, name, value)) this.#ownedDefaults.add(name);
  }

  /**
   * Gives ownership back when a retained-element morph authors a value. Missing
   * owned attributes stay owned so reconciliation can restore them.
   */
  #releaseAuthoredDefaults(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.target === this.element) {
        const name = record.attributeName;
        if (name && this.#ownedDefaults.has(name)) {
          const value = this.element.getAttribute(name);
          if (value !== null && this.#internalAttributeValues.get(name) !== value) {
            this.#ownedDefaults.delete(name);
          }
        }
      }
    }
    this.#internalAttributeValues.clear();
  }

  /** Removes only defaults introduced by this instance when a host becomes invalid. */
  #removeOwnedDefaults(): void {
    for (const name of this.#ownedDefaults) this.element.removeAttribute(name);
    this.#ownedDefaults.clear();
    this.#internalAttributeValues.clear();
  }

  /** Watches retained host attributes that Turbo can morph without reconnecting. */
  #observeAttributes(): void {
    this.#attributeObserver.observe(this.element, {
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    });
    let ancestor = this.element.parentElement;
    while (ancestor) {
      this.#attributeObserver.observe(ancestor, {
        attributes: true,
        attributeFilter: OBSERVED_ANCESTOR_ATTRIBUTES,
      });
      ancestor = ancestor.parentElement;
    }
  }

  /** Whether the host has one activation model that this controller can own. */
  get #isSupportedHost(): boolean {
    if (this.element instanceof HTMLButtonElement) return this.element.type === "button";
    return !isInteractiveHost(this.element);
  }

  /** Whether ARIA or native HTML semantics make the supported switch inoperable. */
  get #isActivationDisabled(): boolean {
    let current: HTMLElement | null = this.element;
    while (current) {
      if (current.getAttribute("aria-disabled") === "true") return true;
      current = current.parentElement;
    }
    if (!(this.element instanceof HTMLButtonElement)) return false;
    return this.element.disabled || inheritsFieldsetDisabled(this.element);
  }

  /** Whether the switch is currently on. */
  get #checked(): boolean {
    return this.element.getAttribute("aria-checked") === "true";
  }

  /** Reflects the new state on `aria-checked` and notifies listeners. */
  set #checked(value: boolean) {
    const reflected = value ? "true" : "false";
    this.#internalAttributeValues.set("aria-checked", reflected);
    this.element.setAttribute("aria-checked", reflected);
    this.dispatch("changed", { detail: { checked: value } });
  }
}
