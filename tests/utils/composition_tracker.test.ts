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

  /** Dispatches the `input` an engine sends, with the kind it reports (if any). */
  const sendInput = (target: EventTarget, inputType?: string): InputEvent => {
    const event = new InputEvent("input", { bubbles: true, ...(inputType ? { inputType } : {}) });
    target.dispatchEvent(event);
    return event;
  };

  it("folds the confirming input once, and only from the field that confirmed", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(true);
    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);
  });

  it("closes the window on an input from another field", () => {
    const first = document.createElement("input");
    const second = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(first);
    tracker.observe(second);

    first.dispatchEvent(new CompositionEvent("compositionend"));
    expect(tracker.consumesConfirmedInput(sendInput(second))).toBe(false);
    expect(tracker.consumesConfirmedInput(sendInput(first))).toBe(false);
  });

  it("closes the window on a key and on a new composition", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);
  });

  it("folds an input the engine reports as part of the composition", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    for (const inputType of ["insertCompositionText", "insertFromComposition"]) {
      input.dispatchEvent(new CompositionEvent("compositionend"));
      expect(tracker.consumesConfirmedInput(sendInput(input, inputType))).toBe(true);
    }
  });

  it("passes an edit through even when it lands right after a confirmation", () => {
    // Dictation, autofill and a drop all arrive without a key, so the window
    // alone cannot tell them from an echo; the kind the engine reports can.
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    for (const inputType of ["insertText", "insertFromPaste", "insertFromDrop"]) {
      input.dispatchEvent(new CompositionEvent("compositionend"));
      expect(tracker.consumesConfirmedInput(sendInput(input, inputType))).toBe(false);
      expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);
    }
  });

  it("drops the pending window when the field leaves or the tracker stops", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    tracker.unobserve(input);
    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);

    tracker.observe(input);
    input.dispatchEvent(new CompositionEvent("compositionend"));
    tracker.disconnect();
    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);
  });

  it("stops listening for keys on a field it no longer observes", () => {
    const first = document.createElement("input");
    const second = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(first);
    tracker.observe(second);

    first.dispatchEvent(new CompositionEvent("compositionend"));
    tracker.unobserve(second);
    second.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));

    expect(tracker.consumesConfirmedInput(sendInput(first))).toBe(true);
  });

  it("marks the field that confirmed, not the ancestor being observed", () => {
    document.body.innerHTML = `<form><input id="one"><input id="two"></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    const one = document.getElementById("one") as HTMLInputElement;
    const two = document.getElementById("two") as HTMLInputElement;
    tracker = new CompositionTracker();
    tracker.observe(form);

    one.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(tracker.consumesConfirmedInput(sendInput(two))).toBe(false);

    one.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(tracker.consumesConfirmedInput(sendInput(one))).toBe(true);
  });
});
