import { Controller } from "@hotwired/stimulus";

/** Persisted scroll position; fields are present only for the saved axis. */
interface StoredScroll {
  top?: number;
  left?: number;
}

/**
 * Headless **Scroll Restore** behavior: persists and restores the scroll
 * position of an inner scrolling region across Turbo Drive navigations (and full
 * reloads within the same tab session). No APG widget — a pure state-preservation
 * utility, like {@link import("./scroll_visibility_controller").ScrollVisibilityController}
 * and the Sticky State Observer.
 *
 * Markup contract (identifier: `stimeo--scroll-restore`):
 *   <div data-controller="stimeo--scroll-restore"
 *        data-stimeo--scroll-restore-key-value="sidebar"
 *        style="overflow: auto">
 *     …long content…
 *   </div>
 *
 * Turbo swaps the whole `<body>` on navigation, so an inner scroll container is
 * rebuilt with `scrollTop` reset to 0. Rather than have every app hand-write a
 * controller for this (which contradicts a "ship the behavior" library), this
 * persists the offset under a stable key in `sessionStorage` and restores it on
 * `connect()`.
 *
 * @remarks
 * Behavior only — it sets no ARIA/`data-*`/CSS and never moves focus (restore is
 * a plain `scrollTop`/`scrollLeft` assignment). The `scroll` listener is internal
 * and `passive` (no consumer `data-action` needed): each event records the live
 * offset synchronously, and a `requestAnimationFrame` coalesces the writes to
 * `sessionStorage`. On `disconnect()` (Turbo navigation included) it flushes the
 * **last captured** offset rather than re-reading the element — by the time Turbo
 * fires `disconnect` it has already detached the node, whose `scrollTop` then
 * reads `0`, so a fresh read would clobber the saved position with `0`. Keying by
 * `key` (falling back to the element `id`) in `sessionStorage` makes it
 * multi-instance safe and survives full reloads — unlike a module-scope variable,
 * which only survives Turbo Drive and assumes a single instance.
 */
export class ScrollRestoreController extends Controller<HTMLElement> {
  static override values = {
    key: { type: String, default: "" },
    axis: { type: String, default: "vertical" },
  };

  declare keyValue: string;
  declare axisValue: string;

  /** Pending rAF id used to coalesce scroll bursts into one save. */
  #rafId: number | null = null;
  /** Resolved storage key; empty disables persistence (no key and no id). */
  #storageKey = "";
  /** Last offset captured while the element was live; persisted as-is on teardown. */
  #lastTop = 0;
  #lastLeft = 0;

  readonly #onScroll = (): void => {
    // Capture synchronously while the element is still connected and measurable;
    // the rAF only debounces the sessionStorage write, never the read.
    this.#capture();
    if (this.#rafId !== null) return;
    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = null;
      this.#persist();
    });
  };

  override connect(): void {
    this.#storageKey = this.#resolveKey();
    if (!this.#storageKey) return; // No stable key → do nothing (avoid mixing pages).
    this.#restore();
    this.element.addEventListener("scroll", this.#onScroll, { passive: true });
  }

  override disconnect(): void {
    if (!this.#storageKey) return;
    this.element.removeEventListener("scroll", this.#onScroll);
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    // Flush the last captured offset (a throttled burst may have left the final
    // frame unsaved). We do NOT re-read the element here: Turbo detaches the node
    // before disconnect, so its scrollTop is 0 and would overwrite the real value.
    this.#persist();
  }

  /** Records the live scroll offset for the configured axis. */
  #capture(): void {
    if (this.#tracksVertical) this.#lastTop = this.element.scrollTop;
    if (this.#tracksHorizontal) this.#lastLeft = this.element.scrollLeft;
  }

  /** Persists the last captured scroll offset for the configured axis. */
  #persist(): void {
    const data: StoredScroll = {};
    if (this.#tracksVertical) data.top = this.#lastTop;
    if (this.#tracksHorizontal) data.left = this.#lastLeft;
    try {
      sessionStorage.setItem(this.#storageKey, JSON.stringify(data));
    } catch {
      // sessionStorage can throw (private mode / quota); persistence is best-effort.
    }
  }

  /** Applies the persisted scroll offset, if any, without moving focus. */
  #restore(): void {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(this.#storageKey);
    } catch {
      return;
    }
    if (raw === null) return;
    let data: StoredScroll;
    try {
      data = JSON.parse(raw) as StoredScroll;
    } catch {
      return;
    }
    // Seed the capture cache from the restored value so an immediate teardown
    // (before any scroll) re-persists the restored position, not 0. Guard by the
    // configured axis so a stale field from a different axis is never applied.
    if (this.#tracksVertical && typeof data.top === "number") {
      this.element.scrollTop = data.top;
      this.#lastTop = data.top;
    }
    if (this.#tracksHorizontal && typeof data.left === "number") {
      this.element.scrollLeft = data.left;
      this.#lastLeft = data.left;
    }
  }

  /** The `sessionStorage` key: explicit `key`, else the element `id`, else none. */
  #resolveKey(): string {
    const base = this.keyValue || this.element.id;
    return base ? `stimeo--scroll-restore:${base}` : "";
  }

  get #tracksVertical(): boolean {
    return this.axisValue !== "horizontal";
  }

  get #tracksHorizontal(): boolean {
    return this.axisValue === "horizontal" || this.axisValue === "both";
  }
}
