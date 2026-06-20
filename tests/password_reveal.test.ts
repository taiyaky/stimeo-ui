import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { PasswordRevealController } from "../src/controllers/password_reveal_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link PasswordRevealController}: `type` toggling,
 * `aria-pressed` sync, focus/caret preservation, optional auto re-mask, and the
 * `toggle` event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("PasswordRevealController", () => {
  let application: Application;

  const start = async (extraAttrs = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--password-reveal" ${extraAttrs}>
        <input type="password" aria-label="Password" value="s3cret"
               data-stimeo--password-reveal-target="input">
        <button type="button" aria-pressed="false" aria-label="Show password"
                data-stimeo--password-reveal-target="toggle"
                data-action="stimeo--password-reveal#toggle"></button>
      </div>`;
    application = Application.start();
    application.register("stimeo--password-reveal", PasswordRevealController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const input = () => query<HTMLInputElement>("[data-stimeo--password-reveal-target='input']");
  const toggle = () => query<HTMLButtonElement>("[data-stimeo--password-reveal-target='toggle']");
  const controllerEl = () => query("[data-controller='stimeo--password-reveal']");

  it("starts masked", async () => {
    await start();
    expect(input().type).toBe("password");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(controllerEl().getAttribute("data-state")).toBe("hidden");
  });

  it("reveals on toggle and masks again", async () => {
    await start();
    toggle().click();
    expect(input().type).toBe("text");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(controllerEl().getAttribute("data-state")).toBe("visible");

    toggle().click();
    expect(input().type).toBe("password");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(controllerEl().getAttribute("data-state")).toBe("hidden");
  });

  it("restores the input's focus and caret when it was focused", async () => {
    await start();
    input().focus();
    input().setSelectionRange(2, 4);
    toggle().click();
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(2);
    expect(input().selectionEnd).toBe(4);
  });

  it("keeps focus on the toggle button when it (not the input) was focused", async () => {
    await start();
    toggle().focus();
    toggle().click();
    expect(document.activeElement).toBe(toggle());
  });

  it("dispatches a toggle event with the visible state", async () => {
    await start();
    let visible: boolean | null = null;
    controllerEl().addEventListener("stimeo--password-reveal:toggle", (event) => {
      visible = (event as CustomEvent<{ visible: boolean }>).detail.visible;
    });
    toggle().click();
    expect(visible).toBe(true);
  });

  it("auto re-masks after autoHide", async () => {
    await start('data-stimeo--password-reveal-auto-hide-value="20"');
    toggle().click();
    expect(input().type).toBe("text");
    await delay(40);
    expect(input().type).toBe("password");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("has no machine-detectable a11y violations in either state", async () => {
    await start();
    const noRegion = { rules: { region: { enabled: false } } };
    await expectNoA11yViolations(document.body, noRegion);
    toggle().click();
    await expectNoA11yViolations(document.body, noRegion);
  });

  it("announces the toggle button's pressed state and flips it", async () => {
    await start();
    const before = await captureSpeech({ container: toggle(), steps: 0 });
    expect(before).toEqual(["button, Show password, not pressed"]);

    toggle().click();
    const after = await captureSpeech({ container: toggle(), steps: 0 });
    expect(after).toEqual(["button, Show password, pressed"]);
  });

  // Detaching the element drives Stimulus `disconnect()`, where SafeTimeout's
  // clearAll cancels the pending re-mask (`application.stop()` alone would not
  // disconnect the controller).
  it("clears the auto-hide timer on disconnect", async () => {
    await start('data-stimeo--password-reveal-auto-hide-value="20"');
    toggle().click();
    const inputEl = input();
    expect(inputEl.type).toBe("text");

    // Disconnect (as a Turbo navigation would) must cancel the pending auto-hide
    // timer. Drive disconnect() directly rather than via element removal so the
    // assertion doesn't race the async MutationObserver teardown under load.
    const controller = application.getControllerForElementAndIdentifier(
      controllerEl(),
      "stimeo--password-reveal",
    ) as PasswordRevealController;
    expect(controller).toBeTruthy(); // the controller must be obtained, so disconnect() is actually exercised
    controller.disconnect();
    await delay(40);
    // The cancelled timer must not have re-masked the input.
    expect(inputEl.type).toBe("text");
  });
});
