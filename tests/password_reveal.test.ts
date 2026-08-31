import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordRevealController } from "../src/controllers/password_reveal_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { delay, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link PasswordRevealController}: `type` toggling,
 * `aria-pressed` sync, focus/caret preservation, optional auto re-mask, and the
 * `toggle` event.
 */

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
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  /** Must match the controller's clamp on the auto re-mask delay. */
  const MAX_DELAY = 2 ** 31 - 1;

  /** A server-rendered replacement field, in the state the markup declares. */
  const freshField = (type: "password" | "text") => {
    const field = document.createElement("input");
    field.type = type;
    field.value = "s3cret";
    field.setAttribute("aria-label", "Password");
    field.setAttribute("data-stimeo--password-reveal-target", "input");
    return field;
  };

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

  // --- Targets that arrive, leave, or are swapped ---------------------------------

  const swapInput = (type: "password" | "text") => {
    const fresh = document.createElement("input");
    fresh.type = type;
    fresh.value = "s3cret";
    fresh.setAttribute("aria-label", "Password");
    fresh.setAttribute("data-stimeo--password-reveal-target", "input");
    input().replaceWith(fresh);
    return fresh;
  };

  it("re-derives the hooks when a masked field is swapped in", async () => {
    // A server-rendered replacement arrives masked; the hooks have to describe
    // the field that is there, not the one that left.
    await start();
    toggle().click();
    expect(controllerEl().getAttribute("data-state")).toBe("visible");

    swapInput("password");
    await tick();

    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(controllerEl().getAttribute("data-state")).toBe("hidden");
  });

  it("re-derives the pressed state when the button is swapped in", async () => {
    await start();
    toggle().click();

    const fresh = document.createElement("button");
    fresh.type = "button";
    fresh.setAttribute("aria-pressed", "false"); // the server's resting markup
    fresh.setAttribute("aria-label", "Show password");
    fresh.setAttribute("data-stimeo--password-reveal-target", "toggle");
    fresh.setAttribute("data-action", "stimeo--password-reveal#toggle");
    toggle().replaceWith(fresh);
    await tick();

    // The field is still revealed, so the button must say so.
    expect(input().type).toBe("text");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
  });

  it("describes a revealed field swapped in over a masked one", async () => {
    await start();
    // The arrival and the departure land together; whichever order they arrive
    // in, the hooks have to end up describing the field that is actually there.
    input().replaceWith(freshField("text"));
    await tick();

    expect(input().type).toBe("text");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(controllerEl().getAttribute("data-state")).toBe("visible");
  });

  it("adopts a revealed field that arrives where there was none", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--password-reveal"
           data-stimeo--password-reveal-auto-hide-value="20">
        <button type="button" aria-pressed="false" aria-label="Show password"
                data-stimeo--password-reveal-target="toggle"
                data-action="stimeo--password-reveal#toggle"></button>
      </div>`;
    application = Application.start();
    application.register("stimeo--password-reveal", PasswordRevealController);
    await tick();

    // Nothing departs here, so the arrival is the only callback that can run.
    controllerEl().append(freshField("text"));
    await tick();
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(controllerEl().getAttribute("data-state")).toBe("visible");

    await delay(60);
    expect(input().type).toBe("password");
  });

  it("describes a revealed field that arrives after the old one left", async () => {
    await start();
    // The other delivery order: the field is removed first and the replacement
    // is appended afterwards, so the arrival is the only callback left to derive
    // the truth.
    const root = controllerEl();
    input().remove();
    root.append(freshField("text"));
    await tick();

    expect(input().type).toBe("text");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(controllerEl().getAttribute("data-state")).toBe("visible");
  });

  it("re-masks a revealed field swapped in under an autoHide", async () => {
    await start('data-stimeo--password-reveal-auto-hide-value="20"');
    input().replaceWith(freshField("text"));
    await tick();

    // The declaration promises the reveal is temporary; a field that arrives
    // already revealed inherits that promise instead of showing indefinitely.
    await delay(60);
    expect(input().type).toBe("password");
    expect(controllerEl().getAttribute("data-state")).toBe("hidden");
  });

  it("leaves no re-mask running once the controller is gone", async () => {
    await start('data-stimeo--password-reveal-auto-hide-value="20"');
    toggle().click();
    const field = input();
    controllerEl().remove();
    await tick();

    // Target callbacks run after `disconnect()`, and the detached field is still
    // revealed: deriving from it there would re-arm what teardown just cleared.
    await delay(60);
    expect(field.type).toBe("text");
  });

  it("stops claiming a reveal when the field leaves", async () => {
    await start();
    toggle().click();
    input().remove();
    await tick();

    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(controllerEl().getAttribute("data-state")).toBe("hidden");
  });

  it("stays masked after the field leaves with a re-mask pending", async () => {
    await start('data-stimeo--password-reveal-auto-hide-value="20"');
    toggle().click();
    input().remove();
    await tick();

    // The departure derives "masked" and re-arms from it, which clears the
    // pending timer. The clear itself has no separate observable: a re-mask that
    // ran with no field would return before writing anything. What is pinned is
    // the settled description, and the timer outliving teardown is pinned where
    // it does show -- once the controller is gone.
    await delay(40);
    expect(controllerEl().getAttribute("data-state")).toBe("hidden");
  });

  it("does nothing when there is no field to reveal", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--password-reveal">
        <button type="button" aria-pressed="false" aria-label="Show password"
                data-stimeo--password-reveal-target="toggle"
                data-action="stimeo--password-reveal#toggle"></button>
      </div>`;
    application = Application.start();
    application.register("stimeo--password-reveal", PasswordRevealController);
    await tick();

    expect(() => toggle().click()).not.toThrow();
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(controllerEl().getAttribute("data-state")).toBe("hidden");
  });

  // --- Reconnecting onto a revealed field -----------------------------------------

  it("re-arms the auto re-mask when it reconnects onto a revealed field", async () => {
    await start('data-stimeo--password-reveal-auto-hide-value="20"');
    toggle().click();
    expect(input().type).toBe("text");

    const controller = application.getControllerForElementAndIdentifier(
      controllerEl(),
      "stimeo--password-reveal",
    ) as PasswordRevealController;
    controller.disconnect();
    // The field stays revealed across the teardown; reconnecting inherits the
    // promise the declaration made.
    controller.connect();

    await delay(45);
    expect(input().type).toBe("password");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("derives the state from a field that arrives revealed", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--password-reveal">
        <input type="text" aria-label="Password" value="s3cret"
               data-stimeo--password-reveal-target="input">
        <button type="button" aria-pressed="false" aria-label="Show password"
                data-stimeo--password-reveal-target="toggle"
                data-action="stimeo--password-reveal#toggle"></button>
      </div>`;
    application = Application.start();
    application.register("stimeo--password-reveal", PasswordRevealController);
    await tick();

    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(controllerEl().getAttribute("data-state")).toBe("visible");
  });

  // --- The masking direction and the default --------------------------------------

  it("reports the masking direction too", async () => {
    await start();
    const seen: boolean[] = [];
    controllerEl().addEventListener("stimeo--password-reveal:toggle", (event) => {
      seen.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    toggle().click();
    toggle().click();
    expect(seen).toEqual([true, false]);
  });

  it("never re-masks on its own when autoHide is left at its default", async () => {
    await start();
    toggle().click();
    await delay(40);
    expect(input().type).toBe("text");
  });

  // --- Delays setTimeout cannot hold ----------------------------------------------

  it("waits at the clamp for an unbounded delay rather than firing at once", async () => {
    const scheduled = vi.spyOn(window, "setTimeout");
    await start('data-stimeo--password-reveal-auto-hide-value="Infinity"');
    scheduled.mockClear();
    toggle().click();
    // Unbounded is over the limit, not unreadable: it arms at the clamp. Passing
    // it through would fold to zero and turn "keep it showing" into "hide now".
    expect(scheduled.mock.calls.map((call) => call[1])).toEqual([MAX_DELAY]);
    scheduled.mockRestore();

    await delay(40);
    expect(input().type).toBe("text");
  });

  it("schedules nothing at all for a delay it cannot read", async () => {
    const scheduled = vi.spyOn(window, "setTimeout");
    await start('data-stimeo--password-reveal-auto-hide-value="abc"');
    scheduled.mockClear();
    toggle().click();
    // The unreadable side is genuinely inert, not clamped: no timer is created.
    expect(scheduled.mock.calls).toEqual([]);
    scheduled.mockRestore();

    await delay(40);
    expect(input().type).toBe("text");
  });

  it("waits the longest delay it can rather than firing at once", async () => {
    await start('data-stimeo--password-reveal-auto-hide-value="2147483648"');
    toggle().click();
    await delay(40);
    expect(input().type).toBe("text");
  });

  // --- The Turbo snapshot ---------------------------------------------------------

  it("masks the field before the page is cached", async () => {
    // A revealed credential must not be what Turbo copies: returning to the page
    // would put it back on screen with no one asking for it.
    await start();
    toggle().click();
    expect(input().type).toBe("text");

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(input().type).toBe("password");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(controllerEl().getAttribute("data-state")).toBe("hidden");
  });

  it("says nothing when it masks for the cache", async () => {
    // The page is about to be frozen; there is no consumer left to tell.
    await start();
    toggle().click();
    const seen: boolean[] = [];
    controllerEl().addEventListener("stimeo--password-reveal:toggle", (event) => {
      seen.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(seen).toEqual([]);
  });

  it("has nothing to mask for the cache when there is no field", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--password-reveal">
        <button type="button" aria-pressed="false" aria-label="Show password"
                data-stimeo--password-reveal-target="toggle"
                data-action="stimeo--password-reveal#toggle"></button>
      </div>`;
    application = Application.start();
    application.register("stimeo--password-reveal", PasswordRevealController);
    await tick();

    expect(() => document.dispatchEvent(new Event("turbo:before-cache"))).not.toThrow();
    expect(controllerEl().getAttribute("data-state")).toBe("hidden");
  });

  it("stops masking for the cache once it is disconnected", async () => {
    await start();
    toggle().click();
    const controller = application.getControllerForElementAndIdentifier(
      controllerEl(),
      "stimeo--password-reveal",
    ) as PasswordRevealController;
    controller.disconnect();

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(input().type).toBe("text");
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

  // `application.stop()` alone leaves contexts connected; unloading the identifier
  // runs `disconnect()`, where SafeTimeout's clearAll cancels the pending re-mask.
  it("leaves no timer behind when the controller is unloaded", async () => {
    // Stimulus stops the target observer after disconnect(), so the field leaving
    // still reaches inputTargetDisconnected. The element is untouched by an
    // unload, so its own isConnected is no answer to whether this controller is
    // still running: only a timer armed while connected has anything to clear it.
    await start('data-stimeo--password-reveal-auto-hide-value="20"');
    toggle().click();
    expect(input().type).toBe("text");

    const scheduled = vi.spyOn(window, "setTimeout");
    disconnectAndStopApplication(application);
    expect(scheduled).not.toHaveBeenCalled();
    scheduled.mockRestore();
  });

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
