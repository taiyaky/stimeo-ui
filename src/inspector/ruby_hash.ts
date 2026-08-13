import {
  endOfLine,
  IDENT_CHAR,
  IDENT_START,
  maskHeredocs,
  readString,
  skipLiteral,
  skipTrivia,
} from "./ruby_scan";

/**
 * A scanner for the **literal** Ruby hashes Rails helpers take as their `data:`
 * option.
 *
 * Rails templates express Stimulus wiring two ways for the same rendered
 * markup: as HTML attributes on a static tag, and as a `data:` hash handed to a
 * helper (`form_with … data: { controller: "stimeo--x" }`,
 * `f.text_area :body, data: { "stimeo--x-target": "control" }`). A checker that
 * reads only the first sees neither the wiring nor its mistakes, so this module
 * decodes the second into the attributes the helper will render.
 *
 * Only **literals** are decoded. The moment a key or a value is an expression
 * the entry is reported as unresolved rather than guessed at: a wrong reading
 * would either fabricate wiring the page never renders or vouch for markup
 * nobody checked. The same reason splits the two failure modes the result
 * carries — a value that is an expression (the attribute exists, its content is
 * unknown) from a hash that cannot be enumerated at all (attributes may exist
 * that are not listed here).
 *
 * This is deliberately **not** a Ruby parser. It understands hash literals,
 * string and symbol keys, string values, and nothing else; every other
 * construct is treated as opaque rather than approximated. Text that merely
 * *looks* like a hash — a `%q[…]` body, a regexp, a heredoc — is stepped over
 * whole by {@link skipLiteral} and {@link maskHeredocs}, so a spelling inside
 * prose is never read as wiring.
 */

/** One decoded `data:` entry, named as the helper will render it. */
export interface DataAttribute {
  /** Rendered attribute name, e.g. `data-controller` (underscores dasherized). */
  readonly name: string;
  /** Decoded literal value, or `null` when the entry's value is an expression. */
  readonly value: string | null;
  /** Absolute source offset of the entry's key. */
  readonly keyStart: number;
  /**
   * Absolute offset just past the key **as written** — the closing quote of a
   * quoted key, the last character of a bare one. Diagnostics anchored at this
   * entry underline that span, which is the only token the reader can act on;
   * the rendered attribute name appears nowhere in the source.
   */
  readonly keyEnd: number;
  /**
   * Absolute offset where the value's text begins in the source, present only
   * when the literal is verbatim (no escapes), so a consumer may edit the range
   * directly. Absent for expression values and for escaped literals.
   */
  readonly valueStart?: number;
  /** Absolute offset just past the value's text; see {@link valueStart}. */
  readonly valueEnd?: number;
}

/** What one ERB tag's Ruby code says about its `data:` option(s). */
export interface DataOption {
  /** Every entry decoded from every `data:` hash in the code. */
  readonly attrs: readonly DataAttribute[];
  /** Whether the code names a `data:` option at all. */
  readonly found: boolean;
  /**
   * Whether some part of the `data:` option could not be enumerated — the
   * option is an expression (`data: attrs`), the hash splats another
   * (`**defaults`), a key is computed, or a literal hash is only the first term
   * of a larger expression (`{}.merge(…)`). {@link attrs} may then be
   * incomplete, so an attribute's *absence* proves nothing.
   */
  readonly opaque: boolean;
}

/**
 * Decodes every `data:` option written in one ERB tag's Ruby code.
 *
 * The option is found by **key name, at any nesting depth**, because helpers
 * disagree on where it sits: top level for `form_with`, inside the trailing
 * options hash for a form-builder field, inside `html:` for the older builders.
 * Matching on position would miss most real templates; matching on the name
 * costs a rare false read (a `data:` key that is not an HTML option, e.g. a
 * local passed to a partial), which decodes to attributes that are then simply
 * checked for spelling like any others.
 *
 * @param source - Ruby source between the ERB delimiters.
 * @param base - Absolute offset of `source[0]` in the original template, so the
 *   reported ranges point back at the template rather than at this fragment.
 */
