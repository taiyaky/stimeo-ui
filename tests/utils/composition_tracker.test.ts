import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositionTracker } from "../../src/utils/composition_tracker";

describe("CompositionTracker", () => {
  let tracker: CompositionTracker | null = null;

  afterEach(() => {
    tracker?.disconnect();
    tracker = null;
    document.body.innerHTML = "";
  });

  it("combines lifecycle state with the standard per-event signal", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    expect(tracker.isComposing()).toBe(false);
    expect(tracker.isComposing(new KeyboardEvent("keydown", { isComposing: true }))).toBe(true);

    input.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(tracker.isComposing()).toBe(true);
    expect(tracker.isComposing(new KeyboardEvent("keydown"))).toBe(true);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    expect(tracker.isComposing()).toBe(false);
  });

  it("clears lifecycle state before running component-specific end work", () => {
    const input = document.createElement("input");
    const states: boolean[] = [];
    tracker = new CompositionTracker({
      onStart: () => states.push(tracker?.isComposing() ?? false),
      onEnd: () => states.push(tracker?.isComposing() ?? true),
    });
    tracker.observe(input);

    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.dispatchEvent(new CompositionEvent("compositionend"));

    expect(states).toEqual([true, false]);
  });

  it("observes idempotently and unobserves without leaving active state", () => {
    const input = document.createElement("input");
    const onEnd = vi.fn();
    tracker = new CompositionTracker({ onEnd });
    tracker.observe(input);
    tracker.observe(input);

    input.dispatchEvent(new CompositionEvent("compositionstart"));
    tracker.unobserve(input);
    expect(tracker.isComposing()).toBe(false);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("tracks multiple targets and disconnect removes all listeners", () => {
    const first = document.createElement("input");
    const second = document.createElement("input");
    const onEnd = vi.fn();
    tracker = new CompositionTracker({ onEnd });
    tracker.observe(first);
    tracker.observe(second);

    first.dispatchEvent(new CompositionEvent("compositionstart"));
    second.dispatchEvent(new CompositionEvent("compositionstart"));
    first.dispatchEvent(new CompositionEvent("compositionend"));
    expect(tracker.isComposing()).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);

    tracker.disconnect();
    expect(tracker.isComposing()).toBe(false);
    second.dispatchEvent(new CompositionEvent("compositionend"));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
