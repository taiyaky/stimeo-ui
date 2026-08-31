import { Controller } from "@hotwired/stimulus";

/** Field types whose state is authored markup rather than something a user changed. */
const STATELESS_INPUT_TYPES = new Set(["hidden", "submit", "reset", "button", "image"]);

/**
 * Returns one field to the state its markup declared, discarding what the user
 * changed — the single-field form of a form reset.
 *
 * Assigning `""` would not do this. For a text field it throws away the authored
 * value; for a checkbox, a radio, or a hidden field the `value` IDL attribute
 * writes straight through to the content attribute, so the markup itself is
 * rewritten while the checkedness (the part the user actually moved) is left
 * alone; and for a select it can leave nothing selected at all — a state the page
 * never had.
 */
function restoreField(element: Element): void {
  if (element instanceof HTMLTextAreaElement) {
    element.value = element.defaultValue;
    return;
  }
  if (element instanceof HTMLSelectElement) {
    // An option's declared selectedness is its `selected` content attribute.
    for (const option of element.options) option.selected = option.hasAttribute("selected");
    return;
  }
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox" || element.type === "radio") {
      element.checked = element.defaultChecked;
    } else if (element.type === "file") {
      // A file field takes no value but the empty one, so assigning its default
      // back would throw on markup that declared one.
      element.value = "";
    } else if (!STATELESS_INPUT_TYPES.has(element.type)) {
      element.value = element.defaultValue;
    }
  }
}

/**
 * Headless **before-cache reset** — Hotwire-specific, with no APG pattern. On `turbo:before-cache` it returns transient UI (open menus/modals,
 * typed-in values, spinning indicators) to its initial state, so a page restored by
 * the Back button is not frozen mid-interaction. Place one on `<body>`.
 *
 * Markup contract (identifier: `stimeo--reset-before-cache`):
 *   <body data-controller="stimeo--reset-before-cache">
 *     <details data-reset-attr="open">…</details>     <!-- remove these attributes -->
 *     <div data-reset-class="is-open is-loading">…</div> <!-- remove these classes -->
 *     <form data-reset-form>…</form>                   <!-- form.reset() -->
 *     <input data-reset-value>                          <!-- back to its authored state -->
 *     <div data-reset-hidden>transient overlay</div>    <!-- re-hide -->
 *     <div data-reset-remove>flash toast</div>          <!-- drop from the DOM -->
 *   </body>
 *
 * `scope` narrows the sweep to the first descendant matching that CSS selector;
 * left empty (the default) it covers the whole element. A selector the engine
 * cannot read falls back to that default rather than taking the sweep down with
 * it, and so does one that matches nothing.
 *
 * `reset` dispatches `{}`; `request` dispatches `{}`.
 *
 * @remarks
 * Behavior only and **idempotent** — every run converges on the same initial state,
 * holding no module-scope state. It does the cross-cutting DOM cleanup directly
 * (attribute removal, class removal, restoring a field to its authored state,
 * re-hiding, node removal) and, when
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

  /** The `scope` declaration after validation; empty when it cannot be parsed. */
  #scopeSelector = "";

  /** Runs the reset just before Turbo caches the snapshot. */
  readonly #onBeforeCache = (): void => this.reset();

  /**
   * Validates the scope declaration once, keeping only a selector the engine can
   * read.
   *
   * A selector reads back as an ordinary string, so a malformed one survives
   * until it is handed to the DOM — and this part runs from a single listener
   * whose whole job is to keep a cached page from freezing. Falling back to the
   * default keeps that job running with a visible, findable result instead of
   * silently taking the sweep down.
   */
  scopeValueChanged(): void {
    const selector = this.scopeValue;
    if (selector.length > 0) {
      try {
        this.element.matches(selector);
        this.#scopeSelector = selector;
        return;
      } catch {
        // Unparsable selector: fall through to the default below.
      }
    }
    this.#scopeSelector = "";
  }

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
   *
   * `dispatchReset` decides only whether the `request` ask goes out; the cleanup
   * and the closing `reset` run either way. Both the listener and this action
   * reach the same sweep, so `reset` is emitted for a manual call too.
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
      restoreField(element);
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
    if (!this.#scopeSelector) return this.element;
    return this.element.querySelector(this.#scopeSelector) ?? this.element;
  }
}
