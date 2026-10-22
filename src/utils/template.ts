/**
 * Fills `{name}` placeholders in a localized template from the own entries of `values`.
 *
 * Announcement and value-text templates share this one substitution, so a consumer writes
 * `"{percent}% complete"` in one attribute and gets the same rules everywhere. A
 * placeholder with no matching entry is left as authored rather than blanked, which
 * keeps a typo visible instead of silently swallowing the word.
 * Every occurrence is filled in one pass. Inserted strings stay literal, including
 * replacement-pattern characters and text that resembles another placeholder.
 */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, name: string) => {
    const replacement = Object.hasOwn(values, name) ? values[name] : undefined;
    return replacement === undefined ? match : String(replacement);
  });
}
