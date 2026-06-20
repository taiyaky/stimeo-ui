/**
 * Neutralizes ERB so the HTML parser only ever sees static markup.
 *
 * Every ERB tag — `<% %>`, `<%= %>`, `<%# %>`, plus the whitespace-trimming
 * variants `<%- -%>` — is replaced with spaces. Newlines inside the tag are
 * preserved so that 1-based line/column positions used in diagnostics line up
 * with the original source.
 *
 * Because ERB is blanked rather than interpreted, dynamically-generated markup
 * is naturally excluded from checking: a dynamic identifier such as
 * `data-controller="<%= id %>"` collapses to an empty attribute value and a
 * dynamic attribute name such as `data-<%= x %>-target` no longer matches the
 * `stimeo--*` patterns. This is the intended "dynamic attributes are out of
 * scope" behavior.
 *
 * @param source - Raw HTML/ERB source.
 * @returns The source with all ERB tags replaced by position-preserving spaces.
 */
export function neutralizeErb(source: string): string {
  return source.replace(/<%[\s\S]*?%>/g, (match) => match.replace(/[^\n]/g, " "));
}
