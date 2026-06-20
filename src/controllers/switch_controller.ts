import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible switch (toggle) behavior.
 *
 * Markup contract (identifier: `stimeo--switch`):
 *   <button data-controller="stimeo--switch"
 *           data-action="stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
 *           role="switch" aria-checked="false">…</button>
 *
 * Implements the WAI-ARIA APG **Switch** pattern. The controller element is the
 * switch itself; its on/off state is reflected solely through `aria-checked`.
 *
 * @remarks
 * Behavior only — the consumer owns all styling (typically keyed off the
 * `[aria-checked="true"]` attribute). On a native `<button>` host, the browser
 * already synthesizes a click for Space/Enter, so {@link onKeydown} deliberately
 * does nothing there (to avoid a double toggle) and only drives non-button hosts
 * such as `<div role="switch" tabindex="0">`.
 *
 * Behavior provided:
 * - Click (or Space/Enter) toggles `aria-checked` between `"true"` and `"false"`.
 * - A `stimeo--switch:changed` event is dispatched on every toggle so the
 *   consumer can react (its `detail.checked` carries the new boolean state).
 */
export class SwitchController extends Controller<HTMLElement> {
  static actions = ["onKeydown", "toggle"] as const;
  static events = ["changed"] as const;

  /** Ensures the switch exposes a role and is keyboard-reachable. */
  override connect(): void {
    if (!this.element.hasAttribute("role")) {
      this.element.setAttribute("role", "switch");
    }
    if (!this.element.hasAttribute("aria-checked")) {
      this.element.setAttribute("aria-checked", "false");
    }
    // Native <button> hosts are focusable already; a non-button host (e.g.
    // <div role="switch">) needs an explicit tabindex to be keyboard-reachable,
    // otherwise the keyboard support below would be unreachable.
    if (!(this.element instanceof HTMLButtonElement) && !this.element.hasAttribute("tabindex")) {
      this.element.setAttribute("tabindex", "0");
    }
  }

  /** Toggles the checked state. Bound via `data-action` (click). */
  toggle(): void {
    this.#checked = !this.#checked;
  }

  /**
   * Activates the switch on Space/Enter for non-native hosts and prevents the
   * default Space scroll. Bound via `data-action` (keydown). Native `<button>`
   * hosts are skipped because the browser already turns Space/Enter into a click,
   * which would otherwise toggle the switch twice.
   */
  onKeydown(event: KeyboardEvent): void {
    if (this.element instanceof HTMLButtonElement) return;
    if (event.repeat) return;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      this.toggle();
    }
  }

  /** Whether the switch is currently on. */
  get #checked(): boolean {
    return this.element.getAttribute("aria-checked") === "true";
  }

  /** Reflects the new state on `aria-checked` and notifies listeners. */
  set #checked(value: boolean) {
    this.element.setAttribute("aria-checked", value ? "true" : "false");
    this.dispatch("changed", { detail: { checked: value } });
  }
}
