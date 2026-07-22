import { afterEach, describe, expect, it, vi } from "vitest";
import { claimsWhileFocusWithin, EscapeLayer } from "../../src/utils/escape_layer";

/**
 * Behavioral tests for the shared Escape resolver: activation ordering, the
 * claims-based owner resolution, the single document listener's dispatch
 * contract (defaultPrevented / isComposing / one dismissal per press), and
 * per-document isolation and cleanup.
 */
describe("EscapeLayer", () => {
  const layers: EscapeLayer[] = [];

  afterEach(() => {
    for (const layer of layers) layer.deactivate();
    layers.length = 0;
  });

  const layer = (options: { onDismiss?: () => void; claims?: () => boolean } = {}) => {
    const instance = new EscapeLayer();
    layers.push(instance);
    const onDismiss = options.onDismiss ?? (() => {});
    return {
      instance,
      activate: (ownerDocument: Document = document) =>
        instance.activate(ownerDocument, { onDismiss, claims: options.claims }),
    };
  };

  /** Dispatches a cancelable Escape keydown on `target`, like a real keypress. */
  const pressEscape = (
    target: EventTarget = document,
    init: KeyboardEventInit = {},
  ): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  };

  it("gives ownership to the most recently activated layer", () => {
    const outer = layer();
    const inner = layer();

    outer.activate();
    inner.activate();

    expect(outer.instance.ownsEscape).toBe(false);
    expect(inner.instance.ownsEscape).toBe(true);
  });

  it("restores ownership to the previous layer when the top layer deactivates", () => {
    const outer = layer();
    const inner = layer();
    outer.activate();
    inner.activate();

    inner.instance.deactivate();

    expect(inner.instance.ownsEscape).toBe(false);
    expect(outer.instance.ownsEscape).toBe(true);
  });

  it("dismisses only the owning layer on a press and consumes the event", () => {
    const outerDismiss = vi.fn();
    const innerDismiss = vi.fn();
    const outer = layer({ onDismiss: outerDismiss });
    const inner = layer({ onDismiss: innerDismiss });
    outer.activate();
    inner.activate();

    const event = pressEscape();

    expect(event.defaultPrevented).toBe(true);
    expect(innerDismiss).toHaveBeenCalledTimes(1);
    expect(outerDismiss).not.toHaveBeenCalled();
  });

  it("leaves a press that an inner handler already consumed", () => {
    const dismiss = vi.fn();
    const top = layer({ onDismiss: dismiss });
    top.activate();

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    document.dispatchEvent(event);

    expect(dismiss).not.toHaveBeenCalled();
  });

  it("leaves a press that cancels an IME composition", () => {
    const dismiss = vi.fn();
    const top = layer({ onDismiss: dismiss });
    top.activate();

    const event = pressEscape(document, { isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("stops consuming presses once every layer deactivated", () => {
    const dismiss = vi.fn();
    const only = layer({ onDismiss: dismiss });
    only.activate();
    only.instance.deactivate();

    const event = pressEscape();

    expect(event.defaultPrevented).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("moves a reactivated layer back to the top without duplicating it", () => {
    const first = layer();
    const second = layer();
    first.activate();
    second.activate();

    first.activate();
    // The reactivation must actually reorder the stack: a no-op implementation
    // would leave `second` on top and slip past the assertions below.
    expect(first.instance.ownsEscape).toBe(true);
    expect(second.instance.ownsEscape).toBe(false);

    first.instance.deactivate();
    expect(first.instance.ownsEscape).toBe(false);
    expect(second.instance.ownsEscape).toBe(true);
  });

  it("does not leave a duplicate behind when the top layer is reactivated", () => {
    const bottom = layer();
    const top = layer();
    bottom.activate();
    top.activate();

    top.activate();
    top.instance.deactivate();

    expect(top.instance.ownsEscape).toBe(false);
    // A duplicate-push implementation would leave a ghost copy of `top` above
    // `bottom`, permanently blocking ownership for every layer below it.
    expect(bottom.instance.ownsEscape).toBe(true);
  });

  it("removes a layer when it is deactivated out of order", () => {
    const first = layer();
    const middle = layer();
    const top = layer();
    first.activate();
    middle.activate();
    top.activate();

    // Non-LIFO removal (e.g. a hover layer concealed while a modal sits above):
    // the top layer keeps ownership, and the removed layer is skipped later.
    middle.instance.deactivate();
    expect(top.instance.ownsEscape).toBe(true);
    expect(middle.instance.ownsEscape).toBe(false);

    top.instance.deactivate();
    expect(first.instance.ownsEscape).toBe(true);
  });

  it("skips a declining layer so the next one down owns the press", () => {
    const belowDismiss = vi.fn();
    let claims = false;
    const below = layer({ onDismiss: belowDismiss });
    const above = layer({ claims: () => claims });
    below.activate();
    above.activate();

    // The top layer declines (e.g. a background overlay without focus), so it
    // must be transparent instead of blocking the layer underneath.
    expect(above.instance.ownsEscape).toBe(false);
    expect(below.instance.ownsEscape).toBe(true);
    pressEscape();
    expect(belowDismiss).toHaveBeenCalledTimes(1);

    // The predicate is consulted live: once it claims, ownership moves up.
    claims = true;
    expect(above.instance.ownsEscape).toBe(true);
    expect(below.instance.ownsEscape).toBe(false);
  });

  it("owns nothing when every active layer declines", () => {
    const dismiss = vi.fn();
    const only = layer({ onDismiss: dismiss, claims: () => false });
    only.activate();

    expect(only.instance.ownsEscape).toBe(false);
    const event = pressEscape();
    expect(event.defaultPrevented).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("keeps ownership isolated between documents", () => {
    const otherDocument = document.implementation.createHTMLDocument("other");
    const currentDismiss = vi.fn();
    const otherDismiss = vi.fn();
    const current = layer({ onDismiss: currentDismiss });
    const other = layer({ onDismiss: otherDismiss });

    current.activate(document);
    other.activate(otherDocument);

    expect(current.instance.ownsEscape).toBe(true);
    expect(other.instance.ownsEscape).toBe(true);

    // A press in one document must resolve against that document's stack only.
    pressEscape(otherDocument);
    expect(otherDismiss).toHaveBeenCalledTimes(1);
    expect(currentDismiss).not.toHaveBeenCalled();
  });

  describe("claimsWhileFocusWithin", () => {
    afterEach(() => {
      document.body.innerHTML = "";
    });

    it("claims while focus is inside the element or fell to the body", () => {
      document.body.innerHTML = `
        <div id="overlay"><button id="inside">In</button></div>
        <button id="outside">Out</button>`;
      const overlay = document.getElementById("overlay");
      if (!overlay) throw new Error("missing fixture");
      const claims = claimsWhileFocusWithin(overlay);

      document.getElementById("inside")?.focus();
      expect(claims()).toBe(true);

      // A click on non-focusable overlay content blurs to <body>.
      (document.activeElement as HTMLElement | null)?.blur();
      expect(claims()).toBe(true);

      document.getElementById("outside")?.focus();
      expect(claims()).toBe(false);
    });
  });
});
