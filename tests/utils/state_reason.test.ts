import { describe, expect, expectTypeOf, it } from "vitest";
import type { StateReason as PublicStateReason } from "../../src/index";
import { type StateReason, stateReasonFor } from "../../src/utils/state_reason";

/**
 * Behavioral tests for {@link stateReasonFor}: that a call with no event is
 * `"api"`, that the two modality families are recognised by event type, and
 * that every other event an action can receive falls to `"user"`.
 */
describe("stateReasonFor", () => {
  it("reports a call with no event as api", () => {
    expect(stateReasonFor()).toBe("api");
  });

  it("reports an explicitly absent event as api", () => {
    expect(stateReasonFor(null)).toBe("api");
  });

  it.each(["blur", "focus", "focusin", "focusout"])("reports %s as focus", (type) => {
    expect(stateReasonFor(new Event(type))).toBe("focus");
  });

  it.each(["mouseenter", "mouseleave", "pointerenter", "pointerleave"])(
    "reports %s as pointer",
    (type) => {
      expect(stateReasonFor(new Event(type))).toBe("pointer");
    },
  );

  it.each(["click", "keydown", "contextmenu", "pointerdown", "submit"])(
    "reports %s as user",
    (type) => {
      expect(stateReasonFor(new Event(type))).toBe("user");
    },
  );

  it("resolves by event type, not constructor, so one MouseEvent class yields pointer or user", () => {
    const event = new MouseEvent("mouseleave");

    expect(stateReasonFor(event)).toBe("pointer");
    expect(stateReasonFor(new MouseEvent("click"))).toBe("user");
  });

  it("is the reason type the package entry point exports", () => {
    expectTypeOf<PublicStateReason>().toEqualTypeOf<StateReason>();
  });
});
