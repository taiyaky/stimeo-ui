import { describe, expect, it } from "vitest";
import { ClickVerdicts } from "../../src/utils/click_verdicts";

/**
 * Tests for {@link ClickVerdicts}: the verdict recorded for one event is read back for
 * any of the entries recorded with it, and for nothing else — another entry, another
 * event, or no event at all reads `undefined`, which tells the caller to judge now.
 */
describe("ClickVerdicts", () => {
  const entries = () => {
    const outer = document.createElement("div");
    const inner = document.createElement("button");
    const other = document.createElement("button");
    outer.append(inner);
    return { outer, inner, other };
  };
  const click = () => new MouseEvent("click", { bubbles: true, cancelable: true });

  it.each([true, false])("reads back a %s verdict for each recorded entry", (refused) => {
    const verdicts = new ClickVerdicts();
    const { outer, inner } = entries();
    const event = click();

    verdicts.record(event, [outer, inner], refused);

    expect(verdicts.for(event, outer)).toBe(refused);
    expect(verdicts.for(event, inner)).toBe(refused);
  });

  it("reads undefined for an entry the event was not recorded with", () => {
    const verdicts = new ClickVerdicts();
    const { outer, inner, other } = entries();
    const event = click();

    verdicts.record(event, [outer, inner], true);

    expect(verdicts.for(event, other)).toBeUndefined();
  });

  it("reads undefined for an event that was never recorded", () => {
    const verdicts = new ClickVerdicts();
    const { outer } = entries();
    const recorded = click();
    verdicts.record(recorded, [outer], false);

    expect(verdicts.for(click(), outer)).toBeUndefined();
    expect(verdicts.for(new Event("probe"), outer)).toBeUndefined();
  });

  it("reads undefined with no event", () => {
    const verdicts = new ClickVerdicts();
    const { outer } = entries();
    verdicts.record(click(), [outer], true);

    expect(verdicts.for(null, outer)).toBeUndefined();
    expect(verdicts.for(undefined, outer)).toBeUndefined();
  });

  it("reads undefined for every entry of an event recorded with none", () => {
    const verdicts = new ClickVerdicts();
    const { outer } = entries();
    const event = click();

    verdicts.record(event, [], true);

    expect(verdicts.for(event, outer)).toBeUndefined();
  });

  it("keeps the verdicts of separate events apart", () => {
    const verdicts = new ClickVerdicts();
    const { outer, inner } = entries();
    const first = click();
    const second = click();

    verdicts.record(first, [outer, inner], true);
    verdicts.record(second, [outer], false);

    expect(verdicts.for(first, outer)).toBe(true);
    expect(verdicts.for(first, inner)).toBe(true);
    expect(verdicts.for(second, outer)).toBe(false);
    expect(verdicts.for(second, inner)).toBeUndefined();
  });

  it("keeps the verdicts of separate instances apart", () => {
    const one = new ClickVerdicts();
    const two = new ClickVerdicts();
    const { outer } = entries();
    const event = click();

    one.record(event, [outer], true);

    expect(two.for(event, outer)).toBeUndefined();
  });

  it("answers with the latest record of an event", () => {
    const verdicts = new ClickVerdicts();
    const { outer, inner } = entries();
    const event = click();

    verdicts.record(event, [outer], true);
    verdicts.record(event, [inner], false);

    expect(verdicts.for(event, outer)).toBeUndefined();
    expect(verdicts.for(event, inner)).toBe(false);
  });
});
