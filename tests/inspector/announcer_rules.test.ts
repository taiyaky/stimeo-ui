import { describe, expect, it } from "vitest";
import {
  ANNOUNCER_IDENTIFIER,
  ANNOUNCING_CONTROLLERS,
  announcerSeatingDiagnostic,
} from "../../src/inspector/announcer_rules";

/**
 * The announcer-seating hint is decided over a whole run rather than one file,
 * so these cover the run-level outcomes: any seat anywhere silences it, a page
 * that speaks with no seat anywhere raises it once, and markup that speaks
 * through no controller never raises it.
 */
describe("announcerSeatingDiagnostic", () => {
  const speaking = `<div data-controller="stimeo--progress"></div>`;
  const seat = `<div data-controller="${ANNOUNCER_IDENTIFIER}"></div>`;

  it("reports the first speaking file when nothing in the run seats an announcer", () => {
    const result = announcerSeatingDiagnostic([
      { file: "a.html", source: "<p>nothing here</p>" },
      { file: "b.html", source: speaking },
      { file: "c.html", source: speaking },
    ]);

    expect(result?.file).toBe("b.html");
    expect(result?.diagnostic.code).toBe("missing-announcer");
    expect(result?.diagnostic.severity).toBe("warning");
    expect(result?.diagnostic.message).toContain("stimeo--progress");
    expect(result?.diagnostic.suggestion).toContain(ANNOUNCER_IDENTIFIER);
  });

  it("stays silent when any other file in the run seats one", () => {
    expect(
      announcerSeatingDiagnostic([
        { file: "page.html", source: speaking },
        { file: "layout.html", source: seat },
      ]),
    ).toBeNull();
  });

  it("stays silent when the same file both speaks and seats", () => {
    expect(
      announcerSeatingDiagnostic([{ file: "page.html", source: `${speaking}${seat}` }]),
    ).toBeNull();
  });

  it("stays silent when no scanned controller speaks", () => {
    expect(
      announcerSeatingDiagnostic([
        { file: "page.html", source: `<div data-controller="stimeo--tabs"></div>` },
      ]),
    ).toBeNull();
  });

  it("anchors the diagnostic at the identifier it found", () => {
    const source = `<main>\n  <p>copy</p>\n  <div data-controller="stimeo--spinner"></div>\n</main>`;
    const result = announcerSeatingDiagnostic([{ file: "page.html", source }]);

    expect(result?.diagnostic.line).toBe(3);
    expect(source.split("\n")[2]?.slice((result?.diagnostic.column ?? 1) - 1)).toMatch(
      /^stimeo--spinner/,
    );
    expect(result?.diagnostic.length).toBe("stimeo--spinner".length);
  });

  it("reports the earliest identifier in a file that mentions several", () => {
    const source = `<div data-controller="stimeo--meter"></div>\n<div data-controller="stimeo--progress"></div>`;
    expect(
      announcerSeatingDiagnostic([{ file: "page.html", source }])?.diagnostic.message,
    ).toContain("stimeo--meter");
  });

  it("declares only namespaced Core identifiers", () => {
    expect(ANNOUNCING_CONTROLLERS.length).toBeGreaterThan(0);
    for (const identifier of ANNOUNCING_CONTROLLERS) {
      expect(identifier).toMatch(/^stimeo--[a-z][a-z-]*$/);
    }
    expect(new Set(ANNOUNCING_CONTROLLERS).size).toBe(ANNOUNCING_CONTROLLERS.length);
  });
});
