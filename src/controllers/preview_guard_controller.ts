import { Controller } from "@hotwired/stimulus";

/**
 * Headless **preview guard** (Hotwire-specific): hides or placeholders a volatile element
 * — a balance, a notification count, a live timestamp — *only while Turbo is showing a
 * preview* (`html[data-turbo-preview]`), so a stale cached snapshot does not briefly flash
 * the old value on a back/restore visit. No APG pattern; it keeps displayed information
 * accurate and never moves focus.
 *
 * Markup contract (identifier: `stimeo--preview-guard`):
 *   <span data-controller="stimeo--preview-guard"
 *         data-stimeo--preview-guard-mode-value="placeholder"
 *         data-stimeo--preview-guard-placeholder-value="—">¥123,456</span>
 *
 * Watches `<html>` for the `data-turbo-preview` attribute with a `MutationObserver`.
 * While it is present the element is guarded: `mode="hide"` makes it `visibility: hidden`
 * (its box is kept, so nothing shifts), `mode="placeholder"` swaps its text for
 * `placeholder`. The element carries `data-preview-hidden` and emits `hide`; when the
 * preview clears it is restored and `show` fires.
 *
 * @remarks
 * Behavior only — restoring the *fresh* value is the normal render's job, not this
 * controller's (it just un-hides what was there). State is derived from the DOM (no
 * module-scope state) and the original value is saved on hide and put back on show, so a
 * guard that connects mid-preview hides immediately and a `disconnect()` (Turbo navigation
 * included) restores the element and severs the observer. Focus is never moved.
 */
export class PreviewGuardController extends Controller<HTMLElement> {
  static override values = {
    placeholder: { type: String, default: "" },
    mode: { type: String, default: "hide" },
  };
  static events = ["hide", "show"] as const;

  declare placeholderValue: string;
  declare modeValue: string;

  #observer: MutationObserver | null = null;
  #hidden = false;
  /** Saved inline visibility (hide mode), restored on show. */
  #savedVisibility = "";
  /** Saved text (placeholder mode); non-null marks that text — not visibility — was swapped. */
  #savedText: string | null = null;

  override connect(): void {
    if (typeof MutationObserver !== "undefined") {
      this.#observer = new MutationObserver(() => this.#sync());
      this.#observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-turbo-preview"],
      });
    }
    // Sync once in case we connect while a preview is already on screen.
    this.#sync();
  }

  override disconnect(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#restore(); // never leave the element guarded after teardown
  }

  /** Reflects the current `data-turbo-preview` state onto the element. */
  #sync(): void {
    const previewing = document.documentElement.hasAttribute("data-turbo-preview");
    if (previewing && !this.#hidden) this.#hide();
    else if (!previewing && this.#hidden) this.#show();
  }

  #hide(): void {
    this.#hidden = true;
    if (this.modeValue === "placeholder") {
      this.#savedText = this.element.textContent;
      this.element.textContent = this.placeholderValue;
    } else {
      this.#savedVisibility = this.element.style.visibility;
      this.element.style.visibility = "hidden";
    }
    this.element.setAttribute("data-preview-hidden", "true");
    this.dispatch("hide", { detail: {} });
  }

  #show(): void {
    this.#restore();
    this.dispatch("show", { detail: {} });
  }

  /** Reverts the guard. Safe to call when not hidden (no-op) — used by show and teardown. */
  #restore(): void {
    if (!this.#hidden) return;
    this.#hidden = false;
    if (this.#savedText !== null) {
      this.element.textContent = this.#savedText;
      this.#savedText = null;
    } else {
      this.element.style.visibility = this.#savedVisibility;
    }
    this.element.removeAttribute("data-preview-hidden");
  }
}
