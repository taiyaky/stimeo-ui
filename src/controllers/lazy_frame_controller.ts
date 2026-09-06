import { Controller } from "@hotwired/stimulus";
import { IntersectionWatcher } from "../utils/intersection_watcher";

/**
 * Headless **lazy frame**: defers a `<turbo-frame>`'s load until it nears the viewport
 * (or focus reaches it), to keep the initial render light. Turbo's own `loading="lazy"`
 * observes with no margin, so the frame loads only once it is already in view; this
 * drives an explicit `IntersectionObserver` with a configurable `rootMargin`, plus a focus fallback so keyboard /
 * assistive-tech users trigger the load too (no APG pattern).
 *
 * Markup contract (identifier: `stimeo--lazy-frame`):
 *   <turbo-frame id="comments" data-controller="stimeo--lazy-frame"
 *     data-stimeo--lazy-frame-url-value="/posts/1/comments"
 *     data-stimeo--lazy-frame-root-margin-value="200px">Loading…</turbo-frame>
 *
 * The URL is *held* in the `url` value (not on `src`) so Turbo does not load it eagerly;
 * when the frame intersects (within `rootMargin`) or focus enters it, the controller
 * writes `url` to `src` — **writing `src` is what starts the fetch** — marks
 * `data-lazy-loaded`, and emits `load`. Focus is the fallback for the *first* load only;
 * once the frame has loaded, its listener is released and further focus moves inside the
 * frame change nothing.
 *
 * With `once` (default) the controller then stops observing. With `once` off it keeps
 * watching and re-fetches on a **re-entry** — the frame has to be seen inside the
 * observed area, leave it, and come back. Where a connection first finds the frame is the
 * baseline rather than a movement, so a focus-started load and a cache restore each begin
 * the visit wherever the frame sits — in view or out of it — and re-fetch nothing until it
 * leaves and returns. A re-entry serves the held `url`: when it still matches `src`, the
 * host's own `reload()` refetches it; when it has moved on, writing the new `url` to `src`
 * is the fetch.
 *
 * `load` dispatches `{ url }` — always the URL the fetch actually started for.
 *
 * @remarks
 * Behavior only — the load itself and the frame's content are Turbo's / the server's job,
 * and the loading UI (skeleton / `aria-busy`) belongs to `stimeo--frame-loading`. The trigger
 * is idempotent (`data-lazy-loaded` guards a double load and is the truth source on a
 * Turbo cache restore: a restored frame is observed again only while `once` is off, which
 * is the mode that asked to keep re-fetching). An empty `url` arms nothing and is never
 * written to `src`. The `IntersectionObserver` and focus listener are released once loaded
 * (when `once`) and on `disconnect()` (Turbo navigation included).
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

  /** Shared IO plumbing (support guard, active guard, teardown). */
  readonly #watcher = new IntersectionWatcher((entries) => this.#onIntersect(entries));
  #connected = false;
  #loaded = false;
  /**
   * Whether the observer last saw the frame inside the observed area — `null`
   * until it has reported. A re-entry needs a frame that was seen inside and
   * then left, so an unknown position is never a departure.
   */
  #inside: boolean | null = null;

  /**
   * Focus reaching the frame starts the FIRST load before it intersects (keyboard / AT).
   * `#load` releases this listener, so focus never reaches an already-loaded frame.
   */
  readonly #onFocus = (): void => this.#load();

  /**
   * Follows the held URL at runtime: one that arrives arms the frame, one that is
   * taken away disarms it, so an empty `url` holds no triggers either way.
   *
   * Stimulus runs value callbacks before `connect()`, so the connected guard keeps
   * arming in one place. A frame that already loaded keeps its held URL for the next
   * re-entry instead of fetching on the spot.
   */
  urlValueChanged(): void {
    if (!this.#connected || this.#loaded) return;
    if (this.urlValue) this.#arm();
    else this.#stopObserving();
  }

  /** Rebuilds the observer when the early-load margin changes at runtime. */
  rootMarginValueChanged(): void {
    if (this.#connected && this.#watcher.active) this.#observe();
  }

  override connect(): void {
    // `data-lazy-loaded` is the truth source across a cache restore, and `once`
    // decides whether a restored frame still has anything to watch for.
    this.#loaded = this.element.hasAttribute("data-lazy-loaded");
    this.#inside = null;
    this.#connected = true;
    if (this.#loaded && this.onceValue) return;
    this.#arm();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#stopObserving();
  }

  /** Attaches the triggers that still have a job to do. */
  #arm(): void {
    if (!this.urlValue) return;
    if (!this.#loaded) this.element.addEventListener("focusin", this.#onFocus);
    this.#observe();
  }

  #observe(): void {
    this.#watcher.start(this.element, { rootMargin: this.rootMarginValue });
  }

  #onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const returning = this.#inside === false;
        this.#inside = true;
        this.#enter(returning);
      } else if (this.#inside) {
        // An observer reports where the frame is before it reports any movement,
        // so only a frame already seen inside can be leaving.
        this.#inside = false;
      }
    }
  }

  /** Applies an intersecting entry: the first one loads, a return re-fetches. */
  #enter(returning: boolean): void {
    if (!this.#loaded) {
      this.#load();
      return;
    }
    if (this.onceValue || !returning) return;
    this.#reload();
  }

  /** Starts the load by writing the held URL to `src`. */
  #load(): void {
    if (!this.urlValue) return;
    this.#loaded = true;
    this.element.setAttribute("src", this.urlValue);
    this.element.setAttribute("data-lazy-loaded", "true");
    this.dispatch("load", { detail: { url: this.urlValue } });
    // The focus fallback exists to start the first load; it has nothing left to do.
    this.element.removeEventListener("focusin", this.#onFocus);
    if (this.onceValue) this.#watcher.stop();
  }

  /** Re-entry while `once` is off: fetch the held URL again. */
  #reload(): void {
    const src = this.element.getAttribute("src");
    if (this.urlValue && this.urlValue !== src) {
      // The held URL moved on. Writing it to `src` is the fetch, the same start
      // the first load uses, so it works on any host.
      this.element.setAttribute("src", this.urlValue);
      this.dispatch("load", { detail: { url: this.urlValue } });
      return;
    }
    const frame = this.element as HTMLElement & { reload?: () => void };
    // Refetching the URL already on `src` needs the host's own `reload()`. On a
    // non-`<turbo-frame>` host there is none, and firing `load` would announce a
    // fetch that never started.
    if (typeof frame.reload !== "function") return;
    frame.reload();
    this.dispatch("load", { detail: { url: src ?? "" } });
  }

  #stopObserving(): void {
    this.#watcher.stop();
    this.element.removeEventListener("focusin", this.#onFocus);
  }
}
