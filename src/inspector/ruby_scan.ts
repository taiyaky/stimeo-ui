/**
 * The lexical floor under the two scanners that read Ruby out of a Rails
 * template: the `data:` hash decoder and the ERB block matcher.
 *
 * Both look for a handful of landmarks — a `data:` key, a block-opening `do` —
 * and both are wrong the instant a landmark's *spelling* turns up somewhere
 * that is not code: inside a `%q[…]` body, a regexp, a comment, a heredoc. This
 * module is only what it takes to step over those as single tokens. It is not a
 * Ruby parser and answers no question about meaning.
 */

/** Characters Ruby treats as inline whitespace, newline included. */
export const SPACE = new Set([" ", "\t", "\n", "\r", "\f"]);
/** First character of a Ruby identifier. */
export const IDENT_START = /[A-Za-z_]/;
/** Any character of a Ruby identifier. */
export const IDENT_CHAR = /[A-Za-z0-9_]/;

/** A decoded string literal and what can be said about it. */
export interface StringLiteral {
  /** Offset just past the closing quote (or end of input when unterminated). */
  readonly end: number;
  /** Decoded contents; meaningful only when {@link literal}. */
  readonly value: string;
  /** Whether the string is a closed literal this scanner decoded in full. */
  readonly literal: boolean;
  /** Whether {@link value} equals the raw source slice, so its range is editable. */
  readonly verbatim: boolean;
  readonly contentStart: number;
  readonly contentEnd: number;
}

/** The escapes a double-quoted Ruby string spells with a letter. */
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  f: "\f",
  v: "\v",
  b: "\b",
  a: "\x07",
  e: "\x1b",
  s: " ",
};

/**
 * Escape forms this scanner does not decode — `\uXXXX`, `\xNN`, octal, and the
 * control/meta prefixes. A string using one is reported as non-literal rather
 * than guessed at, because every consumer of the decoded value compares it
 * against a name and a near-miss reads as a typo the author never wrote.
 */
const UNDECODED_ESCAPE = /[uxcCM0-7]/;

/**
 * Reads the string literal opening at `start`.
 *
 * Interpolation (`#{…}` in a double-quoted string), an unterminated quote, and
 * an escape outside {@link ESCAPES} all make the result non-literal. Escapes
 * that *are* decoded keep the string literal but no longer verbatim, so its
 * source range is withheld rather than reported off-by-a-backslash. Single
 * quotes follow their own rule: only `\\` and `\'` are escapes there, every
 * other pair standing for the two characters it looks like.
 */
export function readString(code: string, start: number): StringLiteral {
  const quote = code[start] as string;
  const single = quote === "'";
  const contentStart = start + 1;
  let i = contentStart;
  let value = "";
  let verbatim = true;

  while (i < code.length) {
    const char = code[i] as string;
    if (char === quote) {
      return { end: i + 1, value, literal: true, verbatim, contentStart, contentEnd: i };
    }
    if (char === "\\") {
      const escaped = code[i + 1];
      if (escaped === undefined) break;
      verbatim = false;
      if (single) {
        value += escaped === "'" || escaped === "\\" ? escaped : `\\${escaped}`;
      } else if (UNDECODED_ESCAPE.test(escaped)) {
        return {
          end: closingQuote(code, i + 2, quote),
          value,
          literal: false,
          verbatim: false,
          contentStart,
          contentEnd: i,
        };
      } else if (escaped !== "\n") {
        // A backslash-newline is a line continuation and contributes nothing.
        value += ESCAPES[escaped] ?? escaped;
      }
      i += 2;
      continue;
    }
    if (!single && char === "#" && code[i + 1] === "{") {
      const close = skipBraces(code, i + 1);
      return {
        end: closingQuote(code, close, quote),
        value,
        literal: false,
        verbatim: false,
        contentStart,
        contentEnd: i,
      };
    }
    value += char;
    i++;
  }
  return {
    end: code.length,
    value,
    literal: false,
    verbatim: false,
    contentStart,
    contentEnd: code.length,
  };
}

/** Offset just past the closing `quote` at or after `from`, else end of input. */
export function closingQuote(code: string, from: number, quote: string): number {
  for (let i = from; i < code.length; i++) {
    if (code[i] === "\\") {
      i++;
      continue;
    }
    if (code[i] === quote) return i + 1;
  }
  return code.length;
}

