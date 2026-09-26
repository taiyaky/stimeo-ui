import { Controller } from "@hotwired/stimulus";
import { BlurDeferral } from "../utils/blur_deferral";
import { LayoutObserver } from "../utils/layout_observer";
import { stateReasonFor } from "../utils/state_reason";
import { StateRegions } from "../utils/state_regions";

/**
 * Headless "read more / truncate" behavior for visually clamped text.
 *
 * Markup contract (identifier: `stimeo--read-more`):
 *   <div data-controller="stimeo--read-more">
 *     <p id="bio" data-stimeo--read-more-target="content" data-state="collapsed">…</p>
 *     <button data-stimeo--read-more-target="trigger"
 *             data-action="click->stimeo--read-more#toggle"
 *             aria-expanded="false" aria-controls="bio" hidden>
 *       <span data-stimeo--read-more-target="collapsedLabel">Read more</span>
 *       <span data-stimeo--read-more-target="expandedLabel" hidden>Read less</span>
 *     </button>
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
 *
 * The trigger takes an optional **label pair**: where both `collapsedLabel` and
 * `expandedLabel` sit inside it, `hidden` follows the expanded state — the half that
 * belongs to the state is shown and the other hidden, over whatever visibility the
 * markup declares. A half whose counterpart is missing is left as authored, since
 * hiding it would take the trigger's only label with it. The accessible name is the
 * consumer's to write.
 *
 * Each move of the expanded state is reported: `stimeo--read-more:open` and
 * `stimeo--read-more:close` dispatch `{ reason: StateReason }`, after
 * `data-state` and `aria-expanded` are written. Both are informational, so
 * neither is cancelable. {@link toggle} is the only thing that moves the state,
 * so the baseline {@link connect} establishes, the re-evaluation that follows
 * a resize or target churn, and {@link disconnect} say nothing.
 */
export class ReadMoreController extends Controller<HTMLElement> {
  static override targets = ["content", "trigger", "expandedLabel", "collapsedLabel"];
  static override values = {
    collapsed: { type: Boolean, default: true },
  };
  static actions = ["toggle"] as const;
  static events = ["close", "open"] as const;

  declare readonly contentTarget: HTMLElement;
  declare readonly triggerTarget: HTMLElement;
  declare readonly expandedLabelTargets: HTMLElement[];
  declare readonly collapsedLabelTargets: HTMLElement[];
  declare readonly hasContentTarget: boolean;
  declare readonly hasTriggerTarget: boolean;

  declare collapsedValue: boolean;

  #connected = false;
  #collapsed = true;
  #observedContent: HTMLElement | null = null;
  #contentMutationObserver: MutationObserver | null = null;

  readonly #update = (): void => {
    if (this.#connected) this.#evaluateOverflow();
  };
  readonly #layout = new LayoutObserver(this.#update);

  /** Owns `hidden` on the trigger's two labels. */
  readonly #labels = new StateRegions({
    whenTrue: () => this.expandedLabelTargets,
    whenFalse: () => this.collapsedLabelTargets,
  });

  /** Holds the trigger's hide back while it has focus; re-evaluates on blur. */
  readonly #deferredHide = new BlurDeferral(() => {
    this.#update();
  });

  override connect(): void {
    this.#connected = true;
    // The DOM is the source of truth on reconnect (Turbo cache restore / morph): an
    // explicit `data-state="expanded"`/`"collapsed"` is honored verbatim so a block
    // the user expanded *or* collapsed survives a back-navigation, even when the
    // declarative `collapsed` Value disagrees. The Value seeds only a genuinely fresh
    // render (no `data-state` yet).
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
    this.#deferredHide.release(trigger);
    this.#syncTargets();
  }

  expandedLabelTargetConnected(): void {
    this.#syncTargets();
  }

  collapsedLabelTargetConnected(): void {
    this.#syncTargets();
  }

  /** Toggles between the collapsed (clamped) and expanded states. */
  toggle(event?: Event): void {
    if (!this.#connected) return;
    this.#collapsed = !this.#collapsed;
    this.#reflect();
    this.#evaluateOverflow();
    const detail = { reason: stateReasonFor(event) };
    if (this.#collapsed) this.dispatch("close", { detail, cancelable: false });
    else this.dispatch("open", { detail, cancelable: false });
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
      this.#labels.reflect(this.triggerTarget, !this.#collapsed);
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
    this.#layout.observeDescendantLoads(next);

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
    this.#deferredHide.releaseAll();
    if (this.#observedContent) {
      this.#layout.unobserve(this.#observedContent);
      this.#layout.unobserveDescendantLoads();
    }
    this.#observedContent = null;
    this.#contentMutationObserver?.disconnect();
    this.#contentMutationObserver = null;
    this.#layout.unobserveViewport();
  }

  #evaluateOverflow(): void {
    if (!this.hasTriggerTarget || !this.hasContentTarget) return;

    const trigger = this.triggerTarget;
    const content = this.contentTarget;
    const useful = !this.#collapsed || content.scrollHeight > content.clientHeight;
    if (useful) {
      this.#deferredHide.releaseAll();
      trigger.hidden = false;
      return;
    }

    if (document.activeElement === trigger) {
      trigger.hidden = false;
      this.#deferredHide.deferOnly(trigger);
      return;
    }

    this.#deferredHide.releaseAll();
    trigger.hidden = true;
  }
}
