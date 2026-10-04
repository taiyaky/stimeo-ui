import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollapsibleController } from "../src/controllers/collapsible_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
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
    expect(content().style.getPropertyValue("--stimeo--collapsible-content-height")).toMatch(/px$/);
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

  it("reads the open Value at connect only and keeps the DOM state over a later declaration", async () => {
    await restart(`
      <div data-controller="stimeo--collapsible" data-stimeo--collapsible-open-value="true">
        <button data-stimeo--collapsible-target="trigger"
                data-action="stimeo--collapsible#toggle"
                aria-controls="seeded">Show</button>
        <div id="seeded" data-stimeo--collapsible-target="content">Body</div>
      </div>`);
    const host = query("[data-controller='stimeo--collapsible']");
    const reconnect = async () => {
      host.remove();
      await tick();
      document.body.append(host);
      await tick();
    };
    const events = captureStateEvents("stimeo--collapsible");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    // A declaration rewritten after connect does not move the state, and a reconnect
    // keeps what the DOM shows rather than the new declaration.
    host.setAttribute("data-stimeo--collapsible-open-value", "false");
    await tick();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    await reconnect();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(content().getAttribute("data-state")).toBe("open");
    expect(content().hidden).toBe(false);

    trigger().click();
    host.setAttribute("data-stimeo--collapsible-open-value", "true");
    await tick();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await reconnect();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(content().getAttribute("data-state")).toBe("closed");
    expect(content().hidden).toBe(true);

    // Only the user's close moved the state.
    expect(events.names()).toEqual(["close"]);
    events.stop();
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

  it("keeps a content-only region closed over an open Value when its data-state reads closed", async () => {
    await restart(`
      <div data-controller="stimeo--collapsible" data-stimeo--collapsible-open-value="true">
        <div data-stimeo--collapsible-target="content" data-state="closed">Body</div>
      </div>`);

    expect(content().getAttribute("data-state")).toBe("closed");
    expect(content().hidden).toBe(true);
  });

  it("seeds a content-only region from the open Value when it carries no data-state", async () => {
    await restart(`
      <div data-controller="stimeo--collapsible" data-stimeo--collapsible-open-value="true">
        <div data-stimeo--collapsible-target="content">Body</div>
      </div>`);

    expect(content().getAttribute("data-state")).toBe("open");
    expect(content().hidden).toBe(false);
  });

  it("reconciles a replacement content target from its own data-state when there is no trigger", async () => {
    await restart(`
      <div data-controller="stimeo--collapsible">
        <div data-stimeo--collapsible-target="content" data-state="open">Body</div>
      </div>`);
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--collapsible-target", "content");
    replacement.setAttribute("data-state", "open");
    replacement.hidden = true;

    content().replaceWith(replacement);
    controller().contentTargetConnected(replacement);

    expect(replacement.getAttribute("data-state")).toBe("open");
    expect(replacement.hidden).toBe(false);
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
      // The replaced element carries its authored `hidden` again; shown once more, the
      // cancelled wait leaves it alone.
      expect(oldContent.hidden).toBe(true);
      oldContent.hidden = false;

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

    it("cancels a pending close on disconnect", () => {
      stubTransition("200ms");
      vi.useFakeTimers();
      trigger().click();
      trigger().click();
      const closingContent = content();

      controller().disconnect();
      finishTransition(closingContent);
      vi.advanceTimersByTime(250);

      expect(closingContent.getAttribute("data-state")).toBe("closed");
      expect(closingContent.hidden).toBe(false);
    });

    it("cancels a pending close when its content target leaves", () => {
      stubTransition("200ms");
      vi.useFakeTimers();
      trigger().click();
      trigger().click();
      const closingContent = content();

      closingContent.remove();
      controller().contentTargetDisconnected(closingContent);
      // The departed element carries its authored `hidden` again; shown once more, the
      // cancelled close leaves it alone.
      expect(closingContent.hidden).toBe(true);
      closingContent.hidden = false;
      finishTransition(closingContent);
      vi.advanceTimersByTime(250);

      expect(closingContent.hidden).toBe(false);
    });

    it("gives a content that stops being one mid-close its authored hidden back for good", async () => {
      stubTransition("200ms");
      vi.useFakeTimers();
      trigger().click();
      trigger().click();
      const closingContent = content();
      expect(closingContent.hidden).toBe(false);

      closingContent.removeAttribute("data-stimeo--collapsible-target");
      await vi.advanceTimersByTimeAsync(0);
      expect(closingContent.hidden).toBe(true);
      // The page shows the returned element; the close it had pending writes nothing.
      closingContent.hidden = false;
      finishTransition(closingContent);
      vi.advanceTimersByTime(250);

      expect(closingContent.hidden).toBe(false);
      expect(closingContent.getAttribute("data-state")).toBe("closed");
    });

    it("cancels the old wait once a replacement content connects ahead of it", () => {
      stubTransition("200ms");
      vi.useFakeTimers();
      trigger().click();
      trigger().click();
      const oldContent = content();
      const replacement = document.createElement("div");
      replacement.setAttribute("data-stimeo--collapsible-target", "content");

      oldContent.before(replacement);
      controller().contentTargetConnected(replacement);
      finishTransition(oldContent);
      vi.advanceTimersByTime(250);

      expect(oldContent.hidden).toBe(false);
      expect(replacement.getAttribute("data-state")).toBe("closed");
      expect(replacement.hidden).toBe(true);
    });

    it("releases the pending close wait when reopened mid-transition", () => {
      stubTransition("200ms");
      trigger().click(); // open
      trigger().click(); // close → the wait is armed
      const removals = vi.spyOn(content(), "removeEventListener");

      trigger().click(); // reopen

      expect(removals).toHaveBeenCalledWith("transitionend", expect.any(Function));
      expect(removals).toHaveBeenCalledWith("transitioncancel", expect.any(Function));
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

  it("reconciles a replacement trigger target with the closed content state", async () => {
    const oldTrigger = trigger();
    const replacement = oldTrigger.cloneNode(true) as HTMLButtonElement;
    replacement.setAttribute("aria-expanded", "true");
    oldTrigger.replaceWith(replacement);
    await tick();

    // The content is the truth source, so an authored open state on the incoming
    // trigger gives way to the closed region it controls.
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("reconciles a trigger inserted ahead of the connected one while that one stays", async () => {
    trigger().click();
    const incoming = trigger().cloneNode(true) as HTMLButtonElement;
    incoming.setAttribute("aria-expanded", "false");
    trigger().before(incoming);
    await tick();

    expect(trigger()).toBe(incoming);
    expect(incoming.getAttribute("aria-expanded")).toBe("true");
  });

  /** Inserts a copy of the trigger after the current one and lets Stimulus connect it. */
  const addTriggerSuccessor = async () => {
    const original = trigger();
    const successor = original.cloneNode(true) as HTMLButtonElement;
    original.after(successor);
    await tick();
    return { original, successor };
  };

  it("reconciles a trigger that stays after an earlier one leaves with the content state", async () => {
    const { original, successor } = await addTriggerSuccessor();
    original.click();
    original.remove();
    await tick();

    expect(trigger()).toBe(successor);
    expect(content().getAttribute("data-state")).toBe("open");
    expect(successor.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a staying trigger's own state when there is no content to reconcile it with", async () => {
    await restart(`
      <div data-controller="stimeo--collapsible">
        <button data-stimeo--collapsible-target="trigger"
                data-action="stimeo--collapsible#toggle" aria-expanded="false">
          <span data-stimeo--collapsible-target="collapsedLabel">Show details</span>
          <span data-stimeo--collapsible-target="expandedLabel" hidden>Hide details</span>
        </button>
      </div>`);
    const { original, successor } = await addTriggerSuccessor();
    original.click();
    expect(original.getAttribute("aria-expanded")).toBe("true");
    original.remove();
    await tick();

    expect(trigger()).toBe(successor);
    expect(successor.getAttribute("aria-expanded")).toBe("false");
    expect(query("[data-stimeo--collapsible-target='expandedLabel']", successor).hidden).toBe(true);
    expect(query("[data-stimeo--collapsible-target='collapsedLabel']", successor).hidden).toBe(
      false,
    );
  });

  it("keeps working when its only trigger leaves", async () => {
    const errors: unknown[] = [];
    application.handleError = (error) => {
      errors.push(error);
    };
    trigger().remove();
    await tick();
    controller().toggle();

    expect(errors).toEqual([]);
    expect(content().getAttribute("data-state")).toBe("open");
  });

  /** Inserts a copy of the content after the current one and lets Stimulus connect it. */
  const addContentSuccessor = async () => {
    const original = content();
    const successor = original.cloneNode(true) as HTMLElement;
    successor.id = "more-successor";
    original.after(successor);
    await tick();
    return { original, successor };
  };

  it("reconciles a content target that stays after an earlier one leaves with the trigger state", async () => {
    const { original, successor } = await addContentSuccessor();
    expect(successor.hidden).toBe(true);
    trigger().click();
    original.remove();
    await tick();

    expect(content()).toBe(successor);
    expect(successor.getAttribute("data-state")).toBe("open");
    expect(successor.hidden).toBe(false);
  });

  it("hides a content target that stays after an earlier one leaves once the region closes", async () => {
    trigger().click();
    const { original, successor } = await addContentSuccessor();
    expect(successor.hidden).toBe(false);
    trigger().click();
    original.remove();
    await tick();

    expect(content()).toBe(successor);
    expect(successor.getAttribute("data-state")).toBe("closed");
    expect(successor.hidden).toBe(true);
  });

  it("keeps a staying content target's own state when there is no trigger", async () => {
    await restart(`
      <div data-controller="stimeo--collapsible">
        <div data-stimeo--collapsible-target="content" data-state="closed" hidden>Body</div>
      </div>`);
    const { original, successor } = await addContentSuccessor();
    controller().toggle();
    expect(original.getAttribute("data-state")).toBe("open");
    original.remove();
    await tick();

    expect(content()).toBe(successor);
    expect(successor.getAttribute("data-state")).toBe("closed");
    expect(successor.hidden).toBe(true);
  });

  it("keeps working when its only content target leaves", async () => {
    const errors: unknown[] = [];
    application.handleError = (error) => {
      errors.push(error);
    };
    content().remove();
    await tick();
    trigger().click();

    expect(errors).toEqual([]);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("writes nothing onto the trigger while Stimulus tears the controller down", () => {
    // A value the page wrote after the last reconciliation stays where it was left.
    trigger().setAttribute("aria-expanded", "true");

    application.unload("stimeo--collapsible");

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("writes nothing onto the content while Stimulus tears the controller down", () => {
    // A value the page wrote after the last reconciliation stays where it was left.
    content().hidden = false;
    content().setAttribute("data-state", "open");

    application.unload("stimeo--collapsible");

    expect(content().getAttribute("data-state")).toBe("open");
    expect(content().hidden).toBe(false);
  });

  /** Drops only the trigger token from `element`, which stays where it is. */
  const dropTriggerToken = async (element: HTMLElement) => {
    element.removeAttribute("data-stimeo--collapsible-target");
    await tick();
  };

  it("gives a trigger that stops being one back the aria-expanded it was authored with", async () => {
    const departed = trigger();
    departed.click();
    expect(departed.getAttribute("aria-expanded")).toBe("true");

    await dropTriggerToken(departed);

    expect(departed.getAttribute("aria-expanded")).toBe("false");
    expect(content().getAttribute("data-state")).toBe("open");
  });

  it("gives the departed trigger its own state back while the trigger that stays follows the content", async () => {
    const { original, successor } = await addTriggerSuccessor();
    original.click();

    await dropTriggerToken(original);

    expect(trigger()).toBe(successor);
    expect(original.getAttribute("aria-expanded")).toBe("false");
    expect(successor.getAttribute("aria-expanded")).toBe("true");
  });

  it("removes the aria-expanded it wrote on a departed trigger that was authored without one", async () => {
    await restart(`
      <div data-controller="stimeo--collapsible">
        <button data-stimeo--collapsible-target="trigger"
                data-action="stimeo--collapsible#toggle">Show details</button>
        <div data-stimeo--collapsible-target="content" data-state="closed" hidden>Body</div>
      </div>`);
    const departed = trigger();
    departed.click();
    expect(departed.getAttribute("aria-expanded")).toBe("true");

    await dropTriggerToken(departed);

    expect(departed.hasAttribute("aria-expanded")).toBe(false);
  });

  it("keeps an aria-expanded the page wrote on a trigger after its last reconciliation", async () => {
    const departed = trigger();
    departed.click();
    departed.removeAttribute("aria-expanded");

    await dropTriggerToken(departed);

    expect(departed.hasAttribute("aria-expanded")).toBe(false);
  });

  it("keeps the state of a trigger that moves within the widget", async () => {
    await restart(`
      <div data-controller="stimeo--collapsible">
        <button data-stimeo--collapsible-target="trigger"
                data-action="stimeo--collapsible#toggle" aria-expanded="false">Show details</button>
        <p id="elsewhere"></p>
      </div>`);
    const moving = trigger();
    moving.click();

    query("#elsewhere").append(moving);
    await tick();

    expect(trigger()).toBe(moving);
    expect(moving.getAttribute("aria-expanded")).toBe("true");
  });

  it("gives the trigger back its own aria-expanded when the widget loses its controller", async () => {
    const departed = trigger();
    departed.click();

    query("[data-controller='stimeo--collapsible']").removeAttribute("data-controller");
    await tick();

    expect(departed.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps what it wrote on the trigger when the whole widget leaves the page", async () => {
    const kept = trigger();
    kept.click();

    query("[data-controller='stimeo--collapsible']").remove();
    await tick();

    expect(kept.getAttribute("aria-expanded")).toBe("true");
  });

  /** Drops only the content token from `element`, which stays where it is. */
  const dropContentToken = async (element: HTMLElement) => {
    element.removeAttribute("data-stimeo--collapsible-target");
    await tick();
  };

  it("gives a content that stops being one back the hidden and data-state it was authored with", async () => {
    const departed = content();
    trigger().click();
    expect(departed.hidden).toBe(false);
    expect(departed.getAttribute("data-state")).toBe("open");
    const capture = captureStateEvents("stimeo--collapsible");

    await dropContentToken(departed);
    capture.stop();

    expect(departed.hidden).toBe(true);
    expect(departed.getAttribute("data-state")).toBe("closed");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(capture.seen).toEqual([]);
  });

  it("gives the departed content its own state back while the content that stays follows the trigger", async () => {
    const { original, successor } = await addContentSuccessor();
    trigger().click();

    await dropContentToken(original);

    expect(content()).toBe(successor);
    expect(original.hidden).toBe(true);
    expect(original.getAttribute("data-state")).toBe("closed");
    expect(successor.hidden).toBe(false);
    expect(successor.getAttribute("data-state")).toBe("open");
  });

  it("removes the hidden and data-state it wrote on a departed content that was authored without them", async () => {
    await restart(`
      <div data-controller="stimeo--collapsible">
        <button data-stimeo--collapsible-target="trigger"
                data-action="stimeo--collapsible#toggle" aria-expanded="false">Show details</button>
        <div data-stimeo--collapsible-target="content">Body</div>
      </div>`);
    const departed = content();
    expect(departed.hidden).toBe(true);
    expect(departed.getAttribute("data-state")).toBe("closed");

    await dropContentToken(departed);

    expect(departed.hasAttribute("hidden")).toBe(false);
    expect(departed.hasAttribute("data-state")).toBe(false);
  });

  it("keeps a hidden and data-state the page wrote on a content after its last reconciliation", async () => {
    const departed = content();
    trigger().click();
    departed.hidden = true;
    departed.setAttribute("data-state", "settling");

    await dropContentToken(departed);

    expect(departed.hidden).toBe(true);
    expect(departed.getAttribute("data-state")).toBe("settling");
  });

  it("keeps the state of a content that moves within the widget", async () => {
    await restart(`
      <div data-controller="stimeo--collapsible">
        <button data-stimeo--collapsible-target="trigger"
                data-action="stimeo--collapsible#toggle" aria-expanded="false">Show details</button>
        <div data-stimeo--collapsible-target="content" data-state="closed" hidden>Body</div>
        <p id="elsewhere"></p>
      </div>`);
    const moving = content();
    trigger().click();

    query("#elsewhere").append(moving);
    await tick();

    expect(content()).toBe(moving);
    expect(moving.hidden).toBe(false);
    expect(moving.getAttribute("data-state")).toBe("open");
  });

  it("gives the content back its own hidden and data-state when the widget loses its controller", async () => {
    const departed = content();
    trigger().click();

    query("[data-controller='stimeo--collapsible']").removeAttribute("data-controller");
    await tick();

    expect(departed.hidden).toBe(true);
    expect(departed.getAttribute("data-state")).toBe("closed");
  });

  it("keeps what it wrote on the content when the whole widget leaves the page", async () => {
    const kept = content();
    trigger().click();

    query("[data-controller='stimeo--collapsible']").remove();
    await tick();

    expect(kept.hidden).toBe(false);
    expect(kept.getAttribute("data-state")).toBe("open");
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

  // --- Expanded / collapsed labels ---

  // The trigger may carry a label pair: one label belongs to the expanded state,
  // the other to the collapsed one. Which side is shown is a pure function of
  // `aria-expanded`, written unconditionally, so what the author left on the pair
  // never survives a connection.
  describe("expanded / collapsed labels", () => {
    const labeled = `
      <div data-controller="stimeo--collapsible">
        <button data-stimeo--collapsible-target="trigger"
                data-action="stimeo--collapsible#toggle"
                aria-expanded="false" aria-controls="labeled-body">
          <span data-stimeo--collapsible-target="collapsedLabel">Show details</span>
          <span data-stimeo--collapsible-target="expandedLabel" hidden>Hide details</span>
        </button>
        <div id="labeled-body" data-stimeo--collapsible-target="content"
             data-state="closed" hidden>Billing details</div>
      </div>`;

    const expandedLabel = (root: ParentNode = document) =>
      query("[data-stimeo--collapsible-target='expandedLabel']", root);
    const collapsedLabel = (root: ParentNode = document) =>
      query("[data-stimeo--collapsible-target='collapsedLabel']", root);

    it("settles nothing when a half arrives with no trigger to sit in", async () => {
      // The pair is resolved against the trigger, so a widget without one has no host
      // to reflect into. Stimulus settles a target before the controller connects, so
      // reaching for the absent trigger there throws out of the callback rather than
      // through the application's own error handler.
      const markup = `
        <div data-controller="stimeo--collapsible">
          <span data-stimeo--collapsible-target="expandedLabel">Hide</span>
          <span data-stimeo--collapsible-target="collapsedLabel">Show</span>
          <div data-stimeo--collapsible-target="content" data-state="closed" hidden>Body</div>
        </div>`;

      await expect(restart(markup)).resolves.toBeUndefined();

      expect(expandedLabel().hidden).toBe(false);
      expect(collapsedLabel().hidden).toBe(false);
    });

    it("shows the label that belongs to the state in both directions", async () => {
      await restart(labeled);

      expect(collapsedLabel().hidden).toBe(false);
      expect(expandedLabel().hidden).toBe(true);

      trigger().click();
      expect(expandedLabel().hidden).toBe(false);
      expect(collapsedLabel().hidden).toBe(true);

      trigger().click();
      expect(collapsedLabel().hidden).toBe(false);
      expect(expandedLabel().hidden).toBe(true);
    });

    it("corrects a pair authored against the state on the first connection", async () => {
      // Both sides are authored for the collapsed state while the markup reads
      // expanded; the first reflection settles them without reading them back.
      await restart(`
        <div data-controller="stimeo--collapsible">
          <button data-stimeo--collapsible-target="trigger"
                  data-action="stimeo--collapsible#toggle"
                  aria-expanded="true" aria-controls="stale-body">
            <span data-stimeo--collapsible-target="collapsedLabel">Show details</span>
            <span data-stimeo--collapsible-target="expandedLabel" hidden>Hide details</span>
          </button>
          <div id="stale-body" data-stimeo--collapsible-target="content"
               data-state="open">Billing details</div>
        </div>`);

      expect(expandedLabel().hidden).toBe(false);
      expect(collapsedLabel().hidden).toBe(true);
    });

    it("leaves a lone label as authored while a complete pair beside it reflects", async () => {
      // Hiding the only label inside a trigger would leave that trigger nameless,
      // so a half pair keeps what the author wrote.
      await restart(`
        <div id="pair" data-controller="stimeo--collapsible">
          <button data-stimeo--collapsible-target="trigger"
                  data-action="stimeo--collapsible#toggle"
                  aria-expanded="true" aria-controls="pair-body">
            <span data-stimeo--collapsible-target="collapsedLabel">Show details</span>
            <span data-stimeo--collapsible-target="expandedLabel" hidden>Hide details</span>
          </button>
          <div id="pair-body" data-stimeo--collapsible-target="content"
               data-state="open">Billing details</div>
        </div>
        <div id="half" data-controller="stimeo--collapsible">
          <button data-stimeo--collapsible-target="trigger"
                  data-action="stimeo--collapsible#toggle"
                  aria-expanded="true" aria-controls="half-body">
            <span data-stimeo--collapsible-target="expandedLabel" hidden>Hide shipping</span>
          </button>
          <div id="half-body" data-stimeo--collapsible-target="content"
               data-state="open">Shipping details</div>
        </div>`);

      const pair = query("#pair");
      const half = query("#half");
      expect(expandedLabel(pair).hidden).toBe(false);
      expect(collapsedLabel(pair).hidden).toBe(true);
      expect(expandedLabel(half).hidden).toBe(true);

      // A half the controller wrote would flip with the state, so the round trip
      // checks both: in the expanded state a written half would be shown instead.
      const halfTrigger = query<HTMLButtonElement>(
        "[data-stimeo--collapsible-target='trigger']",
        half,
      );
      halfTrigger.click();
      expect(halfTrigger.getAttribute("aria-expanded")).toBe("false");
      expect(expandedLabel(half).hidden).toBe(true);

      halfTrigger.click();
      expect(halfTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(expandedLabel(half).hidden).toBe(true);
    });

    it("syncs the pair of a trigger that replaces the connected one", async () => {
      await restart(labeled);
      trigger().click();

      const replacement = trigger().cloneNode(true) as HTMLButtonElement;
      replacement.setAttribute("aria-expanded", "false");
      expandedLabel(replacement).hidden = true;
      collapsedLabel(replacement).hidden = false;
      trigger().replaceWith(replacement);
      await tick();

      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(expandedLabel().hidden).toBe(false);
      expect(collapsedLabel().hidden).toBe(true);
    });

    it("syncs the pair of a trigger that stays after an earlier one leaves", async () => {
      await restart(labeled);
      const original = trigger();
      const successor = original.cloneNode(true) as HTMLButtonElement;
      original.after(successor);
      await tick();
      original.click();
      original.remove();
      await tick();

      expect(trigger()).toBe(successor);
      expect(expandedLabel(successor).hidden).toBe(false);
      expect(collapsedLabel(successor).hidden).toBe(true);
    });

    it("gives a trigger that stops being one back the pair it was authored with", async () => {
      await restart(labeled);
      const departed = trigger();
      departed.click();
      expect(expandedLabel(departed).hidden).toBe(false);
      expect(collapsedLabel(departed).hidden).toBe(true);

      departed.removeAttribute("data-stimeo--collapsible-target");
      await tick();

      expect(departed.getAttribute("aria-expanded")).toBe("false");
      expect(expandedLabel(departed).hidden).toBe(true);
      expect(collapsedLabel(departed).hidden).toBe(false);
    });

    it("gives the trigger back its own pair when the widget loses its controller", async () => {
      await restart(labeled);
      const departed = trigger();
      departed.click();

      query("[data-controller='stimeo--collapsible']").removeAttribute("data-controller");
      await tick();

      expect(departed.getAttribute("aria-expanded")).toBe("false");
      expect(expandedLabel(departed).hidden).toBe(true);
      expect(collapsedLabel(departed).hidden).toBe(false);
    });

    it("settles the pair of a trigger that takes over from the connected one", async () => {
      // The incoming button already contains the pair when it arrives, so its own
      // target callbacks have run by the time that button becomes the trigger: the
      // trigger reconciliation is the only thing left that can settle it against the
      // content's live state.
      await restart(`
        <div data-controller="stimeo--collapsible">
          <button id="outgoing" data-stimeo--collapsible-target="trigger"
                  data-action="stimeo--collapsible#toggle"
                  aria-expanded="true" aria-controls="takeover-body">Hide details</button>
          <button id="incoming" data-action="stimeo--collapsible#toggle">
            <span data-stimeo--collapsible-target="collapsedLabel">Show details</span>
            <span data-stimeo--collapsible-target="expandedLabel" hidden>Hide details</span>
          </button>
          <div id="takeover-body" data-stimeo--collapsible-target="content"
               data-state="open">Billing details</div>
        </div>`);

      // A pair outside the connected trigger is not the controller's to write.
      expect(collapsedLabel().hidden).toBe(false);
      expect(expandedLabel().hidden).toBe(true);

      query("#outgoing").remove();
      query("#incoming").setAttribute("data-stimeo--collapsible-target", "trigger");
      await tick();

      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(expandedLabel().hidden).toBe(false);
      expect(collapsedLabel().hidden).toBe(true);
    });

    it("settles the pair of a taking-over trigger that has no content target", async () => {
      // With no content target the trigger's own `aria-expanded` is the state, and
      // the pair inside it belongs to that state just the same.
      await restart(`
        <div data-controller="stimeo--collapsible">
          <button id="outgoing" data-stimeo--collapsible-target="trigger"
                  data-action="stimeo--collapsible#toggle"
                  aria-expanded="true">Hide details</button>
          <button id="incoming" data-action="stimeo--collapsible#toggle"
                  aria-expanded="true">
            <span data-stimeo--collapsible-target="collapsedLabel">Show details</span>
            <span data-stimeo--collapsible-target="expandedLabel" hidden>Hide details</span>
          </button>
        </div>`);

      query("#outgoing").remove();
      query("#incoming").setAttribute("data-stimeo--collapsible-target", "trigger");
      await tick();

      expect(expandedLabel().hidden).toBe(false);
      expect(collapsedLabel().hidden).toBe(true);
    });

    it("syncs a pair that arrives inside the trigger after connect", async () => {
      trigger().click();

      const collapsed = document.createElement("span");
      collapsed.setAttribute("data-stimeo--collapsible-target", "collapsedLabel");
      collapsed.textContent = "Show details";
      const expanded = document.createElement("span");
      expanded.setAttribute("data-stimeo--collapsible-target", "expandedLabel");
      expanded.textContent = "Hide details";
      expanded.hidden = true;
      trigger().append(collapsed, expanded);
      await tick();

      expect(expanded.hidden).toBe(false);
      expect(collapsed.hidden).toBe(true);
    });

    it("settles an expanded label that replaces its half of the pair", async () => {
      await restart(labeled);
      const replacement = document.createElement("span");
      replacement.setAttribute("data-stimeo--collapsible-target", "expandedLabel");
      replacement.textContent = "Hide details";

      expandedLabel().replaceWith(replacement);
      controller().expandedLabelTargetConnected();

      expect(replacement.hidden).toBe(true);
      expect(collapsedLabel().hidden).toBe(false);
    });

    it("settles a collapsed label that replaces its half of the pair", async () => {
      await restart(labeled);
      trigger().click();
      const replacement = document.createElement("span");
      replacement.setAttribute("data-stimeo--collapsible-target", "collapsedLabel");
      replacement.textContent = "Show details";

      collapsedLabel().replaceWith(replacement);
      controller().collapsedLabelTargetConnected();

      expect(replacement.hidden).toBe(true);
      expect(expandedLabel().hidden).toBe(false);
    });

    it("swaps the pair with aria-expanded, ahead of the deferred hidden", async () => {
      await restart(labeled);
      const spy = vi.spyOn(window, "getComputedStyle").mockReturnValue({
        transitionProperty: "height",
        transitionDuration: "0.2s",
        transitionDelay: "0s",
      } as CSSStyleDeclaration);
      try {
        trigger().click(); // open
        expect(expandedLabel().hidden).toBe(false);
        expect(collapsedLabel().hidden).toBe(true);

        trigger().click(); // close, with the content's hidden waiting on the transition
        expect(content().hidden).toBe(false);
        expect(collapsedLabel().hidden).toBe(false);
        expect(expandedLabel().hidden).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--collapsible");
    });

    afterEach(() => {
      capture.stop();
    });

    it("reports a trigger click as user, as soon as the state attributes are written", () => {
      const states: string[] = [];
      query("[data-controller='stimeo--collapsible']").addEventListener(
        "stimeo--collapsible:open",
        () => {
          states.push(
            `${trigger().getAttribute("aria-expanded")} ${content().getAttribute("data-state")}`,
          );
        },
      );

      trigger().click();

      expect(capture.names()).toEqual(["open"]);
      expect(capture.reasons()).toEqual(["user"]);
      expect(states).toEqual(["true open"]);
      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);
    });

    it("reports the close before the deferred hidden lands", () => {
      trigger().click();
      capture.clear();

      trigger().click();

      expect(capture.names()).toEqual(["close"]);
      expect(content().getAttribute("data-state")).toBe("closed");
    });

    it("reports a call with no DOM event as api", () => {
      controller().toggle();

      expect(capture.reasons()).toEqual(["api"]);
    });

    it("stays silent while connect establishes an authored-open baseline", async () => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = `
        <div data-controller="stimeo--collapsible">
          <button data-stimeo--collapsible-target="trigger" aria-expanded="true"
                  aria-controls="more">Show details</button>
          <div id="more" data-stimeo--collapsible-target="content" data-state="open"></div>
        </div>`;
      const fresh = captureStateEvents("stimeo--collapsible");
      application = Application.start();
      application.register("stimeo--collapsible", CollapsibleController);
      await tick();

      expect(content().getAttribute("data-state")).toBe("open");
      expect(fresh.seen).toEqual([]);
      fresh.stop();
    });

    it("stays silent while a replacement content target is reconciled", async () => {
      trigger().click();
      capture.clear();

      const replacement = document.createElement("div");
      replacement.id = "more";
      replacement.setAttribute("data-stimeo--collapsible-target", "content");
      content().replaceWith(replacement);
      await tick();

      expect(capture.seen).toEqual([]);
    });

    it("stays silent while a trigger that stays after an earlier one leaves is reconciled", async () => {
      const original = trigger();
      const successor = original.cloneNode(true) as HTMLButtonElement;
      original.after(successor);
      await tick();
      original.click();
      capture.clear();
      const host = query("[data-controller='stimeo--collapsible']");
      const others: string[] = [];
      host.addEventListener("stimeo--collapsible:reconcile", () => others.push("reconcile"));
      host.addEventListener("change", () => others.push("change"));

      original.remove();
      await tick();

      expect(successor.getAttribute("aria-expanded")).toBe("true");
      expect(capture.seen).toEqual([]);
      expect(others).toEqual([]);
    });

    it("stays silent while a content target that stays after an earlier one leaves is reconciled", async () => {
      const original = content();
      const successor = original.cloneNode(true) as HTMLElement;
      successor.id = "more-successor";
      original.after(successor);
      await tick();
      trigger().click();
      capture.clear();
      const host = query("[data-controller='stimeo--collapsible']");
      const others: string[] = [];
      host.addEventListener("stimeo--collapsible:reconcile", () => others.push("reconcile"));
      host.addEventListener("change", () => others.push("change"));

      original.remove();
      await tick();

      expect(successor.getAttribute("data-state")).toBe("open");
      expect(capture.seen).toEqual([]);
      expect(others).toEqual([]);
    });

    it("stays silent through a disconnect and a Turbo-style reconnect", async () => {
      trigger().click();
      capture.clear();

      const element = query("[data-controller='stimeo--collapsible']");
      element.remove();
      await tick();
      document.body.append(element);
      await tick();

      expect(capture.seen).toEqual([]);
    });
  });
});
