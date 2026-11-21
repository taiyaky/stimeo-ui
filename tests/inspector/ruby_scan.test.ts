import { describe, expect, it } from "vitest";
import {
  endOfLine,
  maskHeredocs,
  previousSignificant,
  readString,
  skipBraces,
  skipLiteral,
  skipTrivia,
} from "../../src/inspector/ruby_scan";
import { withinTimeLimit } from "../helpers/time_limit";

/**
 * Tests for the lexical floor under the Ruby scanners. Each function steps over
 * one construct whole and reports where it ends, so these pin the offsets
 * themselves: a construct that ends one character early leaves its text to be
 * read as code, and one that ends late swallows the code after it.
 */
describe("endOfLine", () => {
  it("ends at the next line start, or at the end of the input when no newline follows", () => {
    expect(endOfLine("# a\nb", 0)).toBe(4);
    expect(endOfLine("a # b", 2)).toBe(5);
  });
});

describe("skipTrivia", () => {
  it("stops at the first code character after whitespace and a comment", () => {
    const source = "  # comment\n  value";
    const offset = withinTimeLimit(() => skipTrivia(source, 0));
    expect(source.slice(offset)).toBe("value");
  });
});

describe("readString", () => {
  it.each(['"\\u0041"', '"\\u0041\\"b"'])(
    "ends a string with an undecoded escape at its own closing quote (%s)",
    (text) => {
      const source = `${text} + x`;
      const literal = readString(source, 0);
      expect(literal.literal).toBe(false);
      expect(source.slice(literal.end)).toBe(" + x");
    },
  );

  it("ends an interpolated string at its own closing quote, past the braces", () => {
    const literal = readString('"a#{b}c" + d', 0);
    expect(literal).toMatchObject({ end: 8, literal: false });
  });
});

describe("skipBraces", () => {
  it("skips a closing brace inside a quoted string", () => {
    const source = '{ call("}") } + rest';
    expect(source.slice(skipBraces(source, 0))).toBe(" + rest");
  });
});

describe("previousSignificant", () => {
  it("returns the nearest character before the offset, stepping over spaces and tabs", () => {
    expect(previousSignificant("a \t/", 3)).toBe("a");
  });

  it("returns an empty string at the start of the code", () => {
    expect(previousSignificant("  /", 2)).toBe("");
  });
});

/**
 * `%`, `/` and `?` each open a literal in one position and operate in another,
 * and the literal's end decides where the caller resumes reading code.
 */
describe("skipLiteral", () => {
  describe("percent literals", () => {
    it("opens nothing on a percent sign followed by whitespace, a word character or nothing", () => {
      expect(skipLiteral("a % b", 2)).toBe(-1);
      expect(skipLiteral("n %2", 2)).toBe(-1);
      expect(skipLiteral("x %", 2)).toBe(-1);
    });

    it("reads a bare percent sign after a value as a modulo, and after a space as a literal", () => {
      expect(skipLiteral("a%(b)", 1)).toBe(-1);
      expect(skipLiteral("a %(b)", 2)).toBe(6);
    });

    it("starts a bare literal's body right after its delimiter", () => {
      expect(skipLiteral("%() + b", 0)).toBe(3);
    });

    it("runs an unterminated literal to the end of the input", () => {
      expect(skipLiteral("%w[a b", 0)).toBe(6);
    });

    it("skips an escaped closing delimiter inside the literal", () => {
      const source = "%q[a\\]b] + rest";
      expect(source.slice(skipLiteral(source, 0))).toBe(" + rest");
    });

    it("skips nested delimiters up to the outer close", () => {
      const source = "%q[a[b]c] + rest";
      expect(source.slice(skipLiteral(source, 0))).toBe(" + rest");
    });
  });

  describe("regexps", () => {
    it("reads a closed slash in expression position as a regexp, flags included", () => {
      expect(skipLiteral("x = /a/i", 4)).toBe(8);
    });

    it("opens nothing on an unterminated slash", () => {
      expect(skipLiteral("x = /", 4)).toBe(-1);
    });
  });

  describe("character literals", () => {
    it("reads a question mark and the one character after it", () => {
      expect(skipLiteral("x = ?a", 4)).toBe(6);
    });

    it("spans the backslash and the character an escaped literal names", () => {
      expect(skipLiteral('x = ?\\" + y', 4)).toBe(7);
    });

    it("opens nothing on a question mark followed by whitespace or nothing", () => {
      expect(skipLiteral("x = ? y", 4)).toBe(-1);
      expect(skipLiteral("x = ?", 4)).toBe(-1);
    });

    it("opens nothing on a question mark before a word, which is a ternary", () => {
      expect(skipLiteral("ok? ?yes : no", 4)).toBe(-1);
    });
  });
});

/**
 * Masking keeps the offsets and blanks exactly the heredoc bodies; the scan
 * runs under a time limit because every loop in it advances by the offsets the
 * functions above return.
 */
describe("maskHeredocs", () => {
  /** Masks `code`, failing rather than hanging if the scan stops advancing. */
  function mask(code: string): string {
    return withinTimeLimit(() => maskHeredocs(code));
  }

  it("masks the body of a heredoc whose tag is quoted", () => {
    expect(mask("x = <<~'A'\n  data\nA\n")).toBe("x = <<~'A'\n      \n \n");
  });

  it("stops masking at the line that closes the heredoc", () => {
    expect(mask("f <<~A\n  x\nA\ndata")).toBe("f <<~A\n   \n \ndata");
  });

  it.each(['"<<~A"', "%q[<<~A]"])(
    "leaves text resembling a heredoc opener inside the literal %s",
    (literal) => {
      const source = `x = ${literal}\nkeep\nA\n`;
      expect(mask(source)).toBe(source);
    },
  );

  it("resumes right after an unquoted tag, so a comment written against it stays a comment", () => {
    expect(mask("f <<~A#it's\nx\nA\ng <<~B\ny\nB\n")).toBe("f <<~A#it's\n \n \ng <<~B\n \n \n");
  });
});
