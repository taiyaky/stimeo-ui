import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollapsibleController } from "../src/controllers/collapsible_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link CollapsibleController}: the APG Disclosure contract
 * for a single inline region — `aria-expanded` on the trigger plus `hidden` /
 * `data-state` on the content, asserted in happy-dom.
 *
 * happy-dom reports a zero `transition-duration`, so the close path applies
 * `hidden` synchronously (the transition branch is exercised separately by the
 * real-browser layer).
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    application.stop();
    document.body.innerHTML = "";
  });

  const trigger = () => query<HTMLButtonElement>("[data-stimeo--collapsible-target='trigger']");
  const content = () => query("[data-stimeo--collapsible-target='content']");

  it("starts closed", () => {
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(content().hidden).toBe(true);
    expect(content().getAttribute("data-state")).toBe("closed");
  });

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
    application.stop();
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

  it("stays closed on reconnect when the restored DOM reads closed (DOM wins over open Value)", async () => {
    // The mirror of the test below: an `open` Value of true must NOT reopen a region
    // the user had closed before a Turbo cache restore (explicit aria-expanded="false").
    application.stop();
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
    application.stop();
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

  // Layer ① — machine-detectable a11y, asserted in both states. The page-level
  // `region` (landmark) rule is irrelevant to a headless component fragment.
  it("has no machine-detectable a11y violations in either state", async () => {
    const noRegion = { rules: { region: { enabled: false } } };
    await expectNoA11yViolations(document.body, noRegion);
    trigger().click();
    await expectNoA11yViolations(document.body, noRegion);
  });

  // Layer ③ — speech-order regression: the trigger's expanded state must flip in
  // the announced phrase across a toggle.
  it("announces the trigger's expanded state and flips it on toggle", async () => {
    const before = await captureSpeech({ container: trigger(), steps: 0 });
    expect(before).toEqual(["button, Show details, not expanded"]);

    trigger().click();
    const after = await captureSpeech({ container: trigger(), steps: 0 });
    expect(after).toEqual(["button, Show details, expanded"]);
  });

  // happy-dom reports an empty computed transition-duration, so the transition
  // branch is forced by stubbing getComputedStyle. These lock the close
  // lifecycle: hidden is deferred until transitionend, and a reopen mid-transition
  // cancels the deferred hide.
  describe("with a non-zero transition", () => {
    const stubDuration = (value: string) =>
      vi
        .spyOn(window, "getComputedStyle")
        .mockReturnValue({ transitionDuration: value } as CSSStyleDeclaration);

    it("defers hidden until transitionend, then applies it", () => {
      const spy = stubDuration("0.2s");
      try {
        trigger().click(); // open
        trigger().click(); // close → transition pending
        expect(content().getAttribute("data-state")).toBe("closed");
        expect(content().hidden).toBe(false); // not hidden yet — waiting for the transition

        content().dispatchEvent(new Event("transitionend"));
        expect(content().hidden).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("does not hide if reopened before the transition ends", () => {
      const spy = stubDuration("0.2s");
      try {
        trigger().click(); // open
        trigger().click(); // close (pending)
        trigger().click(); // reopen before transitionend
        expect(content().getAttribute("data-state")).toBe("open");

        content().dispatchEvent(new Event("transitionend")); // stale event
        expect(content().hidden).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it("parses a transition-duration given in milliseconds", () => {
      const spy = stubDuration("200ms");
      try {
        trigger().click();
        trigger().click();
        expect(content().hidden).toBe(false); // ms parsed as > 0, so still waiting
        content().dispatchEvent(new Event("transitionend"));
        expect(content().hidden).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("is a safe no-op when the trigger/content targets are absent", async () => {
    application.stop();
    document.body.innerHTML = `<div data-controller="stimeo--collapsible"></div>`;
    application = Application.start();
    application.register("stimeo--collapsible", CollapsibleController);
    await tick();

    const host = query("[data-controller='stimeo--collapsible']");
    const instance = application.getControllerForElementAndIdentifier(
      host,
      "stimeo--collapsible",
    ) as CollapsibleController;
    expect(() => instance.toggle()).not.toThrow();
  });

  // Disconnect teardown: after stop() the element is inert (no toggle, no
  // lingering transitionend listener mutating a detached node).
  it("becomes inert after disconnect", () => {
    application.stop();
    trigger().click();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
});
