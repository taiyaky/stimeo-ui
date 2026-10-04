import { describe, expect, it } from "vitest";
import { MoveCounter } from "../../src/utils/move_counter";

/** Reports remain current until another state transition is recorded. */
describe("MoveCounter", () => {
  it("keeps a recorded transition current across repeated checks", () => {
    const counter = new MoveCounter();
    const token = counter.record();

    expect(counter.isLatest(token)).toBe(true);
    expect(counter.isLatest(token)).toBe(true);
  });

  it("retires every earlier transition when another is recorded", () => {
    const counter = new MoveCounter();
    const first = counter.record();
    const second = counter.record();
    const latest = counter.record();

    expect(counter.isLatest(first)).toBe(false);
    expect(counter.isLatest(second)).toBe(false);
    expect(counter.isLatest(latest)).toBe(true);
  });

  it("keeps independent owners current while another owner moves", () => {
    const first = new MoveCounter();
    const second = new MoveCounter();
    const token = first.record();

    second.record();
    second.record();

    expect(first.isLatest(token)).toBe(true);
  });
});
