/**
 * Sends one message to the page's shared `stimeo--announcer`.
 *
 * A component that has to reach assistive tech does not carry a live region of its
 * own: a region only announces what changes *after* assistive tech already knows
 * about it, which a region that appears (or is un-hidden) with its message cannot
 * satisfy. The one region that can is the announcer sitting in the page from the
 * start, so state changes are handed to it as an event and it does the reading.
 *
 * The event goes to `window` because the announcer is usually a sibling high in the
 * document rather than an ancestor of the component dispatching it.
 *
 * Wording comes from the consumer — the library ships no English strings — so an
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

/**
 * Fills `{name}` placeholders in an announcement template from `values`.
 *
 * The same substitution the value-text templates use, so a consumer writes
 * `"{percent}% complete"` in one attribute and gets the same rules everywhere. A
 * placeholder with no matching entry is left as authored rather than blanked, which
 * keeps a typo visible instead of silently swallowing the word.
 */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, name: string) => {
    const replacement = values[name];
    return replacement === undefined ? match : String(replacement);
  });
}
