/**
 * The locale a component formats in: its own declaration, else the language of
 * the text around it, else the runtime default.
 *
 * `lang` is inherited in HTML, so the language that applies to an element is the
 * nearest one on the element itself or on an ancestor — not the document
 * element's, which is only the farthest of them. An empty `lang` there means the
 * language is unknown and stops the inheritance at that point, so it resolves to
 * the runtime default rather than to a `lang` further up.
 *
 * Resolution only, and the value is passed through as authored. Whether `Intl`
 * accepts the tag, and what to show when it does not, is the caller's contract.
 *
 * @example
 * ```ts
 * intlFormatter(Intl.DateTimeFormat, resolveLocale(this.element, this.localeValue), options);
 * ```
 */
export function resolveLocale(element: Element, declared = ""): string | undefined {
  return declared || element.closest("[lang]")?.getAttribute("lang") || undefined;
}
