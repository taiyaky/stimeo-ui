import { Controller } from "@hotwired/stimulus";
import { setAttributeIfChanged } from "../utils/attribute_write";
import { AuthoredMutationWatcher } from "../utils/authored_mutation_watcher";
import { setDefaultAttribute } from "../utils/default_attribute";
import { commitField, writeField } from "../utils/field_mirror";
import { inheritsFieldsetDisabled } from "../utils/focus_candidate";
import { isInteractiveHost } from "../utils/interactive_host";
import { ListenerSet } from "../utils/listener_set";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { MoveCounter } from "../utils/move_counter";

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
 *           data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
 *           role="switch" aria-checked="false">
 *     <input type="hidden" name="notify" data-stimeo--switch-target="field" />
 *   </button>
 *
 * Implements the WAI-ARIA APG **Switch** pattern. The controller element is the
 * switch itself; its on/off state is reflected solely through `aria-checked`.
 *
 * `change` and `reconcile` dispatch `{ checked: boolean }`.
 *
 * User `change` reports compare the resulting state with the last published
 * state. A pending page write handled in the same script joins that confirmation;
 * a browser-delivered listener may settle it first as `reconcile`. Confirming
 * the last published state reports nothing.
 *
 * A synchronous subscriber that confirms another state replaces reports still
 * pending for the outer confirmation. Reading state or confirming it unchanged
 * does not replace them. A listener that disconnects the controller ends the
 * reports still pending. An event already being dispatched cannot be recalled.
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
 * - `stimeo--switch:change` reports a toggle that moves the published state; its
 *   `detail.checked` carries the new boolean state.
 * - `stimeo--switch:reconcile` reports a checked state the page moved instead —
 *   a retained-element morph that writes `aria-checked` or strips it (the state
 *   then falls back to the `"false"` default), or a host that stops supporting
 *   the switch and takes back the `aria-checked` this controller supplied. It
 *   carries the same detail, once per batch of changes, and never on connect.
 * - The optional `field` target mirrors the state as `"true"` / `"false"` so the
 *   switch can be submitted and read server-side. A toggle the user made emits
 *   a native bubbling `change` from that field, the way a form control does, so
 *   `stimeo--auto-submit` and form-level validation hear it. The mirror is
 *   refreshed silently on connect, on a replacement field, whenever the
 *   defaults are re-derived after an attribute change, and after a Turbo morph
 *   of the switch or its subtree, which can empty a retained field whose new
 *   markup carries no value while `aria-checked` stays. A hidden input is not
 *   interactive content, so it is valid inside the `<button>` host.
 */
