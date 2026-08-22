/** The distance between a full-width ASCII code point and its half-width twin. */
const FULL_WIDTH_SHIFT = 0xfee0;

/**
 * The half-width form of `char`, or `char` itself when it has none.
 *
 * An IME confirming in full-width mode produces U+FF01–U+FF5E (and U+3000 for
 * the space) where the page means ASCII — the digits of a phone number, the
 * letters of a code, the separators between them. Reading those as their ASCII
 * equivalents keeps confirmed text usable instead of discarding it. Characters
 * outside that block, including kana and astral code points, are returned
 * unchanged, so this never rewrites text a consumer meant to keep as typed.
 */
export function halfWidthChar(char: string): string {
  if (char >= "！" && char <= "～") {
    return String.fromCharCode(char.charCodeAt(0) - FULL_WIDTH_SHIFT);
  }
  return char === "　" ? " " : char;
}

/** Every full-width ASCII character in `text` rewritten by {@link halfWidthChar}. */
export function toHalfWidth(text: string): string {
  let out = "";
  for (const char of text) out += halfWidthChar(char);
  return out;
}
