import { afterEach, describe, expect, it } from "vitest";
import { type ActionSource, actionSource } from "../../src/utils/action_source";

/** Normalization retains the event binding, origin and modality without claiming a target. */
describe("actionSource", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses an explicit element for both source elements and reports api", () => {
    const element = document.createElement("button");
    expect(actionSource(element)).toEqual({
      event: null,
      host: element,
      origin: element,
      reason: "api",
    });
  });

  it("keeps an absent source distinct from an unbound DOM event", () => {
    expect(actionSource()).toEqual({ event: null, host: null, origin: null, reason: "api" });
    const event = new Event("click");
    expect(actionSource(event)).toEqual({ event, host: null, origin: null, reason: "user" });
  });

  it("preserves the binding host, SVG descendant origin and original claimed event", () => {
    const host = document.createElement("button");
    host.innerHTML = "<svg><path /></svg>";
    document.body.append(host);
    const origin = host.querySelector("path");
    if (!origin) throw new Error("Missing SVG origin");
    let observed: ActionSource | undefined;
    host.addEventListener("click", (event) => {
      event.preventDefault();
      observed = actionSource(event);
    });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    origin.dispatchEvent(event);
    expect(observed).toEqual({ event, host, origin, reason: "user" });
    expect(observed?.event?.defaultPrevented).toBe(true);
  });

  it("does not reinterpret a non-element target as its binding host", () => {
    const host = document.createElement("div");
    const text = document.createTextNode("Label");
    host.append(text);
    let observed: ActionSource | undefined;
    host.addEventListener("click", (event) => {
      observed = actionSource(event);
    });
    const event = new Event("click", { bubbles: true });
    text.dispatchEvent(event);
    expect(observed).toEqual({ event, host, origin: null, reason: "user" });
  });

  it("does not treat document and window event targets as elements", () => {
    let observed: ActionSource | undefined;
    document.addEventListener(
      "source-test",
      (event) => {
        observed = actionSource(event);
      },
      { once: true },
    );
    const event = new Event("source-test");
    document.dispatchEvent(event);
    expect(observed).toEqual({ event, host: null, origin: null, reason: "user" });
  });

  it.each([
    ["focusin", "focus"],
    ["pointerenter", "pointer"],
    ["keydown", "user"],
  ] as const)("retains the %s public modality", (type, reason) => {
    expect(actionSource(new Event(type)).reason).toBe(reason);
  });
});
