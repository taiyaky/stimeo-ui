import { Controller } from "@hotwired/stimulus";

/**
 * Headless **lazy frame**: defers a `<turbo-frame>`'s load until it nears the viewport
 * (or focus reaches it), to keep the initial render light. Turbo's own `loading="lazy"`
 * fires on *render*, not on viewport entry, so this drives an explicit `IntersectionObserver`
 * with a configurable `rootMargin` for early loading, plus a focus fallback so keyboard /
 * assistive-tech users trigger the load too (no APG pattern).
 *
 * Markup contract (identifier: `stimeo--lazy-frame`):
 *   <turbo-frame id="comments" data-controller="stimeo--lazy-frame"
 *     data-stimeo--lazy-frame-url-value="/posts/1/comments"
 *     data-stimeo--lazy-frame-root-margin-value="200px">Loading…</turbo-frame>
 *
 * The URL is *held* in the `url` value (not on `src`) so Turbo does not load it eagerly;
 * when the frame intersects (within `rootMargin`) or focus enters it, the controller
 * writes `url` to `src` — which starts the Turbo load — marks `data-lazy-loaded`, and
 * emits `load`. With `once` (default) it then stops observing; otherwise re-entry asks
 * Turbo to `reload()` the frame.
 *
 * @remarks
 * Behavior only — the load itself and the frame's content are Turbo's / the server's job,
 * and the loading UI (skeleton / `aria-busy`) belongs to Frame Loading State. The trigger
 * is idempotent (`data-lazy-loaded` guards a double load and is honored on a Turbo cache
 * restore — a frame that already loaded is not observed again). The `IntersectionObserver`
 * and focus listener are released once loaded (when `once`) and on `disconnect()` (Turbo
 * navigation included).
 */
export class LazyFrameController extends Controller<HTMLElement> {
  static override values = {
    url: { type: String, default: "" },
    rootMargin: { type: String, default: "0px" },
    once: { type: Boolean, default: true },
  };
  static events = ["load"] as const;

  declare urlValue: string;
  declare rootMarginValue: string;
  declare onceValue: boolean;

  #observer: IntersectionObserver | null = null;
  #loaded = false;

  /** Focus reaching the frame triggers the load before it intersects (keyboard / AT). */
  readonly #onFocus = (): void => this.#trigger();

  override connect(): void {
    // A cache restore may bring back an already-loaded frame; respect it, do not reload.
    if (this.element.hasAttribute("data-lazy-loaded")) {
      this.#loaded = true;
      return;
    }
    if (!this.urlValue) return;

    this.element.addEventListener("focusin", this.#onFocus);
    if (typeof IntersectionObserver !== "undefined") {
      this.#observer = new IntersectionObserver((entries) => this.#onIntersect(entries), {
        rootMargin: this.rootMarginValue,
      });
      this.#observer.observe(this.element);
    }
  }

  override disconnect(): void {
    this.#stopObserving();
  }

  #onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        this.#trigger();
        return;
      }
    }
  }

  #trigger(): void {
    if (!this.#loaded) this.#load();
    else if (!this.onceValue) this.#reload();
  }

  /** Starts the load by writing the held URL to `src`. */
  #load(): void {
    this.#loaded = true;
    this.element.setAttribute("src", this.urlValue);
    this.element.setAttribute("data-lazy-loaded", "true");
    this.dispatch("load", { detail: { url: this.urlValue } });
    if (this.onceValue) this.#stopObserving();
  }

  /** Re-entry while `once` is off: ask Turbo to reload the frame's current `src`. */
  #reload(): void {
    const frame = this.element as HTMLElement & { reload?: () => void };
    // Only signal `load` when a reload actually happens. On a non-`<turbo-frame>`
    // host (no `reload()`), firing it would announce a load that never occurred.
    if (typeof frame.reload !== "function") return;
    frame.reload();
    this.dispatch("load", { detail: { url: this.urlValue } });
  }

  #stopObserving(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    this.element.removeEventListener("focusin", this.#onFocus);
  }
}
