import { Controller } from "@hotwired/stimulus";
import { prefersReducedMotion } from "../utils/reduced_motion";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * The connection whose removal timer currently owns an element's `data-highlight`
 * hook. Shared by every instance, so a row moved from one watched container into
 * another still has exactly one timer deciding when its emphasis ends.
 *
 * Only the keys are weak: an entry keeps its controller — and through it that
 * controller's element — reachable for as long as the row is in the DOM. So an entry
 * is dropped as soon as the timer that owns it is released or fires, and `connect()`
 * drops the claims the connection before it left behind.
 */
const hookOwners = new WeakMap<Element, HighlightController>();

/**
 * Headless "highlight on insert" behavior: briefly flags a freshly inserted element
 * with `data-highlight` so CSS can flash / fade it in, then removes the flag after
 * `duration` ms (no dedicated APG pattern; a purely visual emphasis that honors the
 * WCAG "animation from interactions" practice via `prefers-reduced-motion`).
 *
 * Markup contract (identifier: `stimeo--highlight`):
 *   <!-- self-highlight: put it on the inserted row itself -->
 *   <li data-controller="stimeo--highlight">New item</li>
 *
 *   <!-- container mode: watch for added children and highlight each -->
 *   <ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"></ul>
 *
 * In the default (self) mode the controller element is highlighted once on
 * `connect()`. With `observe`, a `MutationObserver` instead highlights every element
 * child added to the container (e.g. Turbo Stream appends). Each highlight sets
 * `data-highlight="true"`, dispatches `start`, and after `duration` removes it and
 * dispatches `end` — both carry `detail.element`.
 *
 * @remarks
 * Behavior only — it ships no color or animation, just the hook (pair with CSS, and
 * with Announcer / Flash for non-visual notice). Under `prefers-reduced-motion: reduce`
 * the emphasis is suppressed entirely (the element simply appears), so no hook or
 * event is emitted. A hook never outlives the connection that set it: the observer and
 * pending timers are torn down on `disconnect()` (Turbo navigation included), and
 * `connect()` clears any hook that arrived with the DOM — a restored `turbo:before-cache`
 * snapshot, an in-page move — because the timer that would have removed it is gone.
 * An element carries at most one emphasis at a time: highlighting it again — a reorder
 * inside one container, or a move into another watched one — takes the hook over and
 * releases the timer that held it, so `duration` is measured from the latest highlight
 * and `end` fires once per emphasis.
 */
export class HighlightController extends Controller<HTMLElement> {
  static override values = {
    duration: { type: Number, default: 1500 },
    observe: { type: Boolean, default: false },
  };
  static events = ["start", "end"] as const;

  declare durationValue: number;
  declare observeValue: boolean;

  readonly #timeouts = new SafeTimeout();
  /**
   * The removal timer this connection has outstanding for an element. Held weakly so
   * a row that leaves the DOM is not retained, and dropped wholesale on `disconnect()`
   * so a cleared id can never be matched against a recycled one. Which connection owns
   * an element's hook is answered by the shared owner registry above.
   */
  #pending = new WeakMap<HTMLElement, number>();
  #observer: MutationObserver | null = null;

  override connect(): void {
    // A hook that arrived with the DOM was written by an earlier connection, whose
    // removal timer is gone; this connection owns no timer for it either, so nothing
    // would ever take it off. Drop it before anything else — in self mode
    // `#highlight()` re-adds it with a fresh timer below, except under reduced
    // motion, where the element must carry no hook at all.
    this.#clearArrivedHook(this.element);
    if (this.observeValue) {
      // A container highlights its children, never itself, so the same reasoning
      // applies to every child present before the observer starts watching.
      for (const child of this.element.children) this.#clearArrivedHook(child);
      if (typeof MutationObserver !== "undefined") {
        this.#observer = new MutationObserver((mutations) => this.#onMutations(mutations));
        this.#observer.observe(this.element, { childList: true });
      }
      return;
    }
    this.#highlight(this.element);
  }

  override disconnect(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#timeouts.clearAll();
    this.#pending = new WeakMap();
  }

  /** Drops a hook that arrived with the DOM, along with this connection's claim on it. */
  #clearArrivedHook(el: Element): void {
    // Another connection may still hold a live timer for this element, and that timer
    // has to stay reachable so the next highlight can release it. Only our own claim,
    // whose timer went down with the previous disconnect, is dropped here.
    if (hookOwners.get(el) === this) hookOwners.delete(el);
    el.removeAttribute("data-highlight");
  }

  /** Highlights every element child added by a childList mutation. */
  #onMutations(mutations: MutationRecord[]): void {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) this.#highlight(node);
      }
    }
  }

  /** Flags `el` with `data-highlight` and schedules its removal (unless reduced-motion). */
  #highlight(el: HTMLElement): void {
    // Reduced motion: suppress the emphasis so the element just appears — no hook,
    // no timer, no events, nothing to transition.
    if (prefersReducedMotion()) return;

    // A second highlight of the same element — a re-insert, which is the shape a
    // reorder takes — owns the hook from here on. Release the first timer, or it
    // ends the new emphasis early and then reports an `end` for a hook already gone.
    this.#releasePending(el);
    el.setAttribute("data-highlight", "true");
    this.dispatch("start", { target: el, detail: { element: el } });
    const id = this.#timeouts.set(() => {
      this.#pending.delete(el);
      hookOwners.delete(el);
      el.removeAttribute("data-highlight");
      this.dispatch("end", { target: el, detail: { element: el } });
    }, this.durationValue);
    this.#pending.set(el, id);
    hookOwners.set(el, this);
  }

  /**
   * Releases whichever removal timer holds `el`'s hook. The row may have been
   * highlighted inside a different watched container before it moved here, and that
   * container's timer is reachable only through the shared owner registry.
   */
  #releasePending(el: HTMLElement): void {
    const owner = hookOwners.get(el);
    if (owner !== undefined && owner !== this) owner.#cancelPending(el);
    this.#cancelPending(el);
  }

  /** Releases `el`'s pending removal timer, if it has one. */
  #cancelPending(el: HTMLElement): void {
    // `SafeTimeout.clear` ignores an id it does not own, so the "no pending timer"
    // case needs no branch of its own.
    this.#timeouts.clear(this.#pending.get(el) ?? -1);
    this.#pending.delete(el);
    hookOwners.delete(el);
  }
}
