/**
 * JSON string-list parsing for the controllers that take a list as a Value.
 *
 * Stimulus offers an `Array` Value type, but its reader runs `JSON.parse` inside
 * the value observer — **before** the `<name>ValueChanged` callback — and
 * rethrows on malformed text. The throw propagates out of the observer that runs
 * during connection, so a single unparseable attribute stops the controller from
 * connecting at all: no lifecycle callback runs and the element is left inert
 * rather than degraded. A consumer cannot guard against it either, because the
 * callback that would hold the `try` never runs.
 *
 * Declaring the attribute as a `String` Value and parsing it here keeps a
 * malformed declaration local to the value it declares. The attribute text is
 * identical either way (`'["a", "b"]'`), so markup does not change with the
 * declaration.
 */

/**
 * Parses `raw` as a JSON array of strings.
 *
 * Returns `fallback` when the text is absent, unparseable, or not an array, so a
 * malformed declaration behaves like an omitted one. A parsed array keeps only
 * its string entries: every caller indexes or compares strings, and a stray
 * number would otherwise sit in the list without ever matching.
 *
 * An explicit `"[]"` is honoured as an empty list rather than falling back — it
 * is the only way to declare "none" against a non-empty default.
 *
 * @param raw - the attribute text, e.g. `'["password"]'`.
 * @param fallback - the list to use when `raw` declares nothing usable.
 */
export function parseStringList(raw: string, fallback: readonly string[] = []): string[] {
  // The common case is an undeclared attribute, and `JSON.parse("")` answers it
  // by throwing. Reaching the same fallback without building an exception keeps
  // the callers that ask per element off that path.
  const text = raw.trim();
  if (text.length === 0) return [...fallback];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [...fallback];
  }

  if (!Array.isArray(parsed)) return [...fallback];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}
