import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ReadMoreController } from "../src/controllers/read_more_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { byId, query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link ReadMoreController}: the borrowed Disclosure
 * convention (`aria-expanded` + `data-state`) and the overflow-detection that
 * hides the toggle when the text is not actually clamped.
 *
 * happy-dom returns 0 for `scrollHeight` / `clientHeight`, so overflow is
 * simulated by stubbing those getters on the content element.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Stubs the content box so `scrollHeight > clientHeight` reflects `overflowing`. */
function stubOverflow(element: HTMLElement, overflowing: boolean): void {
  Object.defineProperty(element, "scrollHeight", {
    value: overflowing ? 200 : 50,
    configurable: true,
  });
  Object.defineProperty(element, "clientHeight", { value: 50, configurable: true });
}

describe("ReadMoreController", () => {
  let application: Application;

  const start = async (overflowing: boolean) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--read-more">
        <p id="bio" data-stimeo--read-more-target="content" data-state="collapsed">
          A long biography that may or may not exceed its clamp.
        </p>
        <button data-stimeo--read-more-target="trigger"
                data-action="stimeo--read-more#toggle"
                aria-expanded="false" aria-controls="bio" hidden>Read more</button>
      </div>`;
    stubOverflow(byId("bio"), overflowing);
    application = Application.start();
    application.register("stimeo--read-more", ReadMoreController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const content = () => query("[data-stimeo--read-more-target='content']");
  const trigger = () => query<HTMLButtonElement>("[data-stimeo--read-more-target='trigger']");

  it("shows the toggle when the text overflows its clamp", async () => {
    await start(true);
    expect(trigger().hidden).toBe(false);
    expect(content().getAttribute("data-state")).toBe("collapsed");
  });

  it("hides the toggle when the text fits (no overflow)", async () => {
    await start(false);
    expect(trigger().hidden).toBe(true);
  });

  it("expands and collapses, syncing aria-expanded and data-state", async () => {
    await start(true);
    trigger().click();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(content().getAttribute("data-state")).toBe("expanded");
    // The toggle stays visible while expanded so the user can collapse again.
    expect(trigger().hidden).toBe(false);

    trigger().click();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(content().getAttribute("data-state")).toBe("collapsed");
  });

  it("stays expanded on reconnect when the restored DOM reads expanded (DOM wins over Value)", async () => {
    // Simulate a Turbo cache restore: the cached snapshot already reads expanded
    // (data-state="expanded", aria-expanded="true") even though the declarative
    // collapsed Value defaults to true. The DOM must win — connect must not
    // re-clamp text the user had expanded.
    document.body.innerHTML = `
      <div data-controller="stimeo--read-more">
        <p id="bio" data-stimeo--read-more-target="content" data-state="expanded">
          A long biography that may or may not exceed its clamp.
        </p>
        <button data-stimeo--read-more-target="trigger"
                data-action="stimeo--read-more#toggle"
                aria-expanded="true" aria-controls="bio">Read more</button>
      </div>`;
    stubOverflow(byId("bio"), true);
    application = Application.start();
    application.register("stimeo--read-more", ReadMoreController);
    await tick();

    expect(content().getAttribute("data-state")).toBe("expanded");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().hidden).toBe(false);
  });

  it("stays collapsed on reconnect when the DOM reads collapsed (DOM wins over collapsed=false)", async () => {
    // Mirror case: an initially-expanded config (collapsed=false) must NOT re-expand
    // text the user had collapsed before a Turbo cache restore (explicit
    // data-state="collapsed"). The DOM wins over the disagreeing Value.
    document.body.innerHTML = `
      <div data-controller="stimeo--read-more" data-stimeo--read-more-collapsed-value="false">
        <p id="bio" data-stimeo--read-more-target="content" data-state="collapsed">
          A long biography that may or may not exceed its clamp.
        </p>
        <button data-stimeo--read-more-target="trigger"
                data-action="stimeo--read-more#toggle"
                aria-expanded="false" aria-controls="bio">Read more</button>
      </div>`;
    stubOverflow(byId("bio"), true);
    application = Application.start();
    application.register("stimeo--read-more", ReadMoreController);
    await tick();

    expect(content().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("has no machine-detectable a11y violations in either state", async () => {
    await start(true);
    const noRegion = { rules: { region: { enabled: false } } };
    await expectNoA11yViolations(document.body, noRegion);
    trigger().click();
    await expectNoA11yViolations(document.body, noRegion);
  });

  it("announces the toggle's expanded state and flips it on toggle", async () => {
    await start(true);
    const before = await captureSpeech({ container: trigger(), steps: 0 });
    expect(before).toEqual(["button, Read more, not expanded"]);

    trigger().click();
    const after = await captureSpeech({ container: trigger(), steps: 0 });
    expect(after).toEqual(["button, Read more, expanded"]);
  });

  it("becomes inert after disconnect", async () => {
    await start(true);
    application.stop();
    trigger().click();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("is a safe no-op when the content/trigger targets are absent", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--read-more"></div>`;
    application = Application.start();
    application.register("stimeo--read-more", ReadMoreController);
    await tick();

    const host = query("[data-controller='stimeo--read-more']");
    const instance = application.getControllerForElementAndIdentifier(
      host,
      "stimeo--read-more",
    ) as ReadMoreController;
    expect(() => instance.toggle()).not.toThrow();
  });
});
