/**
 * Minimal id primitives for wiring ARIA relationships.
 *
 * Accessible relationships such as `aria-describedby`, `aria-errormessage`,
 * `aria-labelledby`, and `aria-activedescendant` reference their targets by DOM
 * `id`. When a controller must establish such a relationship but the consumer's
 * markup left the target without an `id`, it needs to mint one that is stable for
 * the page's lifetime and guaranteed not to collide with another generated id.
 *
 * These helpers own *only* id generation/assignment. The linking policy (which
 * attribute, what order, when to add or remove it) stays in each controller —
 * this deliberately avoids a premature generic "ARIA linker" abstraction.
 */

/**
 * Monotonic counter backing {@link uniqueId}. Module-scoped so every generated
 * id is unique across all controller instances sharing this module in a document.
 */
let counter = 0;

/**
 * Returns a unique, DOM-id-safe string of the form `` `${prefix}-${n}` `` where
 * `n` increases on each call.
 *
 * The counter alone guarantees uniqueness against other *generated* ids, but a
 * consumer-authored element could already own `` `${prefix}-${n}` ``. When a
 * `document` is available the candidate is therefore advanced until no element
 * with that id exists, so a generated id never collides with author markup
 * either — the minimal "id registry" guarantee these helpers exist to provide.
 *
 * @param prefix - Leading segment of the id (e.g. a controller's identifier).
 *   Defaults to `"stimeo"`.
 */
export function uniqueId(prefix = "stimeo"): string {
  let candidate: string;
  do {
    counter += 1;
    candidate = `${prefix}-${counter}`;
  } while (typeof document !== "undefined" && document.getElementById(candidate) !== null);
  return candidate;
}

/**
 * Returns `element`'s existing `id`, or assigns it a freshly generated
 * {@link uniqueId} (with the given `prefix`) and returns that. Idempotent: an
 * element that already has an id keeps it, so consumer-authored ids are never
 * overwritten.
 *
 * @param element - The element to read or stamp an `id` onto.
 * @param prefix - Prefix forwarded to {@link uniqueId} when one must be generated.
 * @returns The element's id (existing or newly assigned).
 */
export function ensureId(element: Element, prefix = "stimeo"): string {
  if (element.id) return element.id;
  const id = uniqueId(prefix);
  element.id = id;
  return id;
}
