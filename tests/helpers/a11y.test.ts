import { afterEach, describe, expect, it } from "vitest";
import { auditA11y, expectNoA11yViolations } from "./a11y";

/**
 * Self-tests for the layer ① a11y audit helper: it must pass on clean,
 * accessible markup and surface machine-detectable violations on broken markup.
 */
describe("a11y helper", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("passes on accessible markup", async () => {
    document.body.innerHTML = `<button type="button">Save</button>`;
    await expect(expectNoA11yViolations(document.body)).resolves.toBeUndefined();
  });

  it("throws a readable report on a machine-detectable violation", async () => {
    // An <img> without alt text is a canonical axe violation.
    document.body.innerHTML = `<img src="logo.png">`;
    await expect(expectNoA11yViolations(document.body)).rejects.toThrow(
      /machine-detectable a11y violation/i,
    );
  });

  it("auditA11y returns the raw results for inspection", async () => {
    document.body.innerHTML = `<img src="logo.png">`;
    const results = await auditA11y(document.body);
    expect(results.violations.some((violation) => violation.id === "image-alt")).toBe(true);
  });

  it("accepts an HTML string target", async () => {
    const results = await auditA11y(`<button type="button">OK</button>`);
    expect(results.violations).toEqual([]);
  });
});
