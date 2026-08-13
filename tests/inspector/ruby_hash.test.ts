import { describe, expect, it } from "vitest";
import { type DataAttribute, readDataOption } from "../../src/inspector/ruby_hash";

/**
 * Tests for the Ruby `data:` hash scanner: which spellings decode into which
 * rendered attribute, and — just as important — which constructs are reported
 * as unreadable instead of being approximated.
 */
describe("readDataOption", () => {
  /** Decodes a helper call, returning `name → value` for its literal entries. */
  function decode(code: string): Record<string, string | null> {
    const entries = readDataOption(code, 0).attrs.map(
      (attr: DataAttribute) => [attr.name, attr.value] as const,
    );
    return Object.fromEntries(entries);
  }

  describe("key spellings", () => {
    it("reads a symbol key", () => {
      expect(decode(`form_with url: "/x", data: { controller: "stimeo--menu" }`)).toEqual({
        "data-controller": "stimeo--menu",
      });
    });

    it("reads a quoted key, the only way to spell a hyphenated target attribute", () => {
      expect(decode(`f.text_area :body, data: { "stimeo--form-field-target": "control" }`)).toEqual(
        {
          "data-stimeo--form-field-target": "control",
        },
      );
    });

    it("dasherizes underscores the way Rails renders them", () => {
      // The double underscore is what lets the namespace separator survive a
      // bare symbol key, so both spellings of the same target are accepted.
      expect(decode(`tag.div data: { stimeo__form_field_target: "control" }`)).toEqual({
        "data-stimeo--form-field-target": "control",
      });
    });

    it("reads hashrocket entries", () => {
      expect(decode(`tag.div data: { :controller => "stimeo--menu", "action" => "x" }`)).toEqual({
        "data-controller": "stimeo--menu",
        "data-action": "x",
      });
    });

    it("reads the option itself written as a symbol or a string key", () => {
      expect(decode(`tag.div :data => { controller: "stimeo--menu" }`)).toEqual({
        "data-controller": "stimeo--menu",
      });
      expect(decode(`tag.div "data": { controller: "stimeo--menu" }`)).toEqual({
        "data-controller": "stimeo--menu",
      });
    });

    it("finds the option nested inside another options hash", () => {
      expect(decode(`form_for @x, html: { data: { controller: "stimeo--menu" } }`)).toEqual({
        "data-controller": "stimeo--menu",
      });
    });

    it("does not mistake a longer identifier ending in data for the option", () => {
      const scan = readDataOption(`tag.div metadata: { controller: "stimeo--menu" }`, 0);
      expect(scan.found).toBe(false);
      expect(scan.attrs).toEqual([]);
    });

    it("does not read data as a key when the colon is detached", () => {
      // `data :sym` passes an argument; only `data:` is a hash key.
      expect(readDataOption(`render data :controller`, 0).found).toBe(false);
    });
  });

  describe("value readings", () => {
    it("decodes decimal numeric literals used by Stimulus Values", () => {
      expect(decode(`tag.div data: { stimeo__slider_step_value: -1.5e2, count: 1_000 }`)).toEqual({
        "data-stimeo--slider-step-value": "-1.5e2",
        "data-count": "1_000",
      });
    });

    it("keeps a single-quoted value", () => {
      expect(decode(`tag.div data: { controller: 'stimeo--menu' }`)).toEqual({
        "data-controller": "stimeo--menu",
      });
    });

    it("reads an action descriptor whose value contains # and ->", () => {
      expect(decode(`button_tag "Go", data: { action: "click->stimeo--menu#toggle" }`)).toEqual({
        "data-action": "click->stimeo--menu#toggle",
      });
    });

    it("marks an expression value as unknown rather than guessing", () => {
      expect(decode(`tag.div data: { controller: some_var, "x-target": "y" }`)).toEqual({
        "data-controller": null,
        "data-x-target": "y",
      });
    });

    it("marks an interpolated string as unknown", () => {
      expect(decode('tag.div data: { controller: "stimeo--#{kind}" }')).toEqual({
        "data-controller": null,
      });
    });

    it("marks a string that only starts an expression as unknown", () => {
      expect(decode(`tag.div data: { controller: "a" + b }`)).toEqual({ "data-controller": null });
    });

    it("reads entries after a nested hash value without losing them", () => {
      expect(decode(`tag.div data: { nested: { a: 1 }, controller: "stimeo--menu" }`)).toEqual({
        "data-nested": null,
        "data-controller": "stimeo--menu",
      });
    });

    it("reads entries after a value holding a comma", () => {
      expect(decode(`tag.div data: { list: [1, 2], controller: "stimeo--menu" }`)).toEqual({
        "data-list": null,
        "data-controller": "stimeo--menu",
      });
    });

    it("reads entries after a percent-literal value", () => {
      expect(decode(`tag.div data: { tags: %w[a, b], controller: "stimeo--menu" }`)).toEqual({
        "data-tags": null,
        "data-controller": "stimeo--menu",
      });
    });
  });

  /**
   * Ruby's escapes decide what the rendered attribute actually says, so a
   * near-miss reading would report a typo the author never wrote.
   */
  describe("escapes", () => {
    it("decodes the escapes a double-quoted string spells with a letter", () => {
      expect(decode(`tag.div data: { title: "a\\nb\\tc" }`)).toEqual({ "data-title": "a\nb\tc" });
    });

    it("leaves a single-quoted backslash pair as its two characters", () => {
      expect(decode(`tag.div data: { title: 'a\\nb' }`)).toEqual({ "data-title": "a\\nb" });
    });

    it("still honors the two escapes single quotes do have", () => {
      expect(decode(`tag.div data: { title: 'it\\'s a\\\\b' }`)).toEqual({
        "data-title": "it's a\\b",
      });
    });

    it("reports a numeric escape as unknown rather than decoding it wrongly", () => {
      expect(decode(`tag.div data: { controller: "stimeo--\\u006denu" }`)).toEqual({
        "data-controller": null,
      });
      expect(decode(`tag.div data: { controller: "stimeo--\\x6denu" }`)).toEqual({
        "data-controller": null,
      });
    });
  });

  describe("what cannot be enumerated", () => {
    it("reports an expression option as opaque", () => {
      const scan = readDataOption(`f.text_area :body, data: attrs_for(field)`, 0);
      expect(scan).toMatchObject({ found: true, opaque: true, attrs: [] });
    });

    it("reports a splatted hash as opaque while keeping the literal entries", () => {
      const scan = readDataOption(`tag.div data: { **defaults, controller: "stimeo--menu" }`, 0);
      expect(scan.opaque).toBe(true);
      expect(decode(`tag.div data: { **defaults, controller: "stimeo--menu" }`)).toEqual({
        "data-controller": "stimeo--menu",
      });
    });

    it("reports a computed key as opaque", () => {
      expect(readDataOption(`tag.div data: { key => "x" }`, 0).opaque).toBe(true);
    });

    it("stays readable when every entry is literal", () => {
      expect(readDataOption(`tag.div data: { controller: "stimeo--menu" }`, 0).opaque).toBe(false);
    });

    it("reports a hash the expression goes on to transform as opaque", () => {
      // `{}.merge(…)` and `{…} || x` hand the helper something this scanner
      // never sees, so the braces it can read are not the whole option.
      expect(readDataOption(`tag.div data: {}.merge(controller: "stimeo--menu")`, 0)).toMatchObject(
        {
          found: true,
          opaque: true,
        },
      );
      expect(readDataOption(`tag.div data: { controller: "x" } || fallback`, 0).opaque).toBe(true);
    });

    it("keeps a hash a block or a modifier merely follows readable", () => {
      expect(readDataOption(`tag.div data: { controller: "stimeo--menu" } do`, 0).opaque).toBe(
        false,
      );
      expect(
        readDataOption(`link_to "x", data: { controller: "stimeo--menu" } if a`, 0).opaque,
      ).toBe(false);
    });

    it("reports no option at all when the code has none", () => {
      expect(readDataOption(`t(".title")`, 0)).toEqual({ attrs: [], found: false, opaque: false });
    });
  });

  describe("source ranges", () => {
    it("points the key and value at their offsets in the original template", () => {
      const code = `tag.div data: { controller: "stimeo--menu" }`;
      const [attr] = readDataOption(code, 100).attrs;
      expect(attr?.keyStart).toBe(100 + code.indexOf("controller:"));
      expect(attr?.valueStart).toBe(100 + code.indexOf("stimeo--menu"));
      expect(attr?.valueEnd).toBe(100 + code.indexOf("stimeo--menu") + "stimeo--menu".length);
    });

    it("spans the key as written, quotes and all", () => {
      const bare = readDataOption(`tag.div data: { controller: "x" }`, 0).attrs[0];
      expect((bare?.keyEnd ?? 0) - (bare?.keyStart ?? 0)).toBe("controller".length);
      const quoted = readDataOption(`tag.div data: { "stimeo--menu-target": "x" }`, 0).attrs[0];
      expect((quoted?.keyEnd ?? 0) - (quoted?.keyStart ?? 0)).toBe(`"stimeo--menu-target"`.length);
    });

    it("withholds the range of an escaped literal, whose text is not its value", () => {
      const [attr] = readDataOption(`tag.div data: { title: "a\\"b" }`, 0).attrs;
      expect(attr?.value).toBe('a"b');
      expect(attr?.valueStart).toBeUndefined();
    });
  });

  describe("trivia", () => {
    it("reads a hash spread over lines with a comment in it", () => {
      expect(decode(`tag.div data: {\n  # the widget\n  controller: "stimeo--menu",\n}`)).toEqual({
        "data-controller": "stimeo--menu",
      });
    });

    it("ignores a data: key written inside a comment", () => {
      expect(readDataOption(`tag.div # data: { controller: "x" }`, 0).found).toBe(false);
    });

    it("ignores a data: key written inside a string", () => {
      expect(readDataOption(`tag.div title: "data: { controller: 'x' }"`, 0).found).toBe(false);
    });
  });

  /**
   * Constructs whose bodies are text, not syntax. Reading into one invents
   * wiring the page never renders; letting one of its characters end a scan
   * early drops the wiring that is really there.
   */
  describe("literals that only look like code", () => {
    it("ignores a data: key written inside a percent literal", () => {
      expect(readDataOption(`tag.pre %q[data: { controller: "x" }]`, 0).found).toBe(false);
      expect(readDataOption(`tag.pre %(data: { controller: "x" })`, 0).found).toBe(false);
    });

    it("ignores a data: key written inside a heredoc body", () => {
      const code = `tag.div <<~HTML\n  data: { controller: "x" }\nHTML`;
      expect(readDataOption(code, 0).found).toBe(false);
    });

    it("keeps reading the options a heredoc opener is written among", () => {
      const code = `tag.div <<~HTML, data: { controller: "stimeo--menu" }\n  <b>hi</b>\nHTML`;
      expect(decode(code)).toEqual({ "data-controller": "stimeo--menu" });
    });

    it("reads past a quoted heredoc tag without taking its quote for a string", () => {
      const code = `tag.div <<~'HTML', data: { controller: "stimeo--menu" }\n  raw\nHTML`;
      expect(decode(code)).toEqual({ "data-controller": "stimeo--menu" });
    });

    it("does not take a # inside a regexp for the start of a comment", () => {
      expect(decode(`tag.div title: /#/, data: { controller: "stimeo--menu" }`)).toEqual({
        "data-controller": "stimeo--menu",
      });
    });

    it("still reads a slash that divides rather than opening a regexp", () => {
      expect(decode(`tag.div width: a / b, data: { controller: "stimeo--menu" }`)).toEqual({
        "data-controller": "stimeo--menu",
      });
    });

    it("still reads a percent that takes a modulo rather than opening a literal", () => {
      expect(decode(`tag.div label: "%d" % n, data: { controller: "stimeo--menu" }`)).toEqual({
        "data-controller": "stimeo--menu",
      });
    });

    it("ignores a data: key written inside a backtick string", () => {
      expect(readDataOption('tag.div `data: { controller: "x" }`', 0).found).toBe(false);
    });

    it("ignores a data: key written inside a character literal", () => {
      // `?d` is one character, so nothing after it belongs to a literal.
      expect(decode(`tag.div sep: ?,, data: { controller: "stimeo--menu" }`)).toEqual({
        "data-controller": "stimeo--menu",
      });
    });
  });
});