export function readDataOption(source: string, base: number): DataOption {
  const code = maskHeredocs(source);
  const attrs: DataAttribute[] = [];
  let found = false;
  let opaque = false;
  let i = 0;

  while (i < code.length) {
    const char = code[i] as string;

    if (char === "#") {
      i = endOfLine(code, i);
      continue;
    }

    // A quoted `data:` key ("data": …) — otherwise just a string to step over.
    if (char === '"' || char === "'" || char === "`") {
      const literal = readString(code, i);
      // A backtick runs a command; its output is never a hash key.
      const value = char === "`" ? null : keySeparator(code, literal.end);
      if (literal.literal && literal.value === "data" && value !== null) {
        i = value;
      } else {
        i = literal.end;
        continue;
      }
    } else if (char === ":" && IDENT_START.test(code[i + 1] ?? "")) {
      // A symbol: `:data => …` when it names the option, else skipped whole so
      // its characters are not re-read as a bare key.
      const name = readIdentifier(code, i + 1);
      const value = hashRocket(code, name.end);
      if (name.text === "data" && value !== null) {
        i = value;
      } else {
        i = name.end;
        continue;
      }
    } else if (IDENT_START.test(char) && !IDENT_CHAR.test(code[i - 1] ?? "")) {
      const name = readIdentifier(code, i);
      // `data:` binds tighter than `data :sym` (an argument, not a key), so the
      // colon must be adjacent; `::` is a constant path, never a key.
      const keyed = name.text === "data" && code[name.end] === ":" && code[name.end + 1] !== ":";
      if (keyed) {
        i = name.end + 1;
      } else {
        i = name.end;
        continue;
      }
    } else {
      const literal = skipLiteral(code, i);
      i = literal < 0 ? i + 1 : literal;
      continue;
    }

    // Reached only with `i` just past a `data:` separator.
    found = true;
    const start = skipTrivia(code, i);
    if (code[start] === "{") {
      const hash = readHash(code, start, base);
      attrs.push(...hash.attrs);
      // A hash the expression goes on to transform (`{}.merge(…)`, `{…} || x`)
      // says nothing about what the helper finally receives, so the entries
      // above stand as names to spell-check and as nothing else.
      if (hash.partial || !optionEnds(code, hash.end)) opaque = true;
      i = hash.end;
    } else {
      opaque = true;
      i = start;
    }
  }

  return { attrs, found, opaque };
}

/** Words that may follow a `data:` hash without continuing its expression. */
const OPTION_TAIL = /^(?:do|if|unless|while|until|rescue|then|and|or|end)\b/;

/**
 * Whether the option the hash belonged to ends at `at`. Only an argument
 * boundary, a block, or a statement modifier may follow: anything else —
 * a `.`, an operator — makes the hash one term of a larger expression whose
 * result nobody here can name.
 */
function optionEnds(code: string, at: number): boolean {
  const i = skipTrivia(code, at);
  if (i >= code.length) return true;
  const char = code[i] as string;
  if (char === "," || char === "}" || char === ")" || char === "]" || char === ";") return true;
  return OPTION_TAIL.test(code.slice(i));
}

/** A hash literal decoded into its entries. */
interface HashLiteral {
  readonly attrs: readonly DataAttribute[];
  /** Whether the hash holds something this scanner cannot name. */
  readonly partial: boolean;
  /** Absolute-relative offset just past the closing brace. */
  readonly end: number;
}

/** Decodes `{ … }` starting at `open` (which must be the brace). */
function readHash(code: string, open: number, base: number): HashLiteral {
  const attrs: DataAttribute[] = [];
  let partial = false;
  let i = open + 1;

  for (;;) {
    i = skipTrivia(code, i);
    if (i >= code.length) {
      partial = true; // unterminated: assume the rest holds more entries
      break;
    }
    if (code[i] === "}") {
      i++;
      break;
    }
    if (code[i] === ",") {
      i++;
      continue;
    }
    const entry = readEntry(code, i, base);
    if (entry.attr) attrs.push(entry.attr);
    else partial = true;
    i = entry.end;
  }

  return { attrs, partial, end: i };
}

/** One hash entry: its attribute when both sides are readable, else `null`. */
interface HashEntry {
  readonly attr: DataAttribute | null;
  readonly end: number;
}

