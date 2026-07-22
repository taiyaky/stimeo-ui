import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipController } from "../src/controllers/tooltip_controller";
import { EscapeLayer } from "../src/utils/escape_layer";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link TooltipController}: hover/focus show-hide with
 * show/hide delays, the hoverable bridge (content keeps it open), document-level
 * Escape dismissal, and timer/listener teardown on disconnect. Delays are driven
 * by a mocked clock.
 */
describe("TooltipController", () => {
  let application: Application;

  const boot = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--tooltip", TooltipController);
    await vi.advanceTimersByTimeAsync(0);
  };

  const start = async (values = "") =>
    boot(`
      <main>
        <span data-controller="stimeo--tooltip" ${values}>
          <button data-stimeo--tooltip-target="trigger" aria-describedby="tip"
                  data-action="mouseenter->stimeo--tooltip#show
                               mouseleave->stimeo--tooltip#hide
                               focusin->stimeo--tooltip#show
                               focusout->stimeo--tooltip#hide">Save</button>
          <span id="tip" role="tooltip" data-stimeo--tooltip-target="content"
                data-action="mouseenter->stimeo--tooltip#show
                             mouseleave->stimeo--tooltip#hide" hidden>Saves to disk</span>
        </span>
      </main>`);

  beforeEach(async () => {
    vi.useFakeTimers();
    await start();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const trigger = () => query<HTMLButtonElement>("[data-stimeo--tooltip-target='trigger']");
  const content = () => query("#tip");
  const root = () => query<HTMLElement>("[data-controller='stimeo--tooltip']");
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--tooltip",
    ) as TooltipController;
  const fire = (el: Element, type: string) =>
    el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  const focus = (el: Element, type: "focusin" | "focusout") =>
    el.dispatchEvent(new FocusEvent(type, { bubbles: true }));

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
    focus(trigger(), "focusin");
    expect(content().hidden).toBe(false);
    focus(trigger(), "focusout");
    expect(content().hidden).toBe(true);
  });

  it("respects showDelay before revealing", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-show-delay-value="200"');
    fire(trigger(), "mouseenter");
    expect(content().hidden).toBe(true);
    vi.advanceTimersByTime(199);
    expect(content().hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(content().hidden).toBe(false);
  });

  it("cancels a pending show when every interaction ends before showDelay", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-show-delay-value="200"');
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(100);
    fire(trigger(), "mouseleave");
    vi.advanceTimersByTime(200);
    expect(content().hidden).toBe(true);
  });

  it("respects hideDelay and keeps it open via the hoverable bridge", async () => {
    disconnectAndStopApplication(application);
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

  it("hides after hideDelay when no interaction remains", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-hide-delay-value="200"');
    fire(trigger(), "mouseenter");
    fire(trigger(), "mouseleave");
    vi.advanceTimersByTime(199);
    expect(content().hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(content().hidden).toBe(true);
  });

  it("stays open when pointer leaves while focus remains", () => {
    focus(trigger(), "focusin");
    fire(trigger(), "mouseenter");
    fire(trigger(), "mouseleave");
    expect(content().hidden).toBe(false);
    focus(trigger(), "focusout");
    expect(content().hidden).toBe(true);
  });

  it("stays open when focus leaves while the pointer remains", () => {
    fire(trigger(), "mouseenter");
    focus(trigger(), "focusin");
    focus(trigger(), "focusout");
    expect(content().hidden).toBe(false);
    fire(trigger(), "mouseleave");
    expect(content().hidden).toBe(true);
  });

  it("dismisses on Escape at the document level even when focus is elsewhere", () => {
    fire(trigger(), "mouseenter");
    expect(content().hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(content().hidden).toBe(true);
  });

  it("dismisses on Escape pressed on the trigger, consuming the press", () => {
    fire(trigger(), "mouseenter");
    trigger().focus();
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    trigger().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(content().hidden).toBe(true);
  });

  it("yields the press to a newer document layer even with focus on the trigger", () => {
    fire(trigger(), "mouseenter");
    trigger().focus();

    // A layer shown after this tooltip owns the press: the shared resolver
    // dismisses the newest layer, never the stale tooltip under focus.
    let aboveDismissed = 0;
    const above = new EscapeLayer();
    above.activate(document, { onDismiss: () => aboveDismissed++ });
    const first = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    trigger().dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(aboveDismissed).toBe(1);
    expect(content().hidden).toBe(false);

    above.deactivate();
    const second = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    trigger().dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);
    expect(content().hidden).toBe(true);
  });

  it("ignores an Escape already handled by an inner layer", () => {
    fire(trigger(), "mouseenter");
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    // The layered-Escape contract: a consumed press dismisses at most one layer.
    expect(content().hidden).toBe(false);

    const handledOnTrigger = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handledOnTrigger.preventDefault();
    trigger().dispatchEvent(handledOnTrigger);
    expect(content().hidden).toBe(false);
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
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-close-on-scroll-value="true"');
    fire(trigger(), "mouseenter");
    expect(content().hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(content().hidden).toBe(true);
    expect(content().getAttribute("data-state")).toBe("closed");
  });

  it("clears a pending show timer on disconnect", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-show-delay-value="200"');
    fire(trigger(), "mouseenter");
    controller().disconnect();
    vi.advanceTimersByTime(500);
    expect(content().hidden).toBe(true);
  });

  it("clears a pending hide timer on disconnect", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-hide-delay-value="200"');
    fire(trigger(), "mouseenter");
    fire(trigger(), "mouseleave");
    controller().disconnect();
    vi.advanceTimersByTime(200);
    expect(content().hidden).toBe(false);
  });

  it("removes the document Escape listener on disconnect while open", () => {
    fire(trigger(), "mouseenter");
    controller().disconnect();
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(content().hidden).toBe(false);
  });

  it("removes closeOnScroll listeners on disconnect while open", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-close-on-scroll-value="true"');
    fire(trigger(), "mouseenter");
    controller().disconnect();
    window.dispatchEvent(new Event("scroll"));
    expect(content().hidden).toBe(false);
  });

  it("shows on the first interaction after same-instance reconnect", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-show-delay-value="200"');
    fire(trigger(), "mouseenter");
    controller().disconnect();
    controller().connect();
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(200);
    expect(content().hidden).toBe(false);
  });

  it("cleans up listeners when the content target is removed", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-close-on-scroll-value="true"');
    fire(trigger(), "mouseenter");
    const detachedContent = content();
    detachedContent.remove();

    const firstEscape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(firstEscape);
    expect(firstEscape.defaultPrevented).toBe(true);

    root().append(detachedContent);
    detachedContent.hidden = false;
    window.dispatchEvent(new Event("scroll"));
    expect(detachedContent.hidden).toBe(false);
    const secondEscape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(secondEscape);
    expect(secondEscape.defaultPrevented).toBe(false);
  });

  it("keeps multiple instances independent", async () => {
    disconnectAndStopApplication(application);
    await boot(`
      <main>
        <span id="first" data-controller="stimeo--tooltip">
          <button data-stimeo--tooltip-target="trigger"
                  data-action="mouseenter->stimeo--tooltip#show">First</button>
          <span id="first-tip" data-stimeo--tooltip-target="content" hidden>First tip</span>
        </span>
        <span id="second" data-controller="stimeo--tooltip">
          <button data-stimeo--tooltip-target="trigger"
                  data-action="mouseenter->stimeo--tooltip#show">Second</button>
          <span id="second-tip" data-stimeo--tooltip-target="content" hidden>Second tip</span>
        </span>
      </main>`);
    fire(query("#first button"), "mouseenter");
    expect(query("#first-tip").hidden).toBe(false);
    expect(query("#second-tip").hidden).toBe(true);
    fire(query("#second button"), "mouseenter");
    expect(query("#first-tip").hidden).toBe(false);
    expect(query("#second-tip").hidden).toBe(false);
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
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
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
