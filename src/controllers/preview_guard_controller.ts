import { Controller } from "@hotwired/stimulus";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { StylePropertyLease } from "../utils/style_property_lease";

/**
 * Headless **preview guard** (Hotwire-specific): hides or placeholders a volatile element
 * — a balance, a notification count, a live timestamp — *only while Turbo is showing a
 * preview* (`html[data-turbo-preview]`), so a stale cached snapshot does not briefly flash
 * the old value on a back/restore visit. No APG pattern; it keeps displayed information
 * accurate and hands focus back if guarding took it.
 *
 * Markup contract (identifier: `stimeo--preview-guard`):
 *   <span data-controller="stimeo--preview-guard"
 *         data-stimeo--preview-guard-placeholder-value="—">¥123,456</span>
 *
 * Watches `<html>` for the `data-turbo-preview` attribute with a `MutationObserver`.
 * While it is present the element is guarded, and `placeholder` alone decides how: empty
 * (the default) makes it `visibility: hidden` — its box is kept, so nothing shifts — and
 * any other value takes its place as the element's content. The element carries
 * `data-preview-hidden` and emits `hide`; when the preview clears it is restored and
 * `show` fires. A `placeholder` changed while guarded re-guards to match it.
 *
 * `hide` and `show` dispatch `{}`.
 *
 * @remarks
 * Behavior only — restoring the *fresh* value is the normal render's job, not this
 * controller's (it just un-hides what was there). State is derived from the DOM (no
 * module-scope state), and the guard is reversible in three ways that do not depend on
 * each other: the child nodes a placeholder displaced are held and put back intact, the
 * inline `visibility` is leased so an authored declaration — and one the consumer writes
 * while guarded — survives, and a fresh `connect()` clears a `data-preview-hidden` it
 * finds already on the element. The rewind Turbo's snapshot needs runs on
 * `turbo:before-cache` rather than `disconnect()`, so an in-page move keeps the guard
 * instead of flashing the stale value between the two lifecycle calls — and the instance
 * that comes back re-forms it rather than reading the hook as someone else's leftover.
 *
 * Focus is only ever handed back, never taken: an element that held focus when the guard
 * went up gets it back on show, and focus resting anywhere else is left alone.
 */
export class PreviewGuardController extends Controller<HTMLElement> {
  static override values = {
    placeholder: { type: String, default: "" },
  };
  static events = ["hide", "show"] as const;

  declare placeholderValue: string;

  readonly #visibility = new StylePropertyLease("visibility");
  readonly #beforeCache = new BeforeCacheReset(() => this.#restore());

  #observer: MutationObserver | null = null;
  #connected = false;
  #hidden = false;
  /** Child nodes a placeholder displaced; non-null marks that content — not visibility — was swapped. */
  #savedNodes: DocumentFragment | null = null;
  /** The descendant that held focus when the guard went up, so show can hand it back. */
  #focused: HTMLElement | null = null;

  override connect(): void {
    this.#connected = true;
    // The hook means "the connection now running has this element guarded", and which of
    // the two connects is happening is only knowable from the instance. A restored
    // snapshot brings a fresh controller to an element that still carries the hook, with
    // nothing in the DOM to say what was underneath it, so that one drops it. An in-page
    // move brings the *same* instance back still holding the guard, so that one re-forms
    // instead — against the `placeholder` as it stands now, since a morph can swap it
    // while the element is detached, where the value callback has no connection to act on.
    if (this.#hidden) this.#reguard();
    else this.element.removeAttribute("data-preview-hidden");
    this.#beforeCache.activate();
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
    this.#connected = false;
    this.#beforeCache.deactivate();
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /**
   * Re-guards to match a `placeholder` changed at runtime — the value is the content on
   * display while the guard is up, so a morph that swaps it must not leave the old one.
   */
  placeholderValueChanged(): void {
    if (!this.#connected || !this.#hidden) return;
    this.#reguard();
  }

  /**
   * Reflects the current `data-turbo-preview` state onto the element.
   *
   * @stimeoRenderRoot
   */
  #sync(): void {
    const previewing = document.documentElement.hasAttribute("data-turbo-preview");
    if (previewing && !this.#hidden) this.#hide();
    else if (!previewing && this.#hidden) this.#show();
  }

  #hide(): void {
    this.#focused = this.#focusedInside();
    this.#applyGuard();
    this.dispatch("hide", { detail: {} });
  }

  /** Puts the guard up in the form the current `placeholder` calls for. */
  #applyGuard(): void {
    this.#hidden = true;
    if (this.placeholderValue === "") {
      this.#visibility.write(this.element, "hidden");
    } else {
      this.#savedNodes = document.createDocumentFragment();
      this.#savedNodes.append(...this.element.childNodes);
      this.element.textContent = this.placeholderValue;
    }
    this.element.setAttribute("data-preview-hidden", "true");
  }

  /**
   * Re-forms a guard that is already up so it matches the current `placeholder`.
   *
   * No event: `hide` reports that the guard went up, and it has not come down. Swapping
   * one stand-in text for another writes only that text — putting the held content back
   * first would reconnect the whole subtree for an instant. Only a change of *form* —
   * to or from the empty placeholder — has to revert, and the focus the guard is holding
   * carries across it rather than being handed back and taken again.
   */
  #reguard(): void {
    if (this.#savedNodes && this.placeholderValue !== "") {
      this.element.textContent = this.placeholderValue;
      return;
    }
    const held = this.#focused;
    this.#revert();
    this.#applyGuard();
    this.#focused = held;
  }

  #show(): void {
    this.#restore();
    this.dispatch("show", { detail: {} });
  }

  /** Reverts the guard and hands focus back. Used by show and by the snapshot rewind. */
  #restore(): void {
    this.#revert();
    this.#refocus();
  }

  /**
   * Puts the element back the way the guard found it.
   *
   * Every step is a no-op on an element this controller never guarded: the lease returns
   * only declarations it recorded, and the hook is removed whether or not it is there.
   */
  #revert(): void {
    this.#hidden = false;
    if (this.#savedNodes) {
      this.element.textContent = "";
      this.element.append(this.#savedNodes);
      this.#savedNodes = null;
    } else {
      this.#visibility.return(this.element);
    }
    this.element.removeAttribute("data-preview-hidden");
  }

  /**
   * The focused element the guard is about to make unfocusable, if any.
   *
   * The element itself counts as well as its descendants: guarding takes focus either way
   * — a `visibility: hidden` subtree cannot hold it, and a placeholder displaces the nodes
   * outright — so the browser drops focus to `<body>` the moment the guard goes up.
   */
  #focusedInside(): HTMLElement | null {
    const active = document.activeElement;
    return active instanceof HTMLElement && this.element.contains(active) ? active : null;
  }

  /**
   * Hands focus back to the element the guard took it from.
   *
   * Only when that element is still in the document and focus has not moved on since —
   * anything else is the user's or another controller's, and putting it back would be
   * taking it.
   */
  #refocus(): void {
    const target = this.#focused;
    this.#focused = null;
    if (!target?.isConnected || document.activeElement !== document.body) return;
    target.focus();
  }
}
