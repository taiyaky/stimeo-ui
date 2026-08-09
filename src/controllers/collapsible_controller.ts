import { Controller } from "@hotwired/stimulus";
import { TransitionCompletion } from "../utils/transition_completion";

/**
 * Headless, accessible single-disclosure (collapsible) behavior.
 *
 * Markup contract (identifier: `stimeo--collapsible`):
 *   <div data-controller="stimeo--collapsible">
 *     <button data-stimeo--collapsible-target="trigger"
 *             data-action="stimeo--collapsible#toggle"
 *             aria-expanded="false" aria-controls="more">Show details</button>
 *     <div id="more" data-stimeo--collapsible-target="content"
 *          data-state="closed" hidden>…</div>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Disclosure** pattern for a single inline region.
 * Unlike {@link AccordionController} it manages exactly one trigger/content pair
 * with no sibling coordination, and unlike a dropdown the content expands in
 * flow and never closes on an outside click.
 *
 * @remarks
 * Behavior only — the consumer owns the height transition and all decoration.
 * The controller keeps the open lifecycle ordered so `hidden` (effectively
 * `display:none`) never blocks measurement or the transition:
 * - **Open**: drop `hidden` → measure the natural height into
 *   `--stimeo-collapsible-content-height` → set `data-state="open"`.
 * - **Close**: set `data-state="closed"` (CSS shrinks the height) → re-apply
 *   `hidden` once the transition settles. With no transition (or reduced motion,
 *   which the consumer's CSS expresses as a zero duration) it is applied
 *   immediately; an owned fallback covers missing terminal events.
 */
export class CollapsibleController extends Controller<HTMLElement> {
  static override targets = ["trigger", "content"];
  static override values = {
    open: { type: Boolean, default: false },
  };
  static actions = ["toggle"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly contentTarget: HTMLElement;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasContentTarget: boolean;

  declare openValue: boolean;

  /** Owns the cancellable close-transition wait and its bounded fallback. */
  readonly #transition = new TransitionCompletion();
  /** Distinguishes dynamic target churn from the callbacks that precede `connect()`. */
  #connected = false;

  /**
   * Establishes the initial open/closed state without waiting for a close transition.
   *
   * The DOM is the source of truth on reconnect (Turbo cache restore / morph): an
   * **explicit** state attribute — `aria-expanded="true"`/`"false"` (or, with no
   * trigger, `data-state="open"`/`"closed"`) — is honored verbatim so a region the
   * user opened *or* closed survives a back-navigation, even when the declarative
   * `open` Value disagrees. An already-open region remains open without a
   * close/reopen cycle. The Value only seeds a genuinely fresh render where no
   * state attribute is present yet; any opening animation in that case belongs to
   * the consumer's CSS. Mirrors `sidebar`'s `#restoreCollapsed`.
   */
  override connect(): void {
    this.#connected = true;
    this.#apply(this.#initialOpen(), false);
  }

  /** Resolves the connect-time state: explicit DOM state wins, else the `open` Value. */
  #initialOpen(): boolean {
    if (this.hasTriggerTarget) {
      const expanded = this.triggerTarget.getAttribute("aria-expanded");
      if (expanded === "true") return true;
      if (expanded === "false") return false;
    } else if (this.hasContentTarget) {
      const state = this.contentTarget.getAttribute("data-state");
      if (state === "open") return true;
      if (state === "closed") return false;
    }
    return this.openValue;
  }

  override disconnect(): void {
    this.#connected = false;
    this.#transition.cancel();
  }

  /** Reconciles a replacement trigger target with the content's live state. */
  triggerTargetConnected(trigger: HTMLElement): void {
    if (!this.#connected || !this.hasContentTarget) return;
    trigger.setAttribute(
      "aria-expanded",
      this.contentTarget.getAttribute("data-state") === "open" ? "true" : "false",
    );
  }

  /** Reconciles a replacement content target with the disclosure's live state. */
  contentTargetConnected(content: HTMLElement): void {
    if (!this.#connected) return;
    this.#transition.cancel();
    const open = this.hasTriggerTarget
      ? this.triggerTarget.getAttribute("aria-expanded") === "true"
      : content.getAttribute("data-state") === "open";
    this.#applyContent(content, open, false);
  }

  /** Cancels a wait tied to a content target that was removed or replaced. */
  contentTargetDisconnected(): void {
    this.#transition.cancel();
  }

  /** Toggles the region open/closed. Bound via `data-action` (click). */
  toggle(): void {
    this.#apply(!this.#isOpen, true);
  }

  /**
   * Whether the region is logically open. Read from `aria-expanded` (not the
   * content's `hidden`) so a click *during* a close transition — when `hidden`
   * is still deferred — correctly reopens instead of re-closing.
   */
  get #isOpen(): boolean {
    if (this.hasTriggerTarget) {
      return this.triggerTarget.getAttribute("aria-expanded") === "true";
    }
    return this.hasContentTarget && this.contentTarget.getAttribute("data-state") === "open";
  }

  /**
   * Drives the disclosure to `open`, syncing the trigger's `aria-expanded` and
   * the content's `hidden` / `data-state` / height variable in an order where
   * `hidden` never blocks measurement or the transition.
   *
   * @param open - Target state.
   * @param waitForCloseTransition - When `false` (initial `connect`) the close
   *   path applies `hidden` immediately. This flag does not suppress consumer CSS
   *   on the open path.
   */
  #apply(open: boolean, waitForCloseTransition: boolean): void {
    if (this.hasTriggerTarget) {
      this.triggerTarget.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (!this.hasContentTarget) return;

    const content = this.contentTarget;
    this.#transition.cancel();
    this.#applyContent(content, open, waitForCloseTransition);
  }

  /** Reflects one content target without relying on a later target lookup. */
  #applyContent(content: HTMLElement, open: boolean, waitForCloseTransition: boolean): void {
    if (open) {
      content.hidden = false;
      // Measure the natural height only once it is laid out (hidden removed) so
      // the consumer's `height` transition has a concrete target to animate to.
      content.style.setProperty("--stimeo-collapsible-content-height", `${content.scrollHeight}px`);
      content.setAttribute("data-state", "open");
      return;
    }

    content.setAttribute("data-state", "closed");
    if (waitForCloseTransition) {
      this.#applyHiddenAfterTransition(content);
    } else {
      content.hidden = true;
    }
  }

  /**
   * Re-applies `hidden` once the close transition settles. Guarded against a
   * reopen mid-transition; the shared waiter also guarantees a bounded fallback
   * when the browser emits no terminal transition event.
   */
  #applyHiddenAfterTransition(content: HTMLElement): void {
    this.#transition.wait(content, () => {
      if (content.getAttribute("data-state") === "closed") {
        content.hidden = true;
      }
    });
  }
}
