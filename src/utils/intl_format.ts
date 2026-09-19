/**
 * Construction of `Intl` formatters for the controllers that take a locale, and
 * the options that go with it, from a declaration.
 *
 * Every `Intl` constructor resolves locale data on the way in, which makes it
 * too costly to rebuild on a hot path, and rejects a malformed language tag,
 * currency code, time zone or digit count with a `RangeError`. Both concerns are
 * handled here once. A formatter is built at most once per distinct request and
 * shared by every caller that asks for the same one. A `RangeError` is caught
 * and answered the way the caller asked: by rebuilding under a fallback locale,
 * or by returning `null` so the caller can leave its authored text alone. Any
 * other failure is a programming fault and propagates.
 */

/** The constructor shape the `Intl` formatter classes share. */
export interface IntlFormatterConstructor<F, O extends object> {
  new (locales?: string | string[], options?: O): F;
}

/** Built formatters, and refusals, per constructor; see `cacheKey` for the key. */
const formatters = new WeakMap<object, Map<string, unknown>>();

/**
 * A formatter for `locale` with `options`.
 *
 * With `fallbackLocale`, a `RangeError` from the constructor is answered by
 * building the same options under the fallback instead, so the result is never
 * `null`; the fallback's own failure propagates. Without it, a `RangeError`
 * yields `null` and the caller decides what to show. Errors of any other kind
 * propagate in both forms.
 *
 * Results are cached per constructor and `(locale, options, fallback)`, `null`
 * included, so asking again on every render costs one map lookup.
 */
export function intlFormatter<F, O extends object>(
  factory: IntlFormatterConstructor<F, O>,
  locale: string | undefined,
  options: O,
  fallbackLocale: string,
): F;
export function intlFormatter<F, O extends object>(
  factory: IntlFormatterConstructor<F, O>,
  locale: string | undefined,
  options: O,
): F | null;
export function intlFormatter<F, O extends object>(
  factory: IntlFormatterConstructor<F, O>,
  locale: string | undefined,
  options: O,
  fallbackLocale?: string,
): F | null {
  const cache = cacheFor(factory);
  const key = cacheKey(locale, options, fallbackLocale);
  if (cache.has(key)) return cache.get(key) as F | null;
  const formatter = construct(factory, locale, options, fallbackLocale);
  cache.set(key, formatter);
  return formatter;
}

/** The cache for one constructor, created on first use. */
function cacheFor(factory: object): Map<string, unknown> {
  const existing = formatters.get(factory);
  if (existing) return existing;
  const created = new Map<string, unknown>();
  formatters.set(factory, created);
  return created;
}

/**
 * One key per distinct request. `JSON.stringify` drops an option left
 * `undefined`, which is how the constructor reads it too. Two spellings of the
 * same options differing only in key order key separately; that costs one extra
 * formatter, never a wrong one, and call sites pass a fixed literal anyway.
 */
function cacheKey(
  locale: string | undefined,
  options: object,
  fallbackLocale: string | undefined,
): string {
  return JSON.stringify([locale, options, fallbackLocale]);
}

/** Builds the formatter under the `RangeError` contract described on `intlFormatter`. */
function construct<F, O extends object>(
  factory: IntlFormatterConstructor<F, O>,
  locale: string | undefined,
  options: O,
  fallbackLocale: string | undefined,
): F | null {
  try {
    return new factory(locale, options);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    if (fallbackLocale === undefined) return null;
    return new factory(fallbackLocale, options);
  }
}
