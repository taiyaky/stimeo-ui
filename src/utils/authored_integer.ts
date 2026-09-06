/** Digits plus the characters that may separate them inside one number. */
const TOKEN_BODY = /\d[\d.,'’’    _]*\d|\d/;
/** A `-` opens a token only against one of these on its left. */
const SIGN_OPENER = /[\s([]/;

/**
 * Reads the integer that a human-formatted string displays.
 *
 * Takes the first numeric token, drops group separators, and truncates any
 * fractional part toward zero — so `"1,200 users"`, `"$1,299.99"` and
 * `"1.299,99"` read 1200, 1299 and 1299 without asking the platform which
 * locale is in play. A separator counts as grouping only where the digits that
 * follow it form a run of exactly three and the leading run could head a
 * grouped number; anything else is the decimal point, and the digits after it
 * are the fraction.
 *
 * `-` counts as a sign only where it opens the token — at the start of the
 * string, or after whitespace or an opening bracket — so a hyphen inside a
 * label (`"Sign-ups: 1,200"`, `"Top-10 users"`) never becomes one.
 *
 * `"1.200"` is genuinely ambiguous (1200 grouped, 1.2 with a decimal point) and
 * reads as 1200: display numbers group far more often than they carry a
 * fraction in exactly three digits.
 *
 * Returns `null` when the string holds no digits at all. What that means is the
 * caller's to decide — starting nothing, or falling back to a base value.
 */
export function authoredInteger(text: string): number | null {
  const firstDigit = /\d/.exec(text);
  if (firstDigit === null) return null;

  const at = firstDigit.index;
  const signed =
    at > 0 && text[at - 1] === "-" && (at === 1 || SIGN_OPENER.test(text[at - 2] as string));

  const body = TOKEN_BODY.exec(text.slice(at)) as RegExpExecArray;
  const runs = body[0].split(/\D+/);
  const separators = body[0].match(/\D+/g) ?? [];

  // The leading run heads a grouped number only when it is short enough to be a
  // group itself and carries no leading zero; "0.500" and "012,3" are decimals.
  const lead = runs[0] as string;
  const heads = lead.length <= 3 && !lead.startsWith("0");
  let digits = lead;
  for (let i = 1; heads && i < runs.length; i += 1) {
    if (separators[i - 1]?.length !== 1 || runs[i]?.length !== 3) break;
    digits += runs[i];
  }

  const magnitude = Number.parseInt(digits, 10);
  return signed ? -magnitude || 0 : magnitude;
}
