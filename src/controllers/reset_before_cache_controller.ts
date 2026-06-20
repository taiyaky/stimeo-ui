import { Controller } from "@hotwired/stimulus";

/**
 * Headless **before-cache reset** — the most Hotwire-specific gap part (no APG
 * pattern). On `turbo:before-cache` it returns transient UI (open menus/modals,
 * typed-in values, spinning indicators) to its initial state, so a page restored by
 * the Back button is not frozen mid-interaction. Place one on `<body>`.
 *
 * Markup contract (identifier: `stimeo--reset-before-cache`):
 *   <body data-controller="stimeo--reset-before-cache">
 *     <details data-reset-attr="open">…</details>     <!-- remove these attributes -->
 *     <div data-reset-class="is-open is-loading">…</div> <!-- remove these classes -->
 *     <form data-reset-form>…</form>                   <!-- form.reset() -->
 *     <input data-reset-value>                          <!-- clear the value -->
 *     <div data-reset-hidden>transient overlay</div>    <!-- re-hide -->
 *     <div data-reset-remove>flash toast</div>          <!-- drop from the DOM -->
 *   </body>
 *
 * @remarks
 * Behavior only and **idempotent** — every run converges on the same initial state,
 * holding no module-scope state. It does the cross-cutting DOM cleanup directly
 * (attribute removal, class removal, value clearing, re-hiding, node removal) and, when
 * `dispatchReset` is on, fires `stimeo--reset-before-cache:request` so individual
 * Stimeo controllers can run their own close logic. The `turbo:before-cache`
 * listener is paired to `connect()` / `disconnect()` so it never double-registers or
 * leaks. {@link reset} is also a public action for manual triggering.
 */
export class ResetBeforeCacheController extends Controller<HTMLElement> {
  static override values = {
    scope: { type: String, default: "" },
    dispatchReset: { type: Boolean, default: true },
  };
  static actions = ["reset"] as const;
  static events = ["reset", "request"] as const;

  declare scopeValue: string;
  declare dispatchResetValue: boolean;

  /** Runs the reset just before Turbo caches the snapshot. */
  readonly #onBeforeCache = (): void => this.reset();

  override connect(): void {
    document.addEventListener("turbo:before-cache", this.#onBeforeCache);
  }

  override disconnect(): void {
    document.removeEventListener("turbo:before-cache", this.#onBeforeCache);
  }

  /**
   * Resets transient UI within scope to its initial state. Asks controllers to
   * close (via `request`) first, then applies the declarative `data-reset-*` cleanup,
   * and finally emits `reset`. Safe to call any number of times (idempotent).
   */
  reset(): void {
    const root = this.#scopeRoot();

    if (this.dispatchResetValue) this.dispatch("request");

    for (const element of root.querySelectorAll("[data-reset-attr]")) {
      for (const name of (element.getAttribute("data-reset-attr") ?? "").split(/\s+/)) {
        if (name) element.removeAttribute(name);
      }
    }
    for (const element of root.querySelectorAll("[data-reset-class]")) {
      for (const token of (element.getAttribute("data-reset-class") ?? "").split(/\s+/)) {
        if (token) element.classList.remove(token);
      }
    }
    for (const element of root.querySelectorAll("[data-reset-form]")) {
      if (element instanceof HTMLFormElement) element.reset();
    }
    for (const element of root.querySelectorAll("[data-reset-value]")) {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        element.value = "";
      }
    }
    for (const element of root.querySelectorAll<HTMLElement>("[data-reset-hidden]")) {
      element.hidden = true;
    }
    // Removal runs last so it cannot drop a node another rule still needed to visit.
    for (const element of root.querySelectorAll("[data-reset-remove]")) {
      element.remove();
    }

    this.dispatch("reset");
  }

  /** The scan root: a `scope` descendant when set, else the controller element. */
  #scopeRoot(): Element {
    if (!this.scopeValue) return this.element;
    return this.element.querySelector(this.scopeValue) ?? this.element;
  }
}
