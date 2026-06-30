import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipController } from "../src/controllers/tooltip_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link TooltipController}: hover/focus show-hide with
 * show/hide delays, the hoverable bridge (content keeps it open), document-level
 * Escape dismissal, and timer/listener teardown on disconnect. Delays are driven
 * by a mocked clock.
 */
describe("TooltipController", () => {
  let application: Application;

  const start = async (values = "") => {
    document.body.innerHTML = `
      <main>
        <span data-controller="stimeo--tooltip" ${values}>
          <button data-stimeo--tooltip-target="trigger" aria-describedby="tip"
                  data-action="mouseenter->stimeo--tooltip#show
                               mouseleave->stimeo--tooltip#hide
                               focusin->stimeo--tooltip#show
                               focusout->stimeo--tooltip#hide
                               keydown->stimeo--tooltip#onKeydown">Save</button>
          <span id="tip" role="tooltip" data-stimeo--tooltip-target="content"
                data-action="mouseenter->stimeo--tooltip#show
                             mouseleave->stimeo--tooltip#hide" hidden>Saves to disk</span>
        </span>
      </main>`;
    application = Application.start();
    application.register("stimeo--tooltip", TooltipController);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    await start();
  });

  afterEach(() => {
    application.stop();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const trigger = () => query<HTMLButtonElement>("[data-stimeo--tooltip-target='trigger']");
  const content = () => query("#tip");
  const fire = (el: Element, type: string) =>
    el.dispatchEvent(new MouseEvent(type, { bubbles: true }));

  it("starts hidden with data-state closed", () => {
    expect(content().hidden).toBe(true);
    expect(content().getAttribute("data-state")).toBe("closed");
  });

  it("shows on mouseenter and hides on mouseleave", () => {
    fire(trigger(), "mouseenter");
    expect(content().hidden).toBe(false);
    expect(content().getAttribute("data-state")).toBe("open");
    fire(trigger(), "mouseleave");
    expect(content().hidden).toBe(true);
  });

  it("shows on focusin and hides on focusout", () => {
    trigger().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(content().hidden).toBe(false);
    trigger().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(content().hidden).toBe(true);
  });

  it("respects showDelay before revealing", async () => {
    application.stop();
    await start('data-stimeo--tooltip-show-delay-value="200"');
    fire(trigger(), "mouseenter");
    expect(content().hidden).toBe(true);
    vi.advanceTimersByTime(199);
    expect(content().hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(content().hidden).toBe(false);
  });

  it("respects hideDelay and keeps it open via the hoverable bridge", async () => {
    application.stop();
    await start('data-stimeo--tooltip-hide-delay-value="200"');
    fire(trigger(), "mouseenter");
    expect(content().hidden).toBe(false);
    // Pointer leaves the trigger → hide is scheduled…
    fire(trigger(), "mouseleave");
    vi.advanceTimersByTime(100);
    // …but crossing into the tooltip cancels it (hoverable).
    fire(content(), "mouseenter");
    vi.advanceTimersByTime(300);
    expect(content().hidden).toBe(false);
  });

  it("dismisses on Escape at the document level even when focus is elsewhere", () => {
    fire(trigger(), "mouseenter");
    expect(content().hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(content().hidden).toBe(true);
  });

  it("preserves the aria-describedby reference while toggling", () => {
    expect(trigger().getAttribute("aria-describedby")).toBe("tip");
    fire(trigger(), "mouseenter");
    fire(trigger(), "mouseleave");
    expect(trigger().getAttribute("aria-describedby")).toBe("tip");
  });

  it("does not dismiss on scroll unless closeOnScroll is set", () => {
    fire(trigger(), "mouseenter");
    expect(content().hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(content().hidden).toBe(false);
  });

  it("dismisses on scroll when closeOnScroll is set", async () => {
    application.stop();
    await start('data-stimeo--tooltip-close-on-scroll-value="true"');
    fire(trigger(), "mouseenter");
    expect(content().hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(content().hidden).toBe(true);
    expect(content().getAttribute("data-state")).toBe("closed");
  });

  it("clears timers and the Escape listener on disconnect", async () => {
    application.stop();
    await start('data-stimeo--tooltip-show-delay-value="200"');
    fire(trigger(), "mouseenter");
    const instance = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--tooltip']"),
      "stimeo--tooltip",
    ) as TooltipController;
    instance.disconnect();
    vi.advanceTimersByTime(500);
    // The pending show must not fire against the disconnected controller.
    expect(content().hidden).toBe(true);
  });
});

describe("TooltipController accessibility", () => {
  let application: Application;

  const startReal = async () => {
    document.body.innerHTML = `
      <main>
        <span data-controller="stimeo--tooltip">
          <button data-stimeo--tooltip-target="trigger" aria-describedby="tip3"
                  data-action="mouseenter->stimeo--tooltip#show">Save</button>
          <span id="tip3" role="tooltip" data-stimeo--tooltip-target="content"
                hidden>Saves your changes to disk</span>
        </span>
      </main>`;
    application = Application.start();
    application.register("stimeo--tooltip", TooltipController);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("has no machine-detectable a11y violations when shown", async () => {
    await startReal();
    query<HTMLButtonElement>("[data-stimeo--tooltip-target='trigger']").dispatchEvent(
      new MouseEvent("mouseenter", { bubbles: true }),
    );
    await expectNoA11yViolations(document.body);
  });

  it("announces the trigger described by the tooltip", async () => {
    await startReal();
    query<HTMLButtonElement>("[data-stimeo--tooltip-target='trigger']").dispatchEvent(
      new MouseEvent("mouseenter", { bubbles: true }),
    );
    const spoken = await captureSpeech({ container: query("main"), steps: 1 });
    // Freeze the whole ordered array (not a name-only `toContain`): the tooltip's
    // text rides along as the trigger's accessible description.
    expect(spoken).toEqual(["main", "button, Save, Saves your changes to disk"]);
  });
});
