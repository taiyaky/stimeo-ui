import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

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
 * event is emitted. The self hook is added on `connect()` and removed before its
 * `duration` elapses, so it does not linger into a `turbo:before-cache` snapshot; the
 * observer and pending timers are torn down on `disconnect()` (Turbo navigation
 * included).
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
  #observer: MutationObserver | null = null;

  override connect(): void {
    if (this.observeValue) {
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
    if (this.#prefersReducedMotion()) return;

    el.setAttribute("data-highlight", "true");
    this.dispatch("start", { target: el, detail: { element: el } });
    this.#timeouts.set(() => {
      el.removeAttribute("data-highlight");
      this.dispatch("end", { target: el, detail: { element: el } });
    }, this.durationValue);
  }

  #prefersReducedMotion(): boolean {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }
}
