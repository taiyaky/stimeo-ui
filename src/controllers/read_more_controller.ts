import { Controller } from "@hotwired/stimulus";
import { LayoutObserver } from "../utils/layout_observer";

/**
 * Headless "read more / truncate" behavior for visually clamped text.
 *
 * Markup contract (identifier: `stimeo--read-more`):
 *   <div data-controller="stimeo--read-more">
 *     <p id="bio" data-stimeo--read-more-target="content" data-state="collapsed">…</p>
 *     <button data-stimeo--read-more-target="trigger"
 *             data-action="stimeo--read-more#toggle"
 *             aria-expanded="false" aria-controls="bio" hidden>Read more</button>
 *   </div>
 *
 * There is no dedicated APG widget; the toggle borrows the **Disclosure**
 * convention (`aria-expanded`). The visual clamp itself (`-webkit-line-clamp`
 * etc.) is the consumer's CSS, keyed off `data-state`.
 *
 * @remarks
 * Behavior only. The full text always stays in the DOM — the clamp is purely
 * visual, so assistive technology reads everything regardless of state; here
 * `aria-expanded` therefore signals the *visual* expansion, not content hidden
 * from AT. The controller's extra job is **overflow detection**: when the
 * content is not actually clamped (it fits), the toggle is `hidden` so no
 * pointless "read more" is offered. Resizes, content changes, and target
 * replacement re-evaluate it; hiding a focused toggle waits until blur.
 */
export class ReadMoreController extends Controller<HTMLElement> {
  static override targets = ["content", "trigger"];
  static override values = {
    collapsed: { type: Boolean, default: true },
  };
  static actions = ["toggle"] as const;

  declare readonly contentTarget: HTMLElement;
  declare readonly triggerTarget: HTMLElement;
  declare readonly hasContentTarget: boolean;
  declare readonly hasTriggerTarget: boolean;

  declare collapsedValue: boolean;

  #connected = false;
  #collapsed = true;
  #observedContent: HTMLElement | null = null;
  #contentMutationObserver: MutationObserver | null = null;
  #deferredHideTrigger: HTMLElement | null = null;

  readonly #update = (): void => {
    if (this.#connected) this.#evaluateOverflow();
  };
  readonly #layout = new LayoutObserver(this.#update);

  readonly #onDeferredHideBlur = (): void => {
    this.#clearDeferredHide();
    this.#update();
  };

  override connect(): void {
    this.#connected = true;
    // The DOM is the source of truth on reconnect (Turbo cache restore / morph): an
    // explicit `data-state="expanded"`/`"collapsed"` is honored verbatim so a block
    // the user expanded *or* collapsed survives a back-navigation, even when the
    // declarative `collapsed` Value disagrees. The Value seeds only a genuinely fresh
    // render (no `data-state` yet). Mirrors `sidebar`'s `#restoreCollapsed`.
    this.#collapsed = this.#initialCollapsed();
    this.#syncTargets();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#stopObservingContent();
    this.#layout.disconnect();
  }

  contentTargetConnected(): void {
    this.#syncTargets();
  }

  contentTargetDisconnected(): void {
    this.#syncTargets();
  }

  triggerTargetConnected(): void {
    this.#syncTargets();
  }

  triggerTargetDisconnected(trigger: HTMLElement): void {
    if (this.#deferredHideTrigger === trigger) this.#clearDeferredHide();
    this.#syncTargets();
  }

  /** Toggles between the collapsed (clamped) and expanded states. */
  toggle(): void {
    if (!this.#connected) return;
    this.#collapsed = !this.#collapsed;
    this.#reflect();
    this.#evaluateOverflow();
  }

  #initialCollapsed(): boolean {
    if (this.hasContentTarget) {
      const state = this.contentTarget.getAttribute("data-state");
      if (state === "expanded") return false;
      if (state === "collapsed") return true;
    }
    return this.collapsedValue;
  }

  #reflect(): void {
    if (this.hasContentTarget) {
      this.contentTarget.setAttribute("data-state", this.#collapsed ? "collapsed" : "expanded");
    }
    if (this.hasTriggerTarget) {
      this.triggerTarget.setAttribute("aria-expanded", this.#collapsed ? "false" : "true");
    }
  }

  #syncTargets(): void {
    if (!this.#connected) return;
    this.#syncContentObservation();
    this.#reflect();
    this.#evaluateOverflow();
  }

  #syncContentObservation(): void {
    const next = this.hasContentTarget ? this.contentTarget : null;
    if (next === this.#observedContent) return;

    this.#stopObservingContent();
    if (!next) return;

    this.#observedContent = next;
    this.#layout.observe(next);
    this.#layout.observeViewport();
    next.addEventListener("load", this.#update, true);

    if (typeof MutationObserver !== "undefined") {
      this.#contentMutationObserver = new MutationObserver(this.#update);
      this.#contentMutationObserver.observe(next, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  }

  #stopObservingContent(): void {
    this.#clearDeferredHide();
    if (this.#observedContent) {
      this.#layout.unobserve(this.#observedContent);
      this.#observedContent.removeEventListener("load", this.#update, true);
    }
    this.#observedContent = null;
    this.#contentMutationObserver?.disconnect();
    this.#contentMutationObserver = null;
    this.#layout.unobserveViewport();
  }

  #deferHide(trigger: HTMLElement): void {
    if (this.#deferredHideTrigger === trigger) return;
    this.#clearDeferredHide();
    this.#deferredHideTrigger = trigger;
    trigger.addEventListener("blur", this.#onDeferredHideBlur);
  }

  #clearDeferredHide(): void {
    this.#deferredHideTrigger?.removeEventListener("blur", this.#onDeferredHideBlur);
    this.#deferredHideTrigger = null;
  }

  #evaluateOverflow(): void {
    if (!this.hasTriggerTarget || !this.hasContentTarget) return;

    const trigger = this.triggerTarget;
    const content = this.contentTarget;
    const useful = !this.#collapsed || content.scrollHeight > content.clientHeight;
    if (useful) {
      this.#clearDeferredHide();
      trigger.hidden = false;
      return;
    }

    if (document.activeElement === trigger) {
      trigger.hidden = false;
      this.#deferHide(trigger);
      return;
    }

    this.#clearDeferredHide();
    trigger.hidden = true;
  }
}
