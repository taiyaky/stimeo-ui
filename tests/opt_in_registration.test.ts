import type { Application } from "@hotwired/stimulus";
import { describe, expect, it, vi } from "vitest";
import { cableControllers, registerCable } from "../src/cable";
import { positioningControllers, registerPositioning } from "../src/positioning";

/** Tests for the registration helpers of the opt-in `cable` and `positioning` entries. */
describe("opt-in registration", () => {
  it.each([
    ["registerCable", registerCable, cableControllers],
    ["registerPositioning", registerPositioning, positioningControllers],
  ] as const)("%s registers every controller of its entry", (_name, register, controllers) => {
    const application = { register: vi.fn() };

    register(application as unknown as Application);

    expect(application.register.mock.calls).toEqual(Object.entries(controllers));
  });
});