export class SwitchController extends Controller<HTMLElement> {
  readonly #moves = new MoveCounter();
  #connectionGeneration = 0;
  static override targets = ["field"];
  static actions = ["onKeydown", "toggle"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly fieldTarget: HTMLInputElement;
  declare readonly hasFieldTarget: boolean;

  /** Defaults this instance introduced, with the value it last wrote, so it may remove them. */
  readonly #ownedDefaults = new Map<string, string>();
  /** One pass per batch of retained-element changes, field arrivals and Turbo morphs. */
  readonly #pass = new MorphRenderWatcher(() => this.#reconcile());
  /** The checked state last published: read on connect, then committed or reported. */
  #committedChecked = false;

  readonly #attributeObserver = new AuthoredMutationWatcher((records) => {
    this.#releaseAuthoredDefaults(records);
    this.#pass.schedule();
  });

  /** Blocks disabled pointer/native-key activation before consumer click handlers. */
  readonly #onClickCapture = (event: MouseEvent): void => {
    if (!this.#isSupportedHost || !this.#isActivationDisabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /** The listeners of one connection, released together on `disconnect()`. */
  readonly #listeners = new ListenerSet();

  /**
   * Ensures the switch exposes a role and is keyboard-reachable, and takes the
   * state it finds as the one a later move is measured from, reporting nothing.
   */
  override connect(): void {
    this.#releaseDefaultsRewrittenWhileAway();
    this.#reconcileDefaults();
    this.#mirrorField(false);
    this.#committedChecked = this.#checked;
    this.#listeners.add(this.element, "click", this.#onClickCapture, { capture: true });
    this.#pass.observe(this.element);
    this.#observeAttributes();
  }

  /** Fills a form field inserted or replaced at runtime with the current state. */
  fieldTargetConnected(): void {
    this.#pass.schedule();
  }

  /** Brings the field that stays to the current state when an earlier one leaves. */
  fieldTargetDisconnected(): void {
    this.#pass.schedule();
  }

  /** Releases the click guard, the attribute observer, the morph listener and a queued pass. */
  override disconnect(): void {
    this.#connectionGeneration += 1;
    this.#pass.disconnect();
    this.#listeners.dispose();
    this.#attributeObserver.disconnect();
  }

  /** Toggles the checked state. Bound via `data-action` (click). */
  toggle(): void {
    if (!this.#isSupportedHost || this.#isActivationDisabled) return;
    this.#commit(!this.#checked);
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

  /** Repairs defaults from authored records while keeping subscriber changes observable. */
  #reconcile(): void {
    this.#releaseAuthoredDefaults(this.#attributeObserver.take());
    this.#reconcileDefaults();
    this.#mirrorField(false);
    const authored = this.#attributeObserver.take();
    this.#releaseAuthoredDefaults(authored);
    if (authored.length > 0) this.#pass.schedule();
    this.#reportMove();
  }

  /** Reports a checked state that moved since the one this switch last published. */
  #reportMove(): void {
    const checked = this.#checked;
    if (checked === this.#committedChecked) return;
    this.#committedChecked = checked;
    this.dispatch("reconcile", { detail: { checked } });
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

  /** Mirrors the checked state into the optional form field. */
  #mirrorField(notify: boolean): void {
    if (!this.hasFieldTarget) return;
    const moved = writeField(this.fieldTarget, this.#checked ? "true" : "false");
    if (moved && notify) commitField(this.fieldTarget);
  }

  /** Records a newly introduced default without claiming authored markup. */
  #setOwnedDefault(name: string, value: string): void {
    if (setDefaultAttribute(this.element, name, value)) {
      this.#ownedDefaults.set(name, value);
      this.#attributeObserver.claimCurrent(this.element, name);
    }
  }

  /**
   * Gives ownership back for a default the page rewrote while no observer was
   * watching. A value that still reads as the one this instance wrote stays owned,
   * and a missing one stays owned so reconciliation can restore it.
   */
  #releaseDefaultsRewrittenWhileAway(): void {
    for (const [name, written] of this.#ownedDefaults) {
      const value = this.element.getAttribute(name);
      if (value !== null && value !== written) this.#ownedDefaults.delete(name);
    }
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
          if (value !== null) {
            this.#ownedDefaults.delete(name);
          }
        }
      }
    }
  }

  /** Removes only defaults introduced by this instance when a host becomes invalid. */
  #removeOwnedDefaults(): void {
    for (const name of this.#ownedDefaults.keys()) this.#writeAttribute(name, null);
    this.#ownedDefaults.clear();
  }

  /** Watches retained host attributes that Turbo can morph without reconnecting. */
  #observeAttributes(): void {
    this.#attributeObserver.observe(this.element, {
      attributes: OBSERVED_ATTRIBUTES,
      ancestorAttributes: OBSERVED_ANCESTOR_ATTRIBUTES,
    });
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

  /**
   * Applies one toggle the user made. The state is taken as published before
   * either report goes out, so a listener that toggles again or writes the
   * attribute is measured from it.
   */
  #commit(value: boolean): void {
    const generation = this.#connectionGeneration;
    const reflected = value ? "true" : "false";
    const authored = this.#attributeObserver.take();
    this.#releaseAuthoredDefaults(authored);
    if (authored.length > 0) this.#pass.schedule();
    if (this.#ownedDefaults.has("aria-checked")) this.#ownedDefaults.set("aria-checked", reflected);
    this.#writeAttribute("aria-checked", reflected);
    const changed = value !== this.#committedChecked;
    this.#committedChecked = value;
    if (!changed) {
      this.#mirrorField(false);
      return;
    }
    const token = this.#moves.record();
    this.#mirrorField(true);
    if (generation !== this.#connectionGeneration || !this.#moves.isLatest(token)) return;
    this.dispatch("change", { detail: { checked: value } });
  }
  /** Claims only actual writes to the host's observed defaults. */
  #writeAttribute(name: string, value: string | null): void {
    setAttributeIfChanged(this.element, name, value, () => {
      this.#attributeObserver.claim(this.element, name, value);
    });
  }
}
