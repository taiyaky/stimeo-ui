import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordRevealController } from "../src/controllers/password_reveal_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { byId, query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
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

  it("gives focus and the caret back when flipping the type takes them away", async () => {
    await start();
    const field = input();
    // An engine may drop focus and reset the caret when an input's type flips;
    // this field behaves like one that does. A write of the `type` attribute stands
    // for the flip; in happy-dom the `type` property setter writes it that way too.
    const setAttribute = field.setAttribute.bind(field);
    field.setAttribute = (name: string, value: string): void => {
      setAttribute(name, value);
      if (name !== "type") return;
      field.blur();
      field.setSelectionRange(field.value.length, field.value.length);
    };
    field.focus();
    field.setSelectionRange(2, 4);

    toggle().click();

    expect(field.type).toBe("text");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(2);
    expect(field.selectionEnd).toBe(4);
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

  it("describes the state to a button that arrives where there was none", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--password-reveal">
        <input type="text" aria-label="Password" value="s3cret"
               data-stimeo--password-reveal-target="input">
      </div>`;
    application = Application.start();
    application.register("stimeo--password-reveal", PasswordRevealController);
    await tick();

    // Nothing departs here, so the arrival is the only callback that can describe it.
    const late = document.createElement("button");
    late.type = "button";
    late.setAttribute("aria-pressed", "false");
    late.setAttribute("aria-label", "Show password");
    late.setAttribute("data-stimeo--password-reveal-target", "toggle");
    controllerEl().append(late);
    await tick();

    expect(late.getAttribute("aria-pressed")).toBe("true");
  });

  it("describes the state to a button that stays after an earlier one leaves", async () => {
    await start();
    toggle().click();
    const original = toggle();
    const successor = original.cloneNode(true) as HTMLButtonElement;
    successor.setAttribute("aria-pressed", "false");
    original.after(successor);
    await tick();
    original.remove();
    await tick();

    expect(toggle()).toBe(successor);
    expect(successor.getAttribute("aria-pressed")).toBe("true");
  });

  it("says nothing when it describes the state to a button left behind", async () => {
    await start();
    toggle().click();
    const events = captureStateEvents("stimeo--password-reveal", ["toggle", "change", "reconcile"]);
    const native: Event[] = [];
    document.addEventListener("change", (event) => native.push(event));
    const original = toggle();
    const successor = original.cloneNode(true) as HTMLButtonElement;
    successor.setAttribute("aria-pressed", "false");
    original.after(successor);
    await tick();
    original.remove();
    await tick();

    expect(successor.getAttribute("aria-pressed")).toBe("true");
    expect(events.names()).toEqual([]);
    expect(native).toEqual([]);
    events.stop();
  });

  it("keeps describing the field when its only button leaves", async () => {
    await start();
    toggle().click();
    const leaving = toggle();
    leaving.remove();
    await tick();
    const controller = application.getControllerForElementAndIdentifier(
      controllerEl(),
      "stimeo--password-reveal",
    ) as PasswordRevealController;

    expect(() => controller.toggleTargetDisconnected(leaving)).not.toThrow();
    expect(controllerEl().getAttribute("data-state")).toBe("visible");
  });

  it("writes nothing to the button from a departure delivered after disconnect", async () => {
    await start();
    toggle().click();
    const controller = application.getControllerForElementAndIdentifier(
      controllerEl(),
      "stimeo--password-reveal",
    ) as PasswordRevealController;
    controller.disconnect();
    // The page rewrites the button once the controller is gone; the departure
    // Stimulus delivers after `disconnect()` must leave that alone.
    toggle().setAttribute("aria-pressed", "false");
    controllerEl().setAttribute("data-state", "hidden");

    controller.toggleTargetDisconnected(toggle());

    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(controllerEl().getAttribute("data-state")).toBe("hidden");
  });

  it("gives the authored pressed state back to a button that stops being the toggle", async () => {
    await start();
    toggle().click();
    const former = toggle();
    // The element stays; only the attribute naming it the toggle goes.
    former.removeAttribute("data-stimeo--password-reveal-target");
    await tick();

    expect(former.getAttribute("aria-pressed")).toBe("false");
    expect(controllerEl().getAttribute("data-state")).toBe("visible");
  });

  it("removes a pressed state it wrote on a button that authored none, once it stops being the toggle", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--password-reveal">
        <input type="text" aria-label="Password" value="s3cret"
               data-stimeo--password-reveal-target="input">
        <button type="button" aria-label="Show password"
                data-stimeo--password-reveal-target="toggle"></button>
      </div>`;
    application = Application.start();
    application.register("stimeo--password-reveal", PasswordRevealController);
    await tick();
    const former = toggle();
    expect(former.getAttribute("aria-pressed")).toBe("true");

    former.removeAttribute("data-stimeo--password-reveal-target");
    await tick();

    expect(former.hasAttribute("aria-pressed")).toBe(false);
  });

  it("keeps a pressed state the page wrote on a button that stops being the toggle", async () => {
    await start();
    toggle().click();
    const former = toggle();
    former.setAttribute("aria-pressed", "mixed");
    former.removeAttribute("data-stimeo--password-reveal-target");
    await tick();

    expect(former.getAttribute("aria-pressed")).toBe("mixed");
  });

  it("gives the button back its own pressed state when the widget loses its controller", async () => {
    await start();
    toggle().click();
    const departed = toggle();

    controllerEl().removeAttribute("data-controller");
    await tick();

    expect(departed.getAttribute("aria-pressed")).toBe("false");
  });

  it("masks a revealed field again once it stops being the input", async () => {
    await start();
    toggle().click();
    const former = input();
    expect(former.type).toBe("text");

    // The element stays; only the attribute naming it the input goes.
    former.removeAttribute("data-stimeo--password-reveal-target");
    await tick();

    expect(former.type).toBe("password");
  });

  it("masks a revealed field again when the widget loses its controller", async () => {
    await start();
    toggle().click();
    const departed = input();

    controllerEl().removeAttribute("data-controller");
    await tick();

    expect(departed.type).toBe("password");
  });

  it("keeps a revealed field revealed when it moves within the widget", async () => {
    await start();
    toggle().click();
    const moving = input();

    controllerEl().append(moving);
    await tick();

    expect(moving.type).toBe("text");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
  });

  it("leaves a field it never revealed as served once it stops being the input", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--password-reveal">
        <input type="text" aria-label="Password" value="s3cret"
               data-stimeo--password-reveal-target="input">
        <button type="button" aria-pressed="false" aria-label="Show password"
                data-stimeo--password-reveal-target="toggle"></button>
      </div>`;
    application = Application.start();
    application.register("stimeo--password-reveal", PasswordRevealController);
    await tick();
    const former = input();

    former.removeAttribute("data-stimeo--password-reveal-target");
    await tick();

    expect(former.type).toBe("text");
  });

  it("keeps a type the page wrote on a field that stops being the input", async () => {
    await start();
    toggle().click();
    const former = input();
    former.type = "search";

    former.removeAttribute("data-stimeo--password-reveal-target");
    await tick();

    expect(former.type).toBe("search");
  });

  it("keeps the revealed hooks when the whole widget leaves the page", async () => {
    // Stimulus delivers the field's departure after `disconnect()`; the field is
    // still revealed, so nothing may describe it as masked from there.
    await start();
    toggle().click();
    const root = controllerEl();
    const kept = toggle();

    root.remove();
    await tick();

    expect(kept.getAttribute("aria-pressed")).toBe("true");
    expect(root.getAttribute("data-state")).toBe("visible");
  });

  it("writes nothing to the hooks from a field departure delivered after disconnect", async () => {
    await start();
    toggle().click();
    const controller = application.getControllerForElementAndIdentifier(
      controllerEl(),
      "stimeo--password-reveal",
    ) as PasswordRevealController;
    controller.disconnect();
    // The page rewrites the hooks once the controller is gone; the departure
    // Stimulus delivers after `disconnect()` must leave that alone.
    toggle().setAttribute("aria-pressed", "mixed");
    controllerEl().setAttribute("data-state", "page");

    controller.inputTargetDisconnected(input());

    expect(toggle().getAttribute("aria-pressed")).toBe("mixed");
    expect(controllerEl().getAttribute("data-state")).toBe("page");
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

  it("re-masks a revealed field that is left behind when another leaves", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--password-reveal"
           data-stimeo--password-reveal-auto-hide-value="20">
        <input id="first" type="password" aria-label="Password" value="s3cret"
               data-stimeo--password-reveal-target="input">
        <input id="second" type="text" aria-label="Password again" value="s3cret"
               data-stimeo--password-reveal-target="input">
        <button type="button" aria-pressed="false" aria-label="Show password"
                data-stimeo--password-reveal-target="toggle"
                data-action="stimeo--password-reveal#toggle"></button>
      </div>`;
    application = Application.start();
    application.register("stimeo--password-reveal", PasswordRevealController);
    await tick();

    byId("first").remove();
    await tick();
    const second = query<HTMLInputElement>("#second");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");

    // The field left behind is revealed, so it inherits the re-mask the
    // declaration promises.
    await delay(60);
    expect(second.type).toBe("password");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
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

  it("derives the state from a revealed field that follows its button in the markup", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--password-reveal">
        <button type="button" aria-pressed="false" aria-label="Show password"
                data-stimeo--password-reveal-target="toggle"
                data-action="stimeo--password-reveal#toggle"></button>
        <input type="text" aria-label="Password" value="s3cret"
               data-stimeo--password-reveal-target="input">
      </div>`;
    application = Application.start();
    application.register("stimeo--password-reveal", PasswordRevealController);
    await tick();

    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(controllerEl().getAttribute("data-state")).toBe("visible");
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

  // --- `autoHide` belongs to one reveal ---------------------------------------------

  /**
   * Rewrites `autoHide` and delivers its Value callback directly when the controller
   * defines one, since happy-dom does not reliably run it for an attribute write.
   */
  const declareAutoHide = (value: number) => {
    controllerEl().setAttribute("data-stimeo--password-reveal-auto-hide-value", String(value));
    const owner = application.getControllerForElementAndIdentifier(
      controllerEl(),
      "stimeo--password-reveal",
    );
    const callback: unknown = Reflect.get(owner ?? {}, "autoHideValueChanged");
    if (typeof callback === "function") callback.call(owner);
  };

  it.each([
    { direction: "shrinks", next: 20 },
    { direction: "grows", next: 5000 },
  ])(
    "keeps a reveal's re-mask deadline when autoHide $direction, and times the next reveal anew",
    async ({ next }) => {
      await start('data-stimeo--password-reveal-auto-hide-value="200"');
      vi.useFakeTimers();
      try {
        toggle().click();
        vi.advanceTimersByTime(50);

        declareAutoHide(next);
        vi.advanceTimersByTime(149);
        expect(input().type).toBe("text");
        vi.advanceTimersByTime(1);
        expect(input().type).toBe("password");

        toggle().click();
        vi.advanceTimersByTime(next - 1);
        expect(input().type).toBe("text");
        vi.advanceTimersByTime(1);
        expect(input().type).toBe("password");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("times a reveal that follows a manual mask from that reveal", async () => {
    await start('data-stimeo--password-reveal-auto-hide-value="100"');
    const toggles: boolean[] = [];
    controllerEl().addEventListener("stimeo--password-reveal:toggle", (event) =>
      toggles.push((event as CustomEvent<{ visible: boolean }>).detail.visible),
    );
    vi.useFakeTimers();
    try {
      toggle().click();
      vi.advanceTimersByTime(50);
      toggle().click(); // masked by hand before the re-mask was due
      toggle().click();

      vi.advanceTimersByTime(99);
      expect(input().type).toBe("text");
      expect(toggles).toEqual([true, false, true]);
      vi.advanceTimersByTime(1);
      expect(input().type).toBe("password");
      expect(toggles).toEqual([true, false, true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms nothing and reports nothing from an autoHide change alone", async () => {
    await start();
    const toggles: boolean[] = [];
    controllerEl().addEventListener("stimeo--password-reveal:toggle", (event) =>
      toggles.push((event as CustomEvent<{ visible: boolean }>).detail.visible),
    );
    vi.useFakeTimers();
    try {
      toggle().click(); // revealed with no re-mask promised
      declareAutoHide(20);
      vi.advanceTimersByTime(1000);
      expect(input().type).toBe("text");
      expect(toggle().getAttribute("aria-pressed")).toBe("true");
      expect(toggles).toEqual([true]);

      toggle().click(); // masked: a change while masked arms nothing either
      declareAutoHide(30);
      vi.advanceTimersByTime(1000);
      expect(input().type).toBe("password");
      expect(toggles).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps what the user typed when it masks for the cache on a page that stays", async () => {
    // Turbo also dispatches the event on a page that stays (a promoted frame
    // navigation, a popstate without Turbo state, a refresh of a cached URL).
    await start();
    input().value = "typed secret";
    toggle().click();

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(input().type).toBe("password");
    expect(input().value).toBe("typed secret");
  });

  describe("a copy of the page Turbo restores", () => {
    const restore = async (): Promise<void> => {
      application = await restoreFromCache(application, (restored) =>
        restored.register("stimeo--password-reveal", PasswordRevealController),
      );
    };

    it("masks a field the copy carries revealed and empties it, as Turbo empties a password field", async () => {
      await start();
      toggle().click();
      expect(input().type).toBe("text");
      const seen: boolean[] = [];
      document.addEventListener("stimeo--password-reveal:toggle", (event) => {
        seen.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
      });

      await restore();

      expect(input().type).toBe("password");
      expect(input().value).toBe("");
      expect(toggle().getAttribute("aria-pressed")).toBe("false");
      expect(controllerEl().getAttribute("data-state")).toBe("hidden");
      expect(seen).toEqual([]);
    });

    it("masks and empties the revealed fields of the page Turbo is about to render, before it connects", async () => {
      await start();
      input().value = "hunter2";
      toggle().click();
      const incoming = document.body.cloneNode(true) as HTMLElement;
      const author = document.createElement("input");
      author.type = "text";
      author.value = "plain";
      incoming.append(author);

      document.dispatchEvent(
        new CustomEvent("turbo:before-render", { detail: { newBody: incoming } }),
      );

      const copied = incoming.querySelector<HTMLInputElement>(
        "[data-stimeo--password-reveal-target='input']",
      ) as HTMLInputElement;
      expect(copied.type).toBe("password");
      expect(copied.value).toBe("");
      expect(copied.getAttributeNames().filter((name) => name.endsWith("-lease"))).toEqual([]);
      expect(author.value).toBe("plain");
      // The live page is not touched.
      expect(input().type).toBe("text");
      expect(input().value).toBe("hunter2");
    });

    it("masks the page Turbo renders once no instance is connected, and passes over a render without a body", async () => {
      // A copy can come back while the page being left holds no reveal toggle: Turbo
      // renders every visit into the same document, so the mask stays with the document.
      await start();
      input().value = "hunter2";
      toggle().click();
      const incoming = document.body.cloneNode(true) as HTMLElement;
      application.unload("stimeo--password-reveal");
      document.body.innerHTML = "<p>A page without a reveal toggle</p>";

      expect(() =>
        document.dispatchEvent(new CustomEvent("turbo:before-render", { detail: {} })),
      ).not.toThrow();
      document.dispatchEvent(
        new CustomEvent("turbo:before-render", { detail: { newBody: incoming } }),
      );

      const copied = incoming.querySelector<HTMLInputElement>(
        "[data-stimeo--password-reveal-target='input']",
      ) as HTMLInputElement;
      expect(copied.type).toBe("password");
      expect(copied.value).toBe("");
    });

    it("masks the copies of a toggle registered under another identifier as well", async () => {
      document.body.innerHTML = `
        <div data-controller="other--reveal">
          <input type="password" aria-label="Password" value="hunter2"
                 data-other--reveal-target="input">
          <button type="button" aria-pressed="false" aria-label="Show password"
                  data-other--reveal-target="toggle"
                  data-action="other--reveal#toggle"></button>
        </div>`;
      application = Application.start();
      application.register("other--reveal", PasswordRevealController);
      await tick();
      query<HTMLButtonElement>("[data-other--reveal-target='toggle']").click();
      const incoming = document.body.cloneNode(true) as HTMLElement;
      application.unload("other--reveal");

      document.dispatchEvent(
        new CustomEvent("turbo:before-render", { detail: { newBody: incoming } }),
      );

      const copied = incoming.querySelector<HTMLInputElement>(
        "[data-other--reveal-target='input']",
      ) as HTMLInputElement;
      expect(copied.type).toBe("password");
      expect(copied.value).toBe("");
    });

    it("watches the pages Turbo renders into a document with one listener, however many instances connect", async () => {
      const add = vi.spyOn(document, "addEventListener");
      try {
        document.body.innerHTML = `
          ${[1, 2]
            .map(
              (n) => `
          <div data-controller="stimeo--password-reveal">
            <input type="password" aria-label="Password ${n}"
                   data-stimeo--password-reveal-target="input">
          </div>`,
            )
            .join("")}`;
        application = Application.start();
        application.register("stimeo--password-reveal", PasswordRevealController);
        await tick();
        const [first] = application.controllers as PasswordRevealController[];
        first?.disconnect();
        first?.connect();

        const renders = add.mock.calls.filter(([type]) => type === "turbo:before-render");
        // None when an earlier test of this file already installed it for this document.
        expect(renders.length).toBeLessThanOrEqual(1);
      } finally {
        add.mockRestore();
      }
    });

    it("shares the render mask between separate copies of the controller", async () => {
      const identifier = "test--reveal-copies";
      const add = vi.spyOn(document, "addEventListener");
      try {
        document.body.innerHTML = `
          <div data-controller="${identifier}">
            <input type="password" aria-label="Password"
                   data-${identifier}-target="input">
          </div>`;
        application = Application.start();
        application.register(identifier, PasswordRevealController);
        await tick();
        const renders = () =>
          add.mock.calls.filter(([type]) => type === "turbo:before-render").length;
        expect(renders()).toBe(1);

        application.unload(identifier);
        vi.resetModules();
        const { PasswordRevealController: OtherCopy } = await import(
          "../src/controllers/password_reveal_controller"
        );
        expect(OtherCopy).not.toBe(PasswordRevealController);
        application.register(identifier, OtherCopy);
        await tick();
        expect(renders()).toBe(1);

        const incoming = document.createElement("div");
        incoming.innerHTML = `
          <input type="text" value="secret"
                 data-${identifier}-type-lease='["password","text"]'>`;
        document.dispatchEvent(
          new CustomEvent("turbo:before-render", { detail: { newBody: incoming } }),
        );
        const field = incoming.querySelector("input");
        expect(field?.type).toBe("password");
        expect(field?.value).toBe("");
      } finally {
        add.mockRestore();
      }
    });

    it("leaves a field the author wrote as text, which the copy carries masked, as it comes", async () => {
      document.body.innerHTML = `
        <div data-controller="stimeo--password-reveal">
          <input type="text" aria-label="Password" value="shown"
                 data-stimeo--password-reveal-target="input">
          <button type="button" aria-pressed="true" aria-label="Show password"
                  data-stimeo--password-reveal-target="toggle"
                  data-action="stimeo--password-reveal#toggle"></button>
        </div>`;
      application = Application.start();
      application.register("stimeo--password-reveal", PasswordRevealController);
      await tick();
      toggle().click();
      expect(input().type).toBe("password");
      const incoming = document.body.cloneNode(true) as HTMLElement;

      document.dispatchEvent(
        new CustomEvent("turbo:before-render", { detail: { newBody: incoming } }),
      );

      const copied = incoming.querySelector<HTMLInputElement>(
        "[data-stimeo--password-reveal-target='input']",
      ) as HTMLInputElement;
      expect(copied.type).toBe("password");
      expect(copied.value).toBe("shown");
    });

    it("keeps a field the author wrote revealed", async () => {
      document.body.innerHTML = `
        <div data-controller="stimeo--password-reveal">
          <input type="text" aria-label="Password" value="shown"
                 data-stimeo--password-reveal-target="input">
          <button type="button" aria-pressed="true" aria-label="Show password"
                  data-stimeo--password-reveal-target="toggle"
                  data-action="stimeo--password-reveal#toggle"></button>
        </div>`;
      application = Application.start();
      application.register("stimeo--password-reveal", PasswordRevealController);
      await tick();

      await restore();

      expect(input().type).toBe("text");
      expect(input().value).toBe("shown");
    });
  });

  it("keeps a revealed field revealed when its element moves within the page", async () => {
    await start();
    toggle().click();
    const controller = application.getControllerForElementAndIdentifier(
      controllerEl(),
      "stimeo--password-reveal",
    ) as PasswordRevealController;

    controller.disconnect();
    controller.connect();

    expect(input().type).toBe("text");
    expect(input().value).toBe("s3cret");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
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

  it("leaves no re-mask behind once it has masked for the cache", async () => {
    await start('data-stimeo--password-reveal-auto-hide-value="20"');
    vi.useFakeTimers();
    try {
      toggle().click();
      const seen: boolean[] = [];
      controllerEl().addEventListener("stimeo--password-reveal:toggle", (event) => {
        seen.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
      });

      document.dispatchEvent(new Event("turbo:before-cache"));
      vi.advanceTimersByTime(40);

      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
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

  // --- The label pair inside the toggle -------------------------------------------

  /** Mounts the button contents an author wrote, around a field in the given state. */
  const startWithLabels = async (
    buttonContents: string,
    fieldType: "password" | "text" = "password",
  ) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--password-reveal">
        <input type="${fieldType}" aria-label="Password" value="s3cret"
               data-stimeo--password-reveal-target="input">
        <button type="button" aria-pressed="false" aria-label="Show password"
                data-stimeo--password-reveal-target="toggle"
                data-action="stimeo--password-reveal#toggle">${buttonContents}</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--password-reveal", PasswordRevealController);
    await tick();
  };

  /** A pair spelled the way a resting, masked field would be served. */
  const LABEL_PAIR = `
    <span data-stimeo--password-reveal-target="onLabel" hidden>Hide password</span>
    <span data-stimeo--password-reveal-target="offLabel">Show password</span>`;

  const onLabel = (root: ParentNode = document) =>
    query("[data-stimeo--password-reveal-target='onLabel']", root);
  const offLabel = (root: ParentNode = document) =>
    query("[data-stimeo--password-reveal-target='offLabel']", root);

  it("swaps the label pair as the field is revealed and masked again", async () => {
    // Which half shows is a pure function of the revealed state: the pressed half
    // is on screen exactly while the field is.
    await startWithLabels(LABEL_PAIR);
    expect(onLabel().hidden).toBe(true);
    expect(offLabel().hidden).toBe(false);

    toggle().click();
    expect(onLabel().hidden).toBe(false);
    expect(offLabel().hidden).toBe(true);

    toggle().click();
    expect(onLabel().hidden).toBe(true);
    expect(offLabel().hidden).toBe(false);
  });

  it("gives the authored label pair back to a button that stops being the toggle", async () => {
    await startWithLabels(LABEL_PAIR);
    toggle().click();
    const former = toggle();
    expect([onLabel(former).hidden, offLabel(former).hidden]).toEqual([false, true]);

    former.removeAttribute("data-stimeo--password-reveal-target");
    await tick();

    expect([onLabel(former).hidden, offLabel(former).hidden]).toEqual([true, false]);
  });

  it("gives back a label pair authored against the state once its button stops being the toggle", async () => {
    // The connection corrects the pair, so what it hands back is what the author wrote.
    await startWithLabels(`
      <span data-stimeo--password-reveal-target="onLabel">Hide password</span>
      <span data-stimeo--password-reveal-target="offLabel" hidden>Show password</span>`);
    const former = toggle();
    expect([onLabel(former).hidden, offLabel(former).hidden]).toEqual([true, false]);

    former.removeAttribute("data-stimeo--password-reveal-target");
    await tick();

    expect([onLabel(former).hidden, offLabel(former).hidden]).toEqual([false, true]);
  });

  it("keeps a label state the page wrote on a button that stops being the toggle", async () => {
    await startWithLabels(LABEL_PAIR);
    toggle().click();
    const former = toggle();
    onLabel(former).setAttribute("hidden", "until-found");
    former.removeAttribute("data-stimeo--password-reveal-target");
    await tick();

    expect(onLabel(former).getAttribute("hidden")).toBe("until-found");
    expect(offLabel(former).hidden).toBe(false);
  });

  it("gives the button back its own label pair when the widget loses its controller", async () => {
    await startWithLabels(LABEL_PAIR);
    toggle().click();
    const departed = toggle();

    controllerEl().removeAttribute("data-controller");
    await tick();

    expect(departed.getAttribute("aria-pressed")).toBe("false");
    expect([onLabel(departed).hidden, offLabel(departed).hidden]).toEqual([true, false]);
  });

  it("gives back a label half that left the pair before its button stopped being the toggle", async () => {
    await startWithLabels(LABEL_PAIR);
    toggle().click();
    const former = toggle();
    const half = onLabel(former);

    half.removeAttribute("data-stimeo--password-reveal-target");
    former.removeAttribute("data-stimeo--password-reveal-target");
    await tick();

    expect(half.hidden).toBe(true);
    expect(offLabel(former).hidden).toBe(false);
  });

  it("keeps what it wrote on a button that moves within the widget", async () => {
    // A move delivers the departure and the arrival of the same element, which is
    // still the toggle throughout, so nothing is handed back and written again.
    await startWithLabels(LABEL_PAIR);
    toggle().click();
    const moving = toggle();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(moving, {
      attributes: true,
      subtree: true,
      attributeFilter: ["aria-pressed", "hidden"],
    });

    controllerEl().prepend(moving);
    await tick();
    records.push(...observer.takeRecords());
    observer.disconnect();

    expect(moving.getAttribute("aria-pressed")).toBe("true");
    expect([onLabel(moving).hidden, offLabel(moving).hidden]).toEqual([false, true]);
    expect(records.map((record) => record.attributeName)).toEqual([]);
  });

  it("corrects a label pair authored against the state it mounts onto", async () => {
    // The authored `hidden` is not read back: the first reflection settles which
    // half shows, so a restored DOM cannot leave a label contradicting the field.
    await startWithLabels(`
      <span data-stimeo--password-reveal-target="onLabel">Hide password</span>
      <span data-stimeo--password-reveal-target="offLabel" hidden>Show password</span>`);

    expect(input().type).toBe("password");
    expect(onLabel().hidden).toBe(true);
    expect(offLabel().hidden).toBe(false);
  });

  it("hides the resting half of a pair mounted over a revealed field", async () => {
    // Neither half carries an authored `hidden`; the connection still leaves only
    // the half the state owns on screen, and says nothing while it does. The
    // capture has to predate the mount, so it listens on the document and is
    // detached here rather than dying with the element.
    const capture = captureStateEvents("stimeo--password-reveal", ["toggle"]);
    try {
      await startWithLabels(
        `
      <span data-stimeo--password-reveal-target="onLabel">Hide password</span>
      <span data-stimeo--password-reveal-target="offLabel">Show password</span>`,
        "text",
      );

      expect(onLabel().hidden).toBe(false);
      expect(offLabel().hidden).toBe(true);
      expect(capture.names()).toEqual([]);
    } finally {
      capture.stop();
    }
  });

  it("leaves a lone label half as the author wrote it", async () => {
    // A half whose counterpart is missing inside the same button is not a pair:
    // hiding it would take the button's only visible label with it. The pair next
    // to it still moves, so the silence belongs to the lone half alone.
    document.body.innerHTML = `
      <div data-controller="stimeo--password-reveal" id="lone">
        <input type="password" aria-label="Password" value="s3cret"
               data-stimeo--password-reveal-target="input">
        <button type="button" aria-pressed="false" aria-label="Show password"
                data-stimeo--password-reveal-target="toggle"
                data-action="stimeo--password-reveal#toggle">
          <span data-stimeo--password-reveal-target="onLabel">Reveal</span>
        </button>
      </div>
      <div data-controller="stimeo--password-reveal" id="paired">
        <input type="password" aria-label="Confirm password" value="s3cret"
               data-stimeo--password-reveal-target="input">
        <button type="button" aria-pressed="false" aria-label="Show password"
                data-stimeo--password-reveal-target="toggle"
                data-action="stimeo--password-reveal#toggle">${LABEL_PAIR}</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--password-reveal", PasswordRevealController);
    await tick();

    const lone = byId("lone");
    const paired = byId("paired");
    const toggleIn = (root: ParentNode) =>
      query<HTMLButtonElement>("[data-stimeo--password-reveal-target='toggle']", root);

    expect(onLabel(lone).hidden).toBe(false);
    expect(onLabel(paired).hidden).toBe(true);
    expect(offLabel(paired).hidden).toBe(false);

    toggleIn(lone).click();
    toggleIn(paired).click();

    expect(onLabel(lone).hidden).toBe(false);
    expect(onLabel(paired).hidden).toBe(false);
    expect(offLabel(paired).hidden).toBe(true);
  });

  it("syncs a label pair that arrives after connect", async () => {
    // A button re-rendered with its labels joins a field that is already revealed,
    // so the halves describe the state they find rather than the resting markup.
    await startWithLabels("");
    toggle().click();
    expect(toggle().getAttribute("aria-pressed")).toBe("true");

    const label = (name: "onLabel" | "offLabel", text: string) => {
      const span = document.createElement("span");
      span.textContent = text;
      span.setAttribute("data-stimeo--password-reveal-target", name);
      return span;
    };
    toggle().append(label("onLabel", "Hide password"), label("offLabel", "Show password"));
    await tick();

    expect(onLabel().hidden).toBe(false);
    expect(offLabel().hidden).toBe(true);
  });

  /** A label half created the way a re-rendered button fragment would carry it. */
  const labelHalf = (name: "onLabel" | "offLabel", text: string) => {
    const span = document.createElement("span");
    span.textContent = text;
    span.setAttribute("data-stimeo--password-reveal-target", name);
    return span;
  };

  it("completes a pair when the revealed-side half arrives after connect", async () => {
    await startWithLabels(
      `<span data-stimeo--password-reveal-target="offLabel">Show password</span>`,
      "text",
    );
    // A lone half keeps what the author wrote.
    expect(offLabel().hidden).toBe(false);

    toggle().append(labelHalf("onLabel", "Hide password"));
    await tick();

    expect(onLabel().hidden).toBe(false);
    expect(offLabel().hidden).toBe(true);
  });

  it("completes a pair when the masked-side half arrives after connect", async () => {
    await startWithLabels(
      `<span data-stimeo--password-reveal-target="onLabel">Hide password</span>`,
    );
    expect(onLabel().hidden).toBe(false);

    toggle().append(labelHalf("offLabel", "Show password"));
    await tick();

    expect(onLabel().hidden).toBe(true);
    expect(offLabel().hidden).toBe(false);
  });

  it("returns the label pair to masked before the page is cached", async () => {
    // The snapshot carries a masked field, so the button frozen with it must not
    // offer to hide what is already hidden.
    await startWithLabels(LABEL_PAIR);
    toggle().click();
    expect(onLabel().hidden).toBe(false);

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(onLabel().hidden).toBe(true);
    expect(offLabel().hidden).toBe(false);
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
