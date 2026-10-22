import { ListenerSet } from "./listener_set";

/**
 * Follows font loading completion in an element's current owner document.
 *
 * Both `loadingdone` and `loadingerror` run the supplied callback synchronously.
 * Measurement and notification policy stay with the caller. Observing the same
 * source preserves its registrations; changing the source releases the former
 * one, including when the next document has no fonts API. Each instance owns its
 * callback identity so independent watchers can safely share a callback.
 */
export class FontLoadWatcher {
  readonly #listeners = new ListenerSet();
  readonly #onSettled: EventListener;
  #fonts: EventTarget | null = null;

  /** @param run - the consumer's synchronous font-completion measurement. */
  constructor(run: () => void) {
    this.#onSettled = () => run();
  }

  /** Follows the element's current font source; a missing API leaves no subscription. */
  observe(element: Element): void {
    const fonts = element.ownerDocument.fonts ?? null;
    if (fonts === this.#fonts) return;
    this.disconnect();
    if (!fonts) return;
    this.#fonts = fonts;
    this.#listeners.add(fonts, "loadingdone", this.#onSettled);
    this.#listeners.add(fonts, "loadingerror", this.#onSettled);
  }

  /** Releases the held source synchronously; repeated calls and later observation are safe. */
  disconnect(): void {
    this.#listeners.dispose();
    this.#fonts = null;
  }
}
