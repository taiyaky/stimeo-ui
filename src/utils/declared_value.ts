/**
 * Readers for the String Values whose text can only be checked by handing it to
 * a parser: a CSS selector, a regular-expression source, a JSON object.
 *
 * Stimulus reads each of them as an ordinary string, so the controller connects
 * and the flaw surfaces later, inside the first handler that consumes the value
 * (a `SyntaxError` from `new RegExp`, a `DOMException` from the selector engine),
 * where it takes the whole handler down on every event. Parsing here, once, in
 * the `<name>ValueChanged` callback keeps the failure local to the declaration:
 * an unreadable value falls back to its default, the element stays alive, and
 * the hot path only ever receives a value that parsed.
 *
 * Which default a broken declaration falls back to is the caller's contract, so
 * every reader takes (or returns) the fallback rather than choosing one.
 */

/**
 * The result of `parse(raw)`, or `fallback` when `parse` throws.
 *
 * Any exception counts as "does not parse": the parsers these Values feed
 * (`RegExp`, `JSON.parse`, the selector engine) all report a malformed input by
 * throwing, and none of them throws for another reason.
 */
export function parseDeclared<T>(raw: string, parse: (raw: string) => T, fallback: T): T {
  try {
    return parse(raw);
  } catch {
    return fallback;
  }
}

/** What {@link validSelector} needs of the element it probes with. */
export interface SelectorProbe {
  matches(selector: string): boolean;
}

/**
 * `raw` when it is a non-empty selector the DOM accepts, otherwise `fallback`.
 *
 * `element.matches` is the probe: the engine parses the selector and throws for
 * one it cannot read. Whether the selector actually matches `element` plays no
 * part, so a selector aimed at another element still passes.
 *
 * The parameter names the one method the probe uses rather than `Element`, so
 * this module carries no DOM type and the readers below stay importable from
 * the Node-side Inspector, which checks the same declarations statically.
 */
export function validSelector(element: SelectorProbe, raw: string, fallback: string): string {
  if (raw.length === 0) return fallback;
  return parseDeclared(
    raw,
    (selector) => {
      element.matches(selector);
      return selector;
    },
    fallback,
  );
}

/** How `compileRegExp` wraps a source before compiling it. */
export type RegExpAnchor = "none" | "exact";

/**
 * `source` compiled as a `RegExp`, or `null` when it does not compile.
 *
 * `"exact"` wraps the source as `^(?:source)$`, so the whole input has to match
 * and an alternation inside the source cannot escape the anchors. The source is
 * compiled on its own first, because an unbalanced source can be made to parse
 * by the wrapper's own parentheses — `0)|(1` becomes `^(?:0)|(1)$` — which would
 * accept a declaration that is not a regular expression and leave half of it
 * outside the anchors. The default that replaces a broken source is the
 * caller's, so `null` is returned rather than a fallback pattern.
 */
export function compileRegExp(source: string, anchor: RegExpAnchor = "none"): RegExp | null {
  return parseDeclared(
    source,
    (text) => {
      const bare = new RegExp(text);
      return anchor === "exact" ? new RegExp(`^(?:${text})$`) : bare;
    },
    null,
  );
}

/**
 * The JSON object `raw` declares, or `null` when the text does not parse or
 * parses to something other than a plain object (`null`, an array, a scalar).
 * Values are returned as parsed; narrowing them is the caller's contract.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const parsed = parseDeclared<unknown>(raw, (text) => JSON.parse(text), null);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
