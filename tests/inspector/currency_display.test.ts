import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSource } from "../../src/inspector/check";
import { buildCheckReport, formatGithubAnnotation, runCli } from "../../src/inspector/cli";
import { buildManifest } from "../../src/inspector/manifest";
import { runCheckTool, runControllerTool, TOOL_DESCRIPTORS } from "../../src/inspector/mcp/tools";
import type { Manifest } from "../../src/inspector/types";

const manifest = buildManifest("0.0.0");
const display = `<input aria-label="Amount" inputmode="decimal"
  data-stimeo--currency-input-target="display"
  data-action="input->stimeo--currency-input#onInput blur->stimeo--currency-input#format">`;
const scope = (contents: string) => `<div data-controller="stimeo--currency-input">
  ${contents}<input type="hidden" name="amount" data-stimeo--currency-input-target="field">
</div>`;
const warnings = (source: string) =>
  checkSource(source, manifest).filter((diagnostic) => diagnostic.code === "cardinality-violation");

/** Static display counts preserve each controller's ownership and template boundary. */
describe("currency display cardinality", () => {
  it("warns on each extra display with a repair instruction", () => {
    const diagnostics = warnings(scope(display.repeat(3)));
    expect(diagnostics).toHaveLength(2);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.severity).toBe("warning");
      expect(diagnostic.message).toContain('"stimeo--currency-input"');
      expect(diagnostic.message).toContain('"display"');
      expect(diagnostic.message).toContain("found 3");
      expect(diagnostic.suggestion).toContain('one "display"');
      expect(diagnostic.suggestion).toContain("only the first display is read");
    }
    expect(diagnostics.map((diagnostic) => diagnostic.line)).toEqual([4, 6]);
  });

  it("keeps one display clean and a missing display required", () => {
    expect(checkSource(scope(display), manifest)).toEqual([]);
    expect(checkSource(scope(""), manifest)).toContainEqual(
      expect.objectContaining({ code: "missing-required-target", severity: "error" }),
    );
  });

  it("ignores spare displays across unused template contents", () => {
    expect(
      warnings(scope(`${display}<template><section>${display.repeat(2)}</section></template>`)),
    ).toEqual([]);
    expect(warnings(scope(`<template>${display}</template>${display.repeat(2)}`))).toHaveLength(1);
    expect(
      warnings(scope(`${display}<template><template>${display}</template></template>`)),
    ).toEqual([]);
  });

  it("checks a controller declared within a template against its own displays", () => {
    expect(warnings(`<template>${scope(display.repeat(2))}</template>`)).toHaveLength(1);
    expect(warnings(`<template>${scope(display)}</template>`)).toEqual([]);
    expect(
      warnings(scope(`${display}<template>${scope(display.repeat(2))}</template>`)),
    ).toHaveLength(1);
    expect(
      warnings(
        `<template data-controller="stimeo--currency-input">${display.repeat(2)}</template>`,
      ),
    ).toEqual([]);
  });

  it("separates sibling and nested instances while retaining unrelated wrappers", () => {
    expect(warnings(scope(display) + scope(display))).toEqual([]);
    expect(warnings(scope(display + scope(display)))).toEqual([]);
    expect(warnings(scope(display + scope(display.repeat(2))))).toHaveLength(1);
    expect(warnings(scope(display.repeat(2) + scope(display)))).toHaveLength(1);
    expect(
      warnings(scope(`${display}<section data-controller="other">${display}</section>`)),
    ).toHaveLength(1);
  });

  it("does not excuse static duplicates based on visibility, disabled state or intent", () => {
    expect(
      warnings(scope(display + display.replace("<input", "<input hidden disabled"))),
    ).toHaveLength(1);
    const duplicate = scope(display.repeat(2));
    expect(warnings(`<!-- temporary swap -->${duplicate}`)).toEqual(
      warnings(`<!-- permanent swap -->${duplicate}`),
    );
    expect(
      warnings(scope(`<% if alternate %>${display}<% else %>${display}<% end %>`)),
    ).toHaveLength(1);
  });

  it("preserves other controllers' cardinality errors including their template policy", () => {
    const source = `<div data-controller="stimeo--checkbox">
      <input type="checkbox" data-stimeo--checkbox-target="parent">
      <template><input type="checkbox" data-stimeo--checkbox-target="parent"></template>
    </div>`;
    expect(warnings(source)).toEqual([
      expect.objectContaining({ severity: "error", message: expect.stringContaining("checkbox") }),
    ]);
    expect(
      warnings(`<nav data-controller="stimeo--navigation-menu">
        <template><div data-stimeo--navigation-menu-target="hoverArea"></div></template>
      </nav>`),
    ).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("at least 1"),
      }),
    ]);
    expect(
      checkSource(
        `<template><div data-controller="stimeo--currency-input"></div></template>`,
        manifest,
      ),
    ).toContainEqual(
      expect.objectContaining({ code: "missing-required-target", severity: "error" }),
    );
  });

  it("applies an opted-in container boundary without changing lower-bound defaults", () => {
    const currency = manifest.controllers["stimeo--currency-input"];
    if (!currency) throw new Error("Currency controller missing");
    const configured: Manifest = {
      ...manifest,
      controllers: {
        ...manifest.controllers,
        "stimeo--currency-input": {
          ...currency,
          cardinality: [
            {
              within: "srValue",
              target: "display",
              min: 1,
              excludeTemplateContents: true,
              severity: "warning",
              suggestion: "Add a display.",
            },
          ],
        },
      },
    };
    const source = scope(`<section data-stimeo--currency-input-target="srValue"></section>
      <template><section data-stimeo--currency-input-target="srValue"></section></template>`);
    expect(
      checkSource(source, configured).filter(
        (diagnostic) => diagnostic.code === "cardinality-violation",
      ),
    ).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("at least 1"),
      }),
    ]);
  });

  it("publishes the count policy to MCP contracts", () => {
    const contract = runControllerTool(manifest, { id: "stimeo--currency-input" });
    expect(contract.cardinality).toEqual([
      expect.objectContaining({ max: 1, severity: "warning", excludeTemplateContents: true }),
    ]);
    expect(
      TOOL_DESCRIPTORS.find((tool) => tool.name === "stimeo_controller")?.outputSchema,
    ).toMatchObject({
      properties: {
        cardinality: {
          items: {
            properties: {
              severity: { enum: ["error", "warning"] },
              excludeTemplateContents: { type: "boolean" },
            },
          },
        },
      },
    });
  });

  it("returns exit zero for currency warnings and exit one with an existing count error", () => {
    const directory = mkdtempSync(join(tmpdir(), "currency-display-"));
    const file = join(directory, "amount.html");
    try {
      writeFileSync(file, scope(display.repeat(2)));
      const lines: string[] = [];
      expect(
        runCli(
          ["check", file, "--json"],
          (line) => lines.push(line),
          () => manifest,
        ),
      ).toBe(0);
      expect(JSON.parse(lines.join("\n"))).toMatchObject({
        ok: true,
        errorCount: 0,
        warningCount: 1,
      });
      const text: string[] = [];
      expect(
        runCli(
          ["check", file],
          (line) => text.push(line),
          () => manifest,
        ),
      ).toBe(0);
      expect(text.join("\n")).toContain("only the first display is read");
      expect(text.join("\n")).toContain("warning");
      writeFileSync(
        file,
        scope(display.repeat(2)) +
          `<div data-controller="stimeo--checkbox">
        <input type="checkbox" data-stimeo--checkbox-target="parent">
        <input type="checkbox" data-stimeo--checkbox-target="parent"></div>`,
      );
      expect(
        runCli(
          ["check", file, "--json"],
          () => {},
          () => manifest,
        ),
      ).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("propagates a warning without failing CLI reports or MCP", () => {
    const source = scope(display.repeat(2));
    const diagnostics = checkSource(source, manifest);
    const report = buildCheckReport([{ file: "amount.html", diagnostics }], 1);
    expect(report).toMatchObject({ ok: true, errorCount: 0, warningCount: 1 });
    expect(runCheckTool(manifest, { source })).toMatchObject({
      ok: true,
      errorCount: 0,
      warningCount: 1,
    });
    const diagnostic = diagnostics[0];
    if (!diagnostic) throw new Error("Expected a display warning");
    expect(formatGithubAnnotation("amount.html", diagnostic)).toContain("::warning ");
  });
});
