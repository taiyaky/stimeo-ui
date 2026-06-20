import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SwitchController } from "../src/controllers/switch_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link SwitchController}: the APG Switch contract
 * (`aria-checked` toggling and Space/Enter activation), asserted in happy-dom.
 *
 * Keyboard activation is verified on a non-native host (`div role="switch"`)
 * because a real `<button>` synthesizes a click for Space/Enter — the controller
 * deliberately skips its own keydown toggle there to avoid a double toggle.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SwitchController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--switch"
           data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
           role="switch" tabindex="0" aria-checked="false">Notifications</div>`;
    application = Application.start();
    application.register("stimeo--switch", SwitchController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const sw = () => {
    const element = document.querySelector<HTMLElement>("[data-controller='stimeo--switch']");
    if (!element) throw new Error("switch not found");
    return element;
  };

  it("starts unchecked", () => {
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("toggles aria-checked on click", () => {
    sw().click();
    expect(sw().getAttribute("aria-checked")).toBe("true");
    sw().click();
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("toggles on Space and prevents the default scroll", () => {
    const event = new KeyboardEvent("keydown", { key: " ", cancelable: true });
    sw().dispatchEvent(event);
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(event.defaultPrevented).toBe(true);
  });

  it("dispatches a changed event carrying the new state", () => {
    let received: boolean | null = null;
    sw().addEventListener("stimeo--switch:changed", (event) => {
      received = (event as CustomEvent<{ checked: boolean }>).detail.checked;
    });
    sw().click();
    expect(received).toBe(true);
  });

  it("ignores auto-repeat keydowns so a held key toggles only once", () => {
    sw().dispatchEvent(new KeyboardEvent("keydown", { key: " ", repeat: true }));
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("leaves keydown to the browser on a native <button> host (no double toggle)", async () => {
    application.stop();
    document.body.innerHTML = `
      <button data-controller="stimeo--switch"
              data-action="stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
              role="switch" aria-checked="false">Notifications</button>`;
    application = Application.start();
    application.register("stimeo--switch", SwitchController);
    await tick();

    const button = sw();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    // The controller does not toggle on keydown for a <button>; the browser's
    // synthesized click (not fired by dispatchEvent here) would be the only path.
    expect(button.getAttribute("aria-checked")).toBe("false");
  });

  // Layer ① — machine-detectable a11y. Asserted in both states because the only
  // exposed state (aria-checked) flips between them.
  it("has no machine-detectable a11y violations in either state", async () => {
    await expectNoA11yViolations(sw());
    sw().click();
    await expectNoA11yViolations(sw());
  });

  // Layer ③ — speech-order regression: the role/name/state announcement must be
  // stable, and the checked state must flip in the spoken phrase on toggle.
  it("announces role, name, and checked state before and after a toggle", async () => {
    const before = await captureSpeech({ container: sw(), steps: 0 });
    expect(before).toEqual(["switch, Notifications, not checked"]);

    sw().click();
    const after = await captureSpeech({ container: sw(), steps: 0 });
    expect(after).toEqual(["switch, Notifications, checked"]);
  });

  // Disconnect-teardown regression. The controller registers no timers, observers,
  // or document/window listeners (only Stimulus-managed data-action bindings), so
  // teardown means: after application.stop() the element is inert — a click no
  // longer toggles and no changed event escapes.
  it("becomes inert after disconnect (no lingering side effects)", () => {
    sw().click();
    expect(sw().getAttribute("aria-checked")).toBe("true");

    application.stop();
    let escaped = false;
    sw().addEventListener("stimeo--switch:changed", () => {
      escaped = true;
    });
    sw().click();
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(escaped).toBe(false);
  });
});
