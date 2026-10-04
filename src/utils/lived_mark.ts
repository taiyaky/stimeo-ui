import { MorphRenderWatcher } from "./morph_render_watcher";

/**
 * How one connection of a controller relates to the page it connects on.
 *
 * - `"fresh"` — the first connection of this instance, on an element without the mark: a page
 *   the server rendered, or an element added to the live page.
 * - `"reconnect"` — a later connection of the same instance: an in-page move, or a
 *   `data-turbo-permanent` element Turbo carried to the next page.
 * - `"restored"` — the first connection of this instance, on an element that carries the
 *   mark: a copy of the page Turbo restores from its cache (Back and Forward, a promoted frame
 *   navigation followed by Back) or shows as the preview of a cached page.
 */
export type LivedConnection = "fresh" | "reconnect" | "restored";

/**
 * Tells a copy of a page Turbo restores from its cache from a fresh render, by a mark each
 * connection leaves on the controller element.
 *
 * {@link LivedMark.connect} writes `data-<identifier>-lived` on the element and says how the
 * connection relates to the page. Nothing removes the mark: Turbo copies the page into its
 * cache at different moments of a navigation — after the body swap on a visit, at the start of
 * the navigation on a promoted frame — before the controller disconnects or after it, and the
 * copy carries the mark either way, while server markup never does. A new instance that finds
 * the mark is on such a copy; a reconnect of the same instance is not, whatever the element
 * carries. A Turbo morph keeps only the attributes the server sent, so the mark is written
 * again after every morph of the element or its descendants, until
 * {@link LivedMark.disconnect}. `turbo:before-cache` plays no part: Turbo also dispatches it
 * on pages that stay.
 *
 * The mark is an internal hook, not a styling one, and its name ends in no suffix Stimulus
 * reads.
 */
export class LivedMark {
  readonly #name: string;
  /** Whether this instance has connected before. */
  #lived = false;
  /** The element the mark is written on, for the pass that follows a morph. */
  #element: Element | null = null;
  readonly #morph = new MorphRenderWatcher(() => this.#write());

  /** @param identifier - The controller's identifier; the mark is `data-<identifier>-lived`. */
  constructor(identifier: string) {
    this.#name = `data-${identifier}-lived`;
  }

  /** Marks `element`, follows its morphs, and says how this connection relates to the page. */
  connect(element: Element): LivedConnection {
    const connection = this.#lived
      ? "reconnect"
      : element.hasAttribute(this.#name)
        ? "restored"
        : "fresh";
    this.#lived = true;
    this.#element = element;
    this.#write();
    this.#morph.observe(element);
    return connection;
  }

  /** Stops following morphs; the mark stays, for a copy Turbo may take after this. */
  disconnect(): void {
    this.#morph.disconnect();
  }

  /** Writes the mark on the element. */
  #write(): void {
    this.#element?.setAttribute(this.#name, "");
  }
}
