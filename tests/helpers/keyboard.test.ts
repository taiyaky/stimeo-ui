import { afterEach, describe, expect, it } from "vitest";
import { keyEvent, press, typeKey } from "./keyboard";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("keyboard helpers", () => {
  it("focuses before the listener runs and exposes cancellation", () => {
    const button = document.createElement("button");
    document.body.append(button);
    let focused: Element | null = null;
    button.addEventListener("keydown", (event) => {
      focused = document.activeElement;
      event.preventDefault();
    });
    const event = press(button, "ArrowDown", { altKey: true });
    expect(focused).toBe(button);
    expect(event.key).toBe("ArrowDown");
    expect(event.altKey).toBe(true);
    expect(event.bubbles).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("rejects a detached target instead of dispatching without focus", () => {
    const button = document.createElement("button");
    let received = false;
    button.addEventListener("keydown", () => {
      received = true;
    });
    expect(() => press(button, "Enter")).toThrow("focus");
    expect(received).toBe(false);
  });

  it("rejects a connected disabled target without dispatching keydown", () => {
    const button = document.createElement("button");
    button.disabled = true;
    document.body.append(button);
    let received = false;
    button.addEventListener("keydown", () => {
      received = true;
    });
    expect(button.isConnected).toBe(true);
    expect(() => press(button, "Enter")).toThrow("focus");
    expect(document.activeElement).not.toBe(button);
    expect(received).toBe(false);
  });

  it("checks focus within a shadow root", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    shadow.append(button);
    press(button, "Enter");
    expect(shadow.activeElement).toBe(button);
    expect(document.activeElement).toBe(host);
  });

  it("dispatches an unfocused event without changing the active element", () => {
    const focused = document.createElement("button");
    const target = document.createElement("button");
    document.body.append(focused, target);
    focused.focus();
    const event = typeKey(target, "Escape");
    expect(document.activeElement).toBe(focused);
    expect(event.target).toBe(target);
    expect(event.cancelable).toBe(true);
  });

  it("preserves an event claimed before dispatch", () => {
    const button = document.createElement("button");
    document.body.append(button);
    const claimed = keyEvent("Escape", { isComposing: true });
    claimed.preventDefault();
    expect(press(button, claimed)).toBe(claimed);
    expect(claimed.defaultPrevented).toBe(true);
    expect(claimed.isComposing).toBe(true);
  });

  it("creates undispatched key events and supports keyup", () => {
    const event = keyEvent("Shift", { shiftKey: true }, "keyup");
    expect(event.type).toBe("keyup");
    expect(event.key).toBe("Shift");
    expect(event.shiftKey).toBe(true);
    expect(event.target).toBeNull();
    expect(event.cancelable).toBe(true);
  });

  it("keeps explicit init overrides and creates a fresh event for each key", () => {
    const first = keyEvent("Enter", {
      key: "Escape",
      bubbles: false,
      cancelable: false,
      repeat: true,
      code: "Escape",
    });
    first.preventDefault();
    expect(first.key).toBe("Escape");
    expect(first.code).toBe("Escape");
    expect(first.repeat).toBe(true);
    expect(first.bubbles).toBe(false);
    expect(first.defaultPrevented).toBe(false);
    const second = keyEvent("Enter");
    expect(second).not.toBe(first);
    expect(second.key).toBe("Enter");
    expect(second.bubbles).toBe(true);
    expect(second.cancelable).toBe(true);
  });
});