/** Decodes one `key: value` / `key => value` pair starting at `start`. */
function readEntry(code: string, start: number, base: number): HashEntry {
  const key = readKey(code, start);
  if (key === null) return { attr: null, end: skipValue(code, start) };

  const valueStart = skipTrivia(code, key.valueAt);
  const name = attributeName(key.name);
  if (name === null) return { attr: null, end: skipValue(code, valueStart) };
  const anchor = { keyStart: base + start, keyEnd: base + key.end };

  const quote = code[valueStart];
  if (quote === '"' || quote === "'") {
    const literal = readString(code, valueStart);
    const after = skipTrivia(code, literal.end);
    // Only a string that *is* the whole value counts; `"a" + b` is an
    // expression whose first token happens to be a literal.
    const whole = after >= code.length || code[after] === "," || code[after] === "}";
    if (literal.literal && whole) {
      return {
        attr: {
          name,
          value: literal.value,
          ...anchor,
          valueStart: literal.verbatim ? base + literal.contentStart : undefined,
          valueEnd: literal.verbatim ? base + literal.contentEnd : undefined,
        },
        end: literal.end,
      };
    }
  }

  // Rails serializes a numeric data-hash literal as deterministically as a
  // quoted string. Decode decimal/exponent spellings so semantic Inspector
  // rules (for example `step > 0`) also cover idiomatic helper markup. Bases
  // and expressions stay undecidable rather than being partially interpreted.
  const number = /^[+-]?\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/.exec(
    code.slice(valueStart),
  )?.[0];
  if (number !== undefined) {
    const end = valueStart + number.length;
    const after = skipTrivia(code, end);
    const whole = after >= code.length || code[after] === "," || code[after] === "}";
    if (whole) {
      return {
        attr: {
          name,
          value: number,
          ...anchor,
          valueStart: base + valueStart,
          valueEnd: base + end,
        },
        end,
      };
    }
  }

  // The key is known, the value is not: the attribute is rendered, its content
  // undecidable — exactly the state an ERB-interpolated attribute value is in.
  return { attr: { name, value: null, ...anchor }, end: skipValue(code, valueStart) };
}

/** A hash key: its name, where it ends, and the offset its value starts after. */
interface HashKey {
  readonly name: string;
  /** Offset just past the key as written, quotes included. */
  readonly end: number;
  readonly valueAt: number;
}

/** Reads a literal hash key in any of Ruby's four spellings, else `null`. */
function readKey(code: string, start: number): HashKey | null {
  const char = code[start];

  if (char === '"' || char === "'") {
    const literal = readString(code, start);
    const valueAt = keySeparator(code, literal.end);
    if (!literal.literal || valueAt === null) return null;
    return { name: literal.value, end: literal.end, valueAt };
  }

  if (char === ":" && IDENT_START.test(code[start + 1] ?? "")) {
    const name = readIdentifier(code, start + 1);
    const valueAt = hashRocket(code, name.end);
    return valueAt === null ? null : { name: name.text, end: name.end, valueAt };
  }

  if (char !== undefined && IDENT_START.test(char)) {
    const name = readIdentifier(code, start);
    if (code[name.end] !== ":" || code[name.end + 1] === ":") return null;
    return { name: name.text, end: name.end, valueAt: name.end + 1 };
  }

  return null;
}

/**
 * The attribute a `data:` key renders as. Rails dasherizes underscores, which
 * is what lets a hyphenated Stimulus name be written as a bare symbol
 * (`stimeo__menu_target:` → `data-stimeo--menu-target`) as well as quoted.
 * Returns `null` for a key that cannot name an attribute.
 */
function attributeName(key: string): string | null {
  const name = key.replaceAll("_", "-").toLowerCase();
  return name.length > 0 && !/[\s"'=<>/]/.test(name) ? `data-${name}` : null;
}

/** The offset after `:` / `=>` following a key at `at`, or `null`. */
function keySeparator(code: string, at: number): number | null {
  if (code[at] === ":" && code[at + 1] !== ":") return at + 1;
  return hashRocket(code, at);
}

/** The offset after a `=>` (allowing whitespace before it), or `null`. */
function hashRocket(code: string, at: number): number | null {
  const arrow = skipTrivia(code, at);
  return code.startsWith("=>", arrow) ? arrow + 2 : null;
}

/** Reads the identifier starting at `start` (its first char is an ident start). */
function readIdentifier(code: string, start: number): { text: string; end: number } {
  let end = start;
  while (end < code.length && IDENT_CHAR.test(code[end] as string)) end++;
  return { text: code.slice(start, end), end };
}

/**
 * Steps over one hash value (or a key this scanner cannot read) to the `,` or
 * `}` that ends it, tracking bracket nesting and every literal form so a value
 * containing one of those characters does not end the entry early.
 */
function skipValue(code: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < code.length) {
    const char = code[i] as string;
    if (char === '"' || char === "'" || char === "`") {
      i = readString(code, i).end;
      continue;
    }
    if (char === "#") {
      i = endOfLine(code, i);
      continue;
    }
    const literal = skipLiteral(code, i);
    if (literal >= 0) {
      i = literal;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (char === "," && depth === 0) return i;
    i++;
  }
  return code.length;
}
