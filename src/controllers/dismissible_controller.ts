import { Controller } from "@hotwired/stimulus";

/** Elements that can hold keyboard focus, used to pick a safe focus fallback. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Headless "dismissible" behavior for banners, notices, and inline alerts.
 *
 * Markup contract (identifier: `stimeo--dismissible`):
 *   <div data-controller="stimeo--dismissible"
 *        data-stimeo--dismissible-mode-value="remove">
 *     <div data-stimeo--dismissible-target="root" role="status">
 *       <p>Saved.</p>
 *       <button type="button" aria-label="Close"
 *               data-action="stimeo--dismissible#dismiss">×</button>
 *     </div>
 *   </div>
 *
 * A general utility with no dedicated APG pattern. Its accessibility job is to
 * keep focus from being orphaned: if focus is inside the element being removed,
 * it is moved to a safe place first so the close button vanishing never strands
 * the user (WCAG 2.4.3).
 *
 * @remarks
 * Behavior only — the consumer owns any exit transition (use `hide` mode, which
 * adds `hidden`, and animate off `data-state`) and any semantics like
 * `role="alert"`. Focus retreats to, in order: the `fallback` target → the next
 * focusable element after the root → the previous one → `document.body` as a
 * last resort (weak focus; prefer providing a `fallback`).
 */
export class DismissibleController extends Controller<HTMLElement> {
  static override targets = ["root", "fallback"];
  static override values = {
    mode: { type: String, default: "remove" },
    closeOnEscape: { type: Boolean, default: false },
  };
  static actions = ["dismiss"] as const;
  static events = ["dismiss"] as const;

  declare readonly rootTarget: HTMLElement;
  declare readonly fallbackTarget: HTMLElement;
  declare readonly hasRootTarget: boolean;
  declare readonly hasFallbackTarget: boolean;

  declare modeValue: string;
  declare closeOnEscapeValue: boolean;

  override connect(): void {
    const root = this.#root;
    if (!root.hasAttribute("data-state")) {
      root.setAttribute("data-state", "open");
    }
    if (this.closeOnEscapeValue) {
      this.element.addEventListener("keydown", this.#onKeydown);
    }
  }

  override disconnect(): void {
    this.element.removeEventListener("keydown", this.#onKeydown);
  }

  /** Dismisses the element. Bound via `data-action` (click on the close button). */
  dismiss(): void {
    this.#performDismiss();
  }

  /** Dismisses on Escape when `closeOnEscape` is set and focus is inside. */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    const active = document.activeElement;
    if (!active || !this.element.contains(active)) return;
    event.preventDefault();
    this.#performDismiss();
  };

  /** The element to dismiss: the explicit `root` target, or the host element. */
  get #root(): HTMLElement {
    return this.hasRootTarget ? this.rootTarget : this.element;
  }

  #performDismiss(): void {
    const root = this.#root;
    const mode = this.modeValue === "hide" ? "hide" : "remove";

    this.#retreatFocus(root);
    root.setAttribute("data-state", "closing");
    // Dispatch before removal so a listener on the (about-to-leave) element still
    // runs; `dispatch` fires synchronously on `this.element`.
    this.dispatch("dismiss", { detail: { mode } });

    if (mode === "hide") {
      root.hidden = true;
    } else {
      root.remove();
    }
  }

  /**
   * Moves focus out of `root` *before* it is removed, but only when focus is
   * actually inside it — otherwise the user's place elsewhere is left undisturbed.
   */
  #retreatFocus(root: HTMLElement): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) return;
    this.#focusFallback(root).focus();
  }

  /** Resolves the best focus fallback per the documented precedence. */
  #focusFallback(root: HTMLElement): HTMLElement {
    if (this.hasFallbackTarget && !root.contains(this.fallbackTarget)) {
      return this.fallbackTarget;
    }

    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((element) => !root.contains(element));

    const after = candidates.find(
      (element) => root.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    if (after) return after;

    const before = candidates
      .reverse()
      .find((element) => root.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING);
    if (before) return before;

    return document.body;
  }
}
