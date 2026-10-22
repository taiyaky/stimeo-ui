export { fillTemplate } from "./template";

/**
 * Sends one message to the page's shared `stimeo--announcer`.
 *
 * A message that has to reach assistive tech is not put into a live region created
 * or un-hidden along with it: a region only announces what changes *after* assistive
 * tech already knows about it, which such a region cannot satisfy. The announcer has
 * to be in the page before any message is handed to it — one sent while no announcer
 * is listening is not read — so state changes reach it as an event and it does the
 * reading.
 *
 * The event goes to `window` because the announcer is usually a sibling high in the
 * document rather than an ancestor of the component dispatching it.
 *
 * Wording comes from the consumer — this helper adds no text of its own — so an
 * empty message is silently dropped and nothing is announced.
 *
 * @example
 * ```ts
 * announce(this.announceTextValue, { assertive: false });
 * ```
 */
export function announce(message: string, options: { assertive?: boolean } = {}): void {
  const text = message.trim();
  if (text.length === 0) return;
  window.dispatchEvent(
    new CustomEvent("stimeo--announcer:announce", {
      detail: { message: text, assertive: options.assertive === true },
    }),
  );
}
