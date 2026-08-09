import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollapsibleController } from "../src/controllers/collapsible_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link CollapsibleController}: the APG Disclosure contract
 * for a single inline region — `aria-expanded` on the trigger plus `hidden` /
 * `data-state` on the content, asserted in happy-dom.
 *
 * happy-dom reports a zero `transition-duration`, so the default close path
 * applies `hidden` synchronously. Transition-specific cases stub the complete
 * computed property/duration/delay tuple.
 */

describe("CollapsibleController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--collapsible">
        <button data-stimeo--collapsible-target="trigger"
                data-action="stimeo--collapsible#toggle"
                aria-expanded="false" aria-controls="more">Show details</button>
        <div id="more" data-stimeo--collapsible-target="content"
             data-state="closed" hidden>Hidden details</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--collapsible", CollapsibleController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const trigger = () => query<HTMLButtonElement>("[data-stimeo--collapsible-target='trigger']");
  const content = () => query("[data-stimeo--collapsible-target='content']");
  const controller = () => {
    const host = query("[data-controller='stimeo--collapsible']");
    const instance = application.getControllerForElementAndIdentifier(host, "stimeo--collapsible");
    if (!(instance instanceof CollapsibleController)) {
      throw new Error("collapsible controller missing");
    }
    return instance;
  };
  const restart = async (markup: string) => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--collapsible", CollapsibleController);
    await tick();
  };

  it("opens on trigger click: drops hidden, sets data-state and the height var", () => {
    trigger().click();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(content().hidden).toBe(false);
    expect(content().getAttribute("data-state")).toBe("open");
    expect(content().style.getPropertyValue("--stimeo-collapsible-content-height")).toMatch(/px$/);
  });

  it("closes on a second click: reapplies hidden and data-state closed", () => {
    trigger().click();
    trigger().click();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(content().getAttribute("data-state")).toBe("closed");
    expect(content().hidden).toBe(true);
  });

  it("honors the initial open value on a fresh render (no state attribute yet)", async () => {
    // A genuinely fresh render carries no explicit state attribute, so the `open`
    // Value seeds the initial state.
    disconnectAndStopApplication(application);
    document.body.innerHTML = `
      <div data-controller="stimeo--collapsible"
           data-stimeo--collapsible-open-value="true">
        <button data-stimeo--collapsible-target="trigger"
                data-action="stimeo--collapsible#toggle"
                aria-controls="more2">Show</button>
        <div id="more2" data-stimeo--collapsible-target="content" hidden>Body</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--collapsible", CollapsibleController);
    await tick();

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(content().hidden).toBe(false);
    expect(content().getAttribute("data-state")).toBe("open");
  });

  it("uses the false open default on a fresh render with no state attributes", async () => {
    await restart(`
      <div data-controller="stimeo--collapsible">
        <button data-stimeo--collapsible-target="trigger"
                data-action="stimeo--collapsible#toggle"
                aria-controls="default-closed">Show</button>
        <div id="default-closed" data-stimeo--collapsible-target="content">Body</div>
      </div>`);

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(content().getAttribute("data-state")).toBe("closed");
    expect(content().hidden).toBe(true);
  });

  it("stays closed on reconnect when the restored DOM reads closed (DOM wins over open Value)", async () => {
    // The mirror of the test below: an `open` Value of true must NOT reopen a region
    // the user had closed before a Turbo cache restore (explicit aria-expanded="false").
    disconnectAndStopApplication(application);
    document.body.innerHTML = `
      <div data-controller="stimeo--collapsible"
           data-stimeo--collapsible-open-value="true">
        <button data-stimeo--collapsible-target="trigger"
                data-action="stimeo--collapsible#toggle"
                aria-expanded="false" aria-controls="more4">Show</button>
        <div id="more4" data-stimeo--collapsible-target="content"
             data-state="closed" hidden>Body</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--collapsible", CollapsibleController);
    await tick();

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(content().getAttribute("data-state")).toBe("closed");
  });

  it("stays open on reconnect when the restored DOM reads open (DOM wins over Value)", async () => {
    // Simulate a Turbo cache restore: the cached snapshot already reads open
    // (aria-expanded="true", data-state="open", no hidden) even though the
    // declarative open Value defaults to false. The DOM must win — connect must
    // not collapse a region the user had opened.
    disconnectAndStopApplication(application);
    document.body.innerHTML = `
      <div data-controller="stimeo--collapsible">
        <button data-stimeo--collapsible-target="trigger"
                data-action="stimeo--collapsible#toggle"
                aria-expanded="true" aria-controls="more3">Show</button>
        <div id="more3" data-stimeo--collapsible-target="content"
             data-state="open">Body</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--collapsible", CollapsibleController);
    await tick();

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(content().hidden).toBe(false);
    expect(content().getAttribute("data-state")).toBe("open");
  });

  it("supports a content-only target by restoring and toggling its data-state", async () => {
    await restart(`
      <div data-controller="stimeo--collapsible">
        <div data-stimeo--collapsible-target="content" data-state="open">Body</div>
      </div>`);

    expect(content().hidden).toBe(false);
    controller().toggle();
    expect(content().getAttribute("data-state")).toBe("closed");
    expect(content().hidden).toBe(true);
    controller().toggle();
    expect(content().getAttribute("data-state")).toBe("open");
    expect(content().hidden).toBe(false);
  });

  it("keeps a trigger-only target operable through the declared action", async () => {
    await restart(`
      <div data-controller="stimeo--collapsible">
        <button data-stimeo--collapsible-target="trigger"
                data-action="stimeo--collapsible#toggle"
                aria-expanded="false">Toggle</button>
      </div>`);

    trigger().click();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    trigger().click();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  // Machine-detectable a11y, asserted in both states. The page-level `region`
  // (landmark) rule is irrelevant to a headless component fragment.
  it("has no machine-detectable a11y violations in either state", async () => {
    const noRegion = { rules: { region: { enabled: false } } };
    await expectNoA11yViolations(document.body, noRegion);
    trigger().click();
    await expectNoA11yViolations(document.body, noRegion);
  });

  // Speech-order regression: the trigger's expanded state must flip in the
  // announced phrase across a toggle.
  it("announces the trigger's expanded state and flips it on toggle", async () => {
    const before = await captureSpeech({ container: trigger(), steps: 0 });
    expect(before).toEqual(["button, Show details, not expanded"]);

    trigger().click();
    const after = await captureSpeech({ container: trigger(), steps: 0 });
    expect(after).toEqual(["button, Show details, expanded"]);
  });

  // happy-dom reports empty computed transition fields, so these tests stub the
  // complete property/duration/delay tuple that the shared waiter consumes.
  describe("with a non-zero transition", () => {
    const stubTransition = (duration: string, delay = "0s", property = "height") =>
      vi.spyOn(window, "getComputedStyle").mockReturnValue({
        transitionProperty: property,
        transitionDuration: duration,
        transitionDelay: delay,
      } as CSSStyleDeclaration);

    const finishTransition = (
      element: HTMLElement = content(),
      property = "height",
      type: "transitionend" | "transitioncancel" = "transitionend",
    ) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: property });
      element.dispatchEvent(event);
    };

    it("defers hidden until transitionend, then applies it", () => {
      const spy = stubTransition("0.2s");
      try {
        trigger().click(); // open
        trigger().click(); // close → transition pending
        expect(content().getAttribute("data-state")).toBe("closed");
        expect(content().hidden).toBe(false); // not hidden yet — waiting for the transition

        finishTransition();
        expect(content().hidden).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("does not hide if reopened before the transition ends", () => {
      const spy = stubTransition("0.2s");
      try {
        trigger().click(); // open
        trigger().click(); // close (pending)
        trigger().click(); // reopen before transitionend
        expect(content().getAttribute("data-state")).toBe("open");

        finishTransition(); // stale event
        expect(content().hidden).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it("parses a transition-duration given in milliseconds", () => {
      const spy = stubTransition("200ms");
      try {
        trigger().click();
        trigger().click();
        expect(content().hidden).toBe(false); // ms parsed as > 0, so still waiting
        finishTransition();
        expect(content().hidden).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("applies hidden through the bounded fallback when no terminal event fires", () => {
      stubTransition("200ms", "50ms");
      vi.useFakeTimers();
      trigger().click();
      trigger().click();

      vi.advanceTimersByTime(299);
      expect(content().hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(content().hidden).toBe(true);
    });

    it("treats transitioncancel as a terminal event for the closing property", () => {
      stubTransition("200ms");
      trigger().click();
      trigger().click();

      finishTransition(content(), "height", "transitioncancel");

      expect(content().getAttribute("data-state")).toBe("closed");
      expect(content().hidden).toBe(true);
    });

    it("ignores descendant and undeclared-property transition events", () => {
      stubTransition("200ms");
      trigger().click();
      trigger().click();
      const child = document.createElement("span");
      content().append(child);

      finishTransition(child);
      finishTransition(content(), "opacity");
      expect(content().hidden).toBe(false);

      finishTransition();
      expect(content().hidden).toBe(true);
    });

    it("cancels the old wait and reconciles a closed replacement as hidden", async () => {
      stubTransition("200ms");
      vi.useFakeTimers();
      trigger().click();
      trigger().click();
      const oldContent = content();
      const replacement = oldContent.cloneNode(true) as HTMLElement;
      oldContent.replaceWith(replacement);
      await vi.advanceTimersByTimeAsync(0);

      vi.advanceTimersByTime(250);
      expect(oldContent.hidden).toBe(false);
      expect(replacement.getAttribute("data-state")).toBe("closed");
      expect(replacement.hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("reconciles a replacement content target with the open state", async () => {
      stubTransition("200ms");
      vi.useFakeTimers();
      trigger().click();
      const oldContent = content();
      const replacement = oldContent.cloneNode(true) as HTMLElement;
      replacement.hidden = true;
      replacement.setAttribute("data-state", "closed");
      oldContent.replaceWith(replacement);
      await vi.advanceTimersByTimeAsync(0);

      expect(replacement.getAttribute("data-state")).toBe("open");
      expect(replacement.hidden).toBe(false);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
    });

    it("cancels a pending close when the Stimulus definition is unloaded", () => {
      stubTransition("200ms");
      vi.useFakeTimers();
      trigger().click();
      trigger().click();
      const closingContent = content();

      application.unload("stimeo--collapsible");
      finishTransition(closingContent);
      vi.advanceTimersByTime(250);
      trigger().click();

      expect(closingContent.getAttribute("data-state")).toBe("closed");
      expect(closingContent.hidden).toBe(false);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("reconciles a replacement trigger target with the open content state", async () => {
    trigger().click();
    const oldTrigger = trigger();
    const replacement = oldTrigger.cloneNode(true) as HTMLButtonElement;
    replacement.setAttribute("aria-expanded", "false");
    oldTrigger.replaceWith(replacement);
    await tick();

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    trigger().click();
    expect(content().getAttribute("data-state")).toBe("closed");
  });

  it("is a safe no-op when the trigger/content targets are absent", async () => {
    await restart(`<div data-controller="stimeo--collapsible"></div>`);

    expect(() => controller().toggle()).not.toThrow();
  });

  // Unloading the definition must also remove the declared action binding.
  it("becomes inert after disconnect", () => {
    application.unload("stimeo--collapsible");
    trigger().click();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
});
