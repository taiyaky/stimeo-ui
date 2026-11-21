import { Controller } from "@hotwired/stimulus";
import { IntersectionWatcher } from "../utils/intersection_watcher";
import { ListenerSet } from "../utils/listener_set";

/**
 * Headless **lazy frame**: defers a `<turbo-frame>`'s load until it nears the viewport
 * (or focus reaches it), to keep the initial render light. Turbo's own `loading="lazy"`
 * observes with no margin, so the frame loads only once it is already in view; this
 * drives an explicit `IntersectionObserver` with a configurable `rootMargin`, plus a
 * focus fallback so keyboard / assistive-tech users trigger the load too (no APG
 * pattern).
 *
 * Markup contract (identifier: `stimeo--lazy-frame`):
 *   <turbo-frame id="comments" data-controller="stimeo--lazy-frame"
 *     data-stimeo--lazy-frame-url-value="/posts/1/comments"
 *     data-stimeo--lazy-frame-root-margin-value="200px">Loading…</turbo-frame>
 *
 * The URL is *held* in the `url` value (not on `src`) so Turbo does not load it eagerly;
 * when the frame intersects (within `rootMargin`) or focus enters it, the controller
 * writes `url` to `src`, sets `data-lazy-loaded`, and emits `load`. Focus is a
 * fallback until that first assignment, when the controller releases its listener.
 *
 * With `once` (default) the controller then stops observing. With `once` off it keeps
 * watching for a **re-entry**. The first observation establishes where the
 * frame sits, including after a focus-triggered load or cache restore. Once the
 * observer has seen the frame inside, then outside, a return assigns a non-empty
 * `url` if it differs from `src`. Otherwise it calls the frame's `reload()` when
 * available.
 *
 * `load` dispatches `{ url }` after assigning `src` or calling `reload()`. It
 * reports the assigned URL or the frame's current `src` for a reload. Turbo
 * controls the request.
 *
 * `once` follows a runtime change for a frame that has loaded: turned off, the frame is
 * observed again and the visit begins wherever the observer first finds it, exactly as on a
 * reconnect; turned on, observing stops. Before the first load it has nothing to change,
 * because it only decides what that load leaves behind.
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
   * `#load` releases this listener, so focus on an already-loaded frame starts nothing.
   */
  readonly #onFocus = (): void => this.#load();
  /** The focus fallback, held from arming until the first load or the watch stops. */
  readonly #focusListeners = new ListenerSet();

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

  /**
   * Follows `once` for a frame that has loaded, reaching the observer a reconnect
   * would build: a loaded frame under `once` is left unobserved, and one that may
   * re-fetch is observed with its baseline taken afresh, so the first report is
   * where the frame is rather than a return to it.
   *
   * Stimulus can deliver this ahead of `connect()`, and `#loaded` may still hold
   * the previous connection's answer then; the connected guard keeps a callback
   * outside the connected window from building anything.
   */
  onceValueChanged(): void {
    if (!this.#connected || !this.#loaded) return;
    if (this.onceValue) {
      this.#watcher.stop();
    } else if (!this.#watcher.active) {
      this.#inside = null;
      this.#arm();
    }
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
    if (!this.#loaded) this.#focusListeners.add(this.element, "focusin", this.#onFocus);
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

  /**
   * Assigns the held URL to `src` for the first load.
   *
   * @stimeoRuntimeOnly `url` is the address this call assigns and `once` decides whether it
   *   stops the watcher.
   */
  #load(): void {
    if (!this.urlValue) return;
    this.#loaded = true;
    this.element.setAttribute("src", this.urlValue);
    this.element.setAttribute("data-lazy-loaded", "true");
    this.dispatch("load", { detail: { url: this.urlValue } });
    // The focus fallback exists to start the first load; it has nothing left to do.
    this.#focusListeners.dispose();
    if (this.onceValue) this.#watcher.stop();
  }

  /**
   * On re-entry with `once` off, assigns a changed URL or invokes the frame's reload.
   *
   * @stimeoRuntimeOnly A non-empty `url` supplies the address for this re-entry.
   */
  #reload(): void {
    const src = this.element.getAttribute("src");
    if (this.urlValue && this.urlValue !== src) {
      this.element.setAttribute("src", this.urlValue);
      this.dispatch("load", { detail: { url: this.urlValue } });
      return;
    }
    const frame = this.element as HTMLElement & { reload?: () => void };
    // Report a reload only when the host provides the reload path.
    if (typeof frame.reload !== "function") return;
    frame.reload();
    this.dispatch("load", { detail: { url: src ?? "" } });
  }

  #stopObserving(): void {
    this.#watcher.stop();
    this.#focusListeners.dispose();
  }
}