/** Offset just past the `{ … }` opening at `open`, honoring nesting and strings. */
export function skipBraces(code: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const char = code[i] as string;
    if (char === '"' || char === "'" || char === "`") {
      i = readString(code, i).end;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return code.length;
}

/** Offset of the next line start (or end of input), where a comment ends. */
export function endOfLine(code: string, at: number): number {
  const newline = code.indexOf("\n", at);
  return newline === -1 ? code.length : newline + 1;
}

/** Offset of the next character that is neither whitespace nor a comment. */
export function skipTrivia(code: string, at: number): number {
  let i = at;
  while (i < code.length) {
    const char = code[i] as string;
    if (SPACE.has(char)) i++;
    else if (char === "#") i = endOfLine(code, i);
    else break;
  }
  return i;
}

/**
 * The nearest meaningful character before `at`, `"\n"` when a line break comes
 * first, and `""` at the start of the code. Callers use it to tell the two
 * readings of `/`, `%` and `?` apart: after a value they are operators, and
 * everywhere else they open a literal. Looking backwards is safe because every
 * scanner here consumes strings, comments and literals whole, so these
 * characters are only ever judged at top level.
 */
export function previousSignificant(code: string, at: number): string {
  let i = at - 1;
  while (i >= 0 && (code[i] === " " || code[i] === "\t")) i--;
  return i >= 0 ? (code[i] as string) : "";
}

/** Characters after which a `/`, `%` or `?` opens a literal rather than operating. */
const EXPRESSION_LEAD = new Set([
  "",
  "\n",
  "\r",
  ";",
  "(",
  "[",
  "{",
  ",",
  ":",
  "=",
  "<",
  ">",
  "!",
  "&",
  "|",
  "^",
  "~",
  "+",
  "-",
  "*",
  "/",
  "%",
  "?",
]);

/** Whether a literal — not an operator — may open at `at`. */
export function opensExpression(code: string, at: number): boolean {
  return EXPRESSION_LEAD.has(previousSignificant(code, at));
}

/** The type letters a percent literal may carry; a bare `%` takes the delimiter. */
const PERCENT_TYPES = "qQwWiIrsx";
/** Delimiters that nest; every other punctuation delimiter closes on itself. */
const DELIMITER_PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

/**
 * Offset just past the literal opening at `at` — a percent literal, a regexp,
 * or a character literal — or `-1` when none opens there.
 *
 * Strings are deliberately not handled here: their callers need the decoded
 * value, which {@link readString} returns. What these three share is that their
 * bodies are text, so a `data:` or an `end` inside one is not syntax.
 */
export function skipLiteral(code: string, at: number): number {
  const char = code[at];
  if (char === undefined) return -1;

  if (char === "%") {
    const typed = PERCENT_TYPES.includes(code[at + 1] ?? "");
    const open = typed ? code[at + 2] : code[at + 1];
    if (open === undefined || IDENT_CHAR.test(open) || SPACE.has(open)) return -1;
    // A bare `%` is modulo far more often than it is a literal, so it needs its
    // surroundings to say otherwise — Ruby reads the same shape the same way,
    // taking `a %(x)` for an argument and `a % x` for an operator. The
    // `%w`-style spellings are unambiguous already.
    if (!typed && !opensExpression(code, at) && !SPACE.has(code[at - 1] ?? "")) return -1;
    const end = closeDelimited(code, typed ? at + 3 : at + 2, open);
    return end < 0 ? code.length : end;
  }

  if (char === "/" && opensExpression(code, at)) {
    const end = closeDelimited(code, at + 1, "/");
    // An unterminated slash is a division whose position merely looked like a
    // literal's; consuming the rest of the code on that guess loses real syntax.
    if (end < 0) return -1;
    let i = end;
    while (i < code.length && /[imxounse]/.test(code[i] as string)) i++;
    return i;
  }

  if (char === "?" && opensExpression(code, at)) {
    const next = code[at + 1];
    if (next === undefined || SPACE.has(next)) return -1;
    if (next === "\\") return at + 3;
    // `?abc` is a ternary whose branch happens to start with a word; only a
    // single character following the `?` is the literal.
    if (IDENT_CHAR.test(next) && IDENT_CHAR.test(code[at + 2] ?? "")) return -1;
    return at + 2;
  }

  return -1;
}

/** Offset just past the delimiter closing the body that starts at `from`, else -1. */
function closeDelimited(code: string, from: number, open: string): number {
  const close = DELIMITER_PAIRS[open] ?? open;
  const nests = close !== open;
  let depth = 1;
  for (let i = from; i < code.length; i++) {
    const char = code[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (nests && char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** A heredoc opener: `<<~ID`, `<<-ID`, `<<"ID"`, or the bare `<<ID`. */
const HEREDOC_OPEN = /^<<([-~])?(["'`])?([A-Za-z_]\w*)/;

/**
 * Blanks the body of every heredoc in `code`, keeping newlines and total length
 * so that every offset still points at the same character of the original.
 *
 * A heredoc body is prose the helper prints, not options it takes, and it is
 * the one construct whose text is not adjacent to the token that introduces it
 * — the opener sits mid-expression while the body starts on the next line. Both
 * scanners above therefore run over the masked copy: the code around the
 * opener stays exactly where it was, and nothing inside the body is read as
 * syntax.
 */
export function maskHeredocs(code: string): string {
  let masked = code;
  let i = 0;
  while (i < masked.length) {
    const char = masked[i] as string;
    if (char === "#") {
      i = endOfLine(masked, i);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      i = readString(masked, i).end;
      continue;
    }
    const literal = skipLiteral(masked, i);
    if (literal > i) {
      i = literal;
      continue;
    }
    if (char === "<" && masked[i + 1] === "<") {
      const [matched, dash, quote, identifier] = HEREDOC_OPEN.exec(masked.slice(i)) ?? [];
      // `a << b` is a shift; only the squiggly/dash forms, a quoted tag, or a
      // constant-shaped tag in expression position introduce a body.
      const opensBody =
        identifier !== undefined &&
        (dash !== undefined ||
          quote !== undefined ||
          (/^[A-Z]/.test(identifier) && opensExpression(masked, i)));
      // A quoted tag is only an opener once it is closed.
      const consumed = (matched?.length ?? 0) + (quote === undefined ? 0 : 1);
      if (opensBody && (quote === undefined || masked[i + consumed - 1] === quote)) {
        const bodyStart = endOfLine(masked, i);
        const bodyEnd = heredocEnd(masked, bodyStart, identifier);
        masked =
          masked.slice(0, bodyStart) +
          masked.slice(bodyStart, bodyEnd).replace(/[^\n]/g, " ") +
          masked.slice(bodyEnd);
        i += consumed;
        continue;
      }
    }
    i++;
  }
  return masked;
}

/** Offset just past the line that closes a heredoc tagged `identifier`. */
function heredocEnd(code: string, bodyStart: number, identifier: string): number {
  let line = bodyStart;
  while (line < code.length) {
    const next = endOfLine(code, line);
    if (code.slice(line, next).trim() === identifier) return next;
    line = next;
  }
  return code.length;
}
