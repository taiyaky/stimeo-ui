import { Controller } from "@hotwired/stimulus";
import { validSelector } from "../utils/declared_value";
import { LivedMark } from "../utils/lived_mark";

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
 * Headless **restore reset** — Hotwire-specific, with no APG pattern. When Turbo restores a
 * page from its cache (Back and Forward, or a promoted frame navigation followed by Back),
 * it returns transient UI declared in the markup (open disclosures, typed-in values, shown
 * overlays, flash messages) to the state the page was written in, so the restored page is
 * not frozen mid-interaction. A page that stays on screen is never reset. Place one on
 * `<body>` or around the region it covers.
 *
 * Markup contract (identifier: `stimeo--reset-on-restore`):
 *   <body data-controller="stimeo--reset-on-restore">
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
 * `reset` dispatches `{}`.
 *
 * @remarks
 * Behavior only and **idempotent** — every run converges on the same initial state,
 * holding no module-scope state. The sweep removes attributes and classes, resets
 * forms, returns fields to their authored state, re-hides and removes nodes, and then
 * dispatches `stimeo--reset-on-restore:reset`.
 *
 * **Which page is a restored one.** Every connection marks the element with
 * `data-stimeo--reset-on-restore-lived`, and nothing removes the mark: Turbo copies the
 * page into its cache at different moments of a navigation, before the controller
 * disconnects or after, and the copy carries the mark either way. A new instance that
 * finds the mark is on such a copy and runs the sweep once. Server markup never carries
 * the mark, so a fresh render keeps an authored `open` or value. A reconnect of the same
 * instance — an in-page move, a `data-turbo-permanent` element carried to the next page —
 * runs nothing, and neither does `turbo:before-cache`, which Turbo also dispatches on
 * pages that stay (a promoted frame navigation, a `popstate` without Turbo state, a
 * refresh of a cached URL). A Turbo morph keeps only the attributes the server sent, so
 * the mark is written again after one. A cached page Turbo shows as a preview is a copy
 * as well and is reset, before the fresh response replaces it.
 *
 * The `reset` a restored copy runs is dispatched while that copy connects, before the
 * controllers inside it: a document or window listener hears it, an action on a
 * controller inside does not. Each Stimeo controller normalizes its own transient state
 * when it connects to a restored copy. {@link reset} is also a public action that runs
 * the sweep on the live page.
 */
export class ResetOnRestoreController extends Controller<HTMLElement> {
  static override values = {
    scope: { type: String, default: "" },
  };
  static actions = ["reset"] as const;
  static events = ["reset"] as const;

  declare scopeValue: string;

  /** The `scope` declaration after validation; empty when it cannot be parsed. */
  #scopeSelector = "";

  /** Writes the mark a restored copy carries, and tells such a copy from a fresh render. */
  readonly #lived = new LivedMark(this.identifier);

  /**
   * Validates the scope declaration once, keeping only a selector the engine can
   * read.
   *
   * A selector reads back as an ordinary string, so a malformed one survives
   * until it is handed to the DOM. Falling back to the default keeps the sweep
   * running with a visible, findable result instead of silently taking it down.
   */
  scopeValueChanged(): void {
    this.#scopeSelector = validSelector(this.element, this.scopeValue, "");
  }

  /** Marks the element, and resets a restored copy of it once. */
  override connect(): void {
    if (this.#lived.connect(this.element) === "restored") this.reset();
  }

  /** Stops following morphs; the mark stays for the copy Turbo may take after this. */
  override disconnect(): void {
    this.#lived.disconnect();
  }

  /**
   * Resets transient UI within scope to its initial state: applies the declarative
   * `data-reset-*` cleanup, then emits `reset`. Safe to call any number of times
   * (idempotent).
   */
  reset(): void {
    const root = this.#scopeRoot();

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
