import { describe, expect, it } from "vitest";
import {
  getPrompt,
  InvalidPromptRequestError,
  PROMPT_DESCRIPTORS,
} from "../../src/inspector/mcp/prompts";

/**
 * Tests for the pure prompt builders. Protocol framing (`prompts/list` /
 * `prompts/get`) is covered by `mcp_server.test.ts`; here we assert the
 * `(name, args) → messages` contract: interpolation, optional arguments, and
 * every rejection path.
 */
describe("PROMPT_DESCRIPTORS", () => {
  it("advertises exactly the dispatchable prompts with their arguments", () => {
    expect(PROMPT_DESCRIPTORS.map((p) => p.name)).toEqual(["stimeo_build_ui", "stimeo_fix_markup"]);
    for (const prompt of PROMPT_DESCRIPTORS) {
      expect(prompt.description.length).toBeGreaterThan(0);
      expect(prompt.arguments.length).toBeGreaterThan(0);
      // Exactly one required argument per prompt keeps slash-command UX light.
      expect(prompt.arguments.filter((a) => a.required).map((a) => a.name)).toEqual([
        prompt.arguments[0]?.name,
      ]);
    }
  });

  it("dispatches every advertised prompt (list and get cannot drift apart)", () => {
    for (const prompt of PROMPT_DESCRIPTORS) {
      const args = Object.fromEntries(
        prompt.arguments.filter((a) => a.required).map((a) => [a.name, "x"]),
      );
      expect(getPrompt(prompt.name, args).messages.length).toBeGreaterThan(0);
    }
  });
});

describe("getPrompt — stimeo_build_ui", () => {
  it("interpolates the request and defaults to catalog discovery", () => {
    const result = getPrompt("stimeo_build_ui", { request: "a delete-confirmation dialog" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain("Task: a delete-confirmation dialog");
    expect(text).toContain("stimeo_catalog");
    expect(text).toContain("stimeo_controller");
    expect(text).toContain("stimeo_example");
    expect(text).toContain("stimeo_check");
  });

  it("starts from the given controller when one is passed, trimming it", () => {
    const result = getPrompt("stimeo_build_ui", {
      request: "tabs for a settings page",
      controller: "  stimeo--tabs  ",
    });
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain('Start from the controller "stimeo--tabs"');
    expect(text).not.toContain("1. Call stimeo_catalog");
  });

  it("treats a whitespace-only controller as absent and falls back to discovery", () => {
    const result = getPrompt("stimeo_build_ui", { request: "a menu", controller: "   " });
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain("1. Call stimeo_catalog");
    expect(text).not.toContain("Start from the controller");
  });

  it("rejects a missing or blank request", () => {
    expect(() => getPrompt("stimeo_build_ui", {})).toThrow(InvalidPromptRequestError);
    expect(() => getPrompt("stimeo_build_ui", { request: "  " })).toThrow(
      InvalidPromptRequestError,
    );
  });
});

describe("getPrompt — stimeo_fix_markup", () => {
  it("embeds the source inside a code fence and mentions the filename when given", () => {
    const result = getPrompt("stimeo_fix_markup", {
      source: '<div data-controller="stimeo--menu"></div>',
      filename: "app/views/users/show.html.erb",
    });
    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain('```erb\n<div data-controller="stimeo--menu"></div>\n```');
    expect(text).toContain('(filename: "app/views/users/show.html.erb")');
    expect(text).toContain("stimeo_check");
  });

  it("omits the filename clause when none is given or it is whitespace-only", () => {
    expect(
      getPrompt("stimeo_fix_markup", { source: "<div></div>" }).messages[0]?.content.text,
    ).not.toContain("filename:");
    expect(
      getPrompt("stimeo_fix_markup", { source: "<div></div>", filename: "   " }).messages[0]
        ?.content.text,
    ).not.toContain("filename:");
  });

  it("rejects a missing source", () => {
    expect(() => getPrompt("stimeo_fix_markup", {})).toThrow(InvalidPromptRequestError);
  });
});

describe("getPrompt — rejection paths", () => {
  it("rejects unknown prompt names", () => {
    expect(() => getPrompt("stimeo_write_ui", {})).toThrow(/Unknown prompt "stimeo_write_ui"/);
  });

  it("rejects undeclared argument keys", () => {
    expect(() => getPrompt("stimeo_build_ui", { request: "x", extra: "y" })).toThrow(
      /Unknown argument "extra"/,
    );
  });

  it("rejects non-string argument values (the prompts spec allows strings only)", () => {
    expect(() => getPrompt("stimeo_build_ui", { request: 3 })).toThrow(InvalidPromptRequestError);
  });

  it("rejects non-object arguments", () => {
    expect(() => getPrompt("stimeo_build_ui", ["request"])).toThrow(InvalidPromptRequestError);
  });
});
