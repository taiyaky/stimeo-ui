import { afterEach, describe, expect, it } from "vitest";
import { announce, fillTemplate } from "../../src/utils/announce";

/**
 * Tests for the shared announcement bridge: what reaches the page's announcer, and
 * how a consumer's template is filled.
 */
describe("announce", () => {
  const seen: Array<{ message: string; assertive: boolean }> = [];
  const spy = (event: Event) => {
    seen.push((event as CustomEvent<{ message: string; assertive: boolean }>).detail);
  };
  window.addEventListener("stimeo--announcer:announce", spy);

  afterEach(() => {
    seen.length = 0;
  });

  it("sends the message to the announcer on window", () => {
    announce("Upload complete");
    expect(seen).toEqual([{ message: "Upload complete", assertive: false }]);
  });

  it("carries the assertive flag when asked", () => {
    announce("Connection lost", { assertive: true });
    expect(seen[0]?.assertive).toBe(true);
  });

  it("says nothing when the consumer supplied no wording", () => {
    // The library ships no English strings, so an unset template is opt-out.
    announce("");
    announce("   ");
    expect(seen).toEqual([]);
  });
});

describe("fillTemplate", () => {
  it("fills placeholders from the values", () => {
    expect(fillTemplate("{percent}% of {total}", { percent: 40, total: "100 MB" })).toBe(
      "40% of 100 MB",
    );
  });

  it("leaves an unknown placeholder as authored", () => {
    // A typo stays visible rather than turning into a hole in the sentence.
    expect(fillTemplate("{percent}% — {typo}", { percent: 40 })).toBe("40% — {typo}");
  });
});
