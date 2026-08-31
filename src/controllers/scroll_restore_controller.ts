import { Controller } from "@hotwired/stimulus";

/** Persisted scroll position; fields are present only for the saved axis. */
interface StoredScroll {
  top?: number;
  left?: number;
}

/**
 * Reads one persisted entry, or `null` when there is nothing usable to read.
 *
 * `JSON.parse` returns `null` for the literal `null` without throwing, so the
 * parse guard alone would hand back a value with no fields to read. Every field the
 * caller applies is validated there, which is what makes a bare literal harmless here.
 */
function parseStored(raw: string | null): StoredScroll | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as StoredScroll | null;
  } catch {
    return null;
  }
}

/** One axis offset from a persisted entry, or `null` when it cannot be applied. */
function storedOffset(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
 * Values:
 * - `key` — the `sessionStorage` namespace. Empty falls back to the element `id`;
 *   with neither, nothing is saved or restored, so positions from unrelated pages
 *   cannot mix.
 * - `axis` — which offset is tracked: `vertical` (default, `scrollTop`),
 *   `horizontal` (`scrollLeft`) or `both`. An offset stored for an axis that is
 *   not tracked is neither applied nor discarded.
 *
 * Both Values are re-derived when they change at runtime, so a morph that
 * rewrites the attribute in place switches namespace or axis instead of going on
 * writing under the one that held at connect. A `key` left empty resolves through
 * the element `id`, which no Value callback observes; runtime `id` changes are
 * out of scope.
 *
 * @remarks
 * Behavior only — it sets no ARIA/`data-*`/CSS and never moves focus. Restoring
 * goes through `scrollTo({ behavior: "instant" })` so that a consumer's
 * `scroll-behavior: smooth` cannot turn it into an animation whose intermediate
 * offsets would be recorded as the reader's own scrolling. The `scroll` listener
 * is internal and `passive` (no consumer `data-action` needed): each event
 * records the live offset synchronously, and a `requestAnimationFrame` coalesces
 * the writes to `sessionStorage`. On `disconnect()` (Turbo navigation included)
 * it flushes the **last captured** offset rather than re-reading the element — by
 * the time Turbo fires `disconnect` it has already detached the node, whose
 * `scrollTop` then reads `0`, so a fresh read would clobber the saved position
 * with `0`. Keying by `key` (falling back to the element `id`) in
 * `sessionStorage` makes it multi-instance safe and survives full reloads —
 * unlike a module-scope variable, which only survives Turbo Drive and assumes a
 * single instance. Storage access is best-effort: a browser that refuses it
 * (private mode, quota) leaves the element working, just without persistence.
 */
export class ScrollRestoreController extends Controller<HTMLElement> {
  static override values = {
    key: { type: String, default: "" },
    axis: { type: String, default: "vertical" },
  };

  declare keyValue: string;
  declare axisValue: string;

  /** Pending rAF id that coalesces scroll bursts into one save. */
  #rafId: number | null = null;
  /** Resolved storage key; empty disables persistence (no key and no id). */
  #storageKey = "";
  /** Last offset captured while the element was live; persisted as-is on teardown. */
  #lastTop = 0;
  #lastLeft = 0;
  /**
   * The offsets this controller's own restore produced, awaiting the `scroll`
   * the engine fires for them. A restore the layout cannot reach yet lands short,
   * so treating that echo as the reader's position would cut the saved offset
   * down to whatever the unfinished layout allowed.
   */
  #echoTop: number | null = null;
  #echoLeft: number | null = null;
  /** Offsets stored for an axis that is not tracked, carried through saves. */
  #carried: StoredScroll = {};
  /**
   * Whether each axis holds an offset worth saving — one this namespace restored
   * or the reader moved. A save writes only the axes that are marked, so an
   * offset taken under a different key or axis is never re-published as if the
   * reader had left it there.
   */
  #capturedTop = false;
  #capturedLeft = false;
  /** Whether the controller is connected; Value callbacks outside that window do not resync. */
  #connected = false;

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
    this.#connected = true;
    this.#storageKey = this.#resolveKey();
    this.element.addEventListener("scroll", this.#onScroll, { passive: true });
    if (this.#storageKey) this.#restore();
  }

  override disconnect(): void {
    this.#connected = false;
    this.element.removeEventListener("scroll", this.#onScroll);
    this.#cancelFrame();
    // Flush the last captured offset (a throttled burst may have left the final
    // frame unsaved). We do NOT re-read the element here: Turbo detaches the node
    // before disconnect, so its scrollTop is 0 and would overwrite the real value.
    this.#persist();
  }

  /** Re-derives the namespace when application code or a Turbo morph moves `key`. */
  keyValueChanged(): void {
    this.#resync();
  }

  /** Re-derives the tracked axes when application code or a Turbo morph moves `axis`. */
  axisValueChanged(): void {
    this.#resync();
  }

  /** Rebuilds the persistence state around the Values as they now read. */
  #resync(): void {
    if (!this.#connected) return;
    // The pending frame holds an offset belonging to the previous namespace and
    // axis, so it is dropped rather than written under the new ones.
    this.#cancelFrame();
    this.#storageKey = this.#resolveKey();
    this.#echoTop = null;
    this.#echoLeft = null;
    this.#carried = {};
    // An offset is only ever written for an axis this namespace seeded or the
    // reader moved. Clearing both marks drops the ones taken under the previous
    // key and axis, which the restore below re-establishes only where the new
    // key actually holds a value.
    this.#capturedTop = false;
    this.#capturedLeft = false;
    if (this.#storageKey) this.#restore();
  }

  /** Drops the pending coalesced save, if one is queued. */
  #cancelFrame(): void {
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
  }

  /**
   * Records the live scroll offset for the configured axis.
   *
   * An axis holds its echo until that axis actually moves. A scroll event names
   * no axis, so consuming both on the first one to arrive would leave the other
   * unguarded: on `both`, moving one axis would take the clamped reading of the
   * untouched axis as the reader's own position and save it, cutting the stored
   * offset down to whatever the layout could reach at restore time.
   */
  #capture(): void {
    if (this.#tracksVertical) {
      const top = this.element.scrollTop;
      if (top !== this.#echoTop) {
        this.#echoTop = null;
        this.#lastTop = top;
        this.#capturedTop = true;
      }
    }
    if (this.#tracksHorizontal) {
      const left = this.element.scrollLeft;
      if (left !== this.#echoLeft) {
        this.#echoLeft = null;
        this.#lastLeft = left;
        this.#capturedLeft = true;
      }
    }
  }

  /**
   * Writes the marked axes, carrying through any offset held for an untracked one.
   * Without a key, or with neither axis marked, it writes nothing.
   */
  #persist(): void {
    if (!this.#storageKey || !(this.#capturedTop || this.#capturedLeft)) return;
    const data: StoredScroll = { ...this.#carried };
    if (this.#tracksVertical && this.#capturedTop) data.top = this.#lastTop;
    if (this.#tracksHorizontal && this.#capturedLeft) data.left = this.#lastLeft;
    try {
      window.sessionStorage.setItem(this.#storageKey, JSON.stringify(data));
    } catch {
      // sessionStorage can throw (private mode / quota); persistence is best-effort.
    }
  }

  /** Applies the persisted scroll offset, if any, without moving focus. */
  #restore(): void {
    let raw: string | null;
    try {
      raw = window.sessionStorage.getItem(this.#storageKey);
    } catch {
      return;
    }
    const data = parseStored(raw);
    if (data === null) return;

    // A restore writes its own echoes below; one left over from an earlier pass
    // would otherwise swallow the first matching move the reader makes.
    this.#echoTop = null;
    this.#echoLeft = null;

    const top = storedOffset(data.top);
    const left = storedOffset(data.left);
    const options: ScrollToOptions = { behavior: "instant" };
    let requested = false;
    // Seed the capture cache from the restored value so an immediate teardown
    // (before any scroll) re-persists the restored position, not 0. Guard by the
    // configured axis so a stale field from a different axis is never applied —
    // and keep it, since the next save would otherwise drop it.
    if (this.#tracksVertical) {
      if (top !== null) {
        options.top = top;
        this.#lastTop = top;
        this.#capturedTop = true;
        requested = true;
      }
    } else if (data.top !== undefined) {
      this.#carried.top = data.top;
    }
    if (this.#tracksHorizontal) {
      if (left !== null) {
        options.left = left;
        this.#lastLeft = left;
        this.#capturedLeft = true;
        requested = true;
      }
    } else if (data.left !== undefined) {
      this.#carried.left = data.left;
    }
    if (!requested) return;

    const beforeTop = this.element.scrollTop;
    const beforeLeft = this.element.scrollLeft;
    this.element.scrollTo(options);
    if (this.element.scrollTop !== beforeTop) this.#echoTop = this.element.scrollTop;
    if (this.element.scrollLeft !== beforeLeft) this.#echoLeft = this.element.scrollLeft;
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
