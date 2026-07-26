import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ReadMoreController } from "../src/controllers/read_more_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { byId, query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ReadMoreController}: the borrowed Disclosure
 * convention (`aria-expanded` + `data-state`) and the overflow-detection that
 * hides the toggle when the text is not actually clamped.
 *
 * happy-dom returns 0 for `scrollHeight` / `clientHeight`, so overflow is
 * simulated by stubbing those getters on the content element.
 */

/** Stubs the content box so `scrollHeight > clientHeight` reflects `overflowing`. */
function stubOverflow(element: HTMLElement, overflowing: boolean): void {
  Object.defineProperty(element, "scrollHeight", {
    value: overflowing ? 200 : 50,
    configurable: true,
  });
  Object.defineProperty(element, "clientHeight", { value: 50, configurable: true });
}

describe("ReadMoreController", () => {
  let application: Application | undefined;

  const start = async (
    overflowing: boolean,
    options: {
      state?: "collapsed" | "expanded" | null;
      collapsedValue?: boolean;
      contentHtml?: string;
    } = {},
  ) => {
    const state = options.state === undefined ? "collapsed" : options.state;
    const stateAttribute = state ? `data-state="${state}"` : "";
    const valueAttribute =
      options.collapsedValue === undefined
        ? ""
        : `data-stimeo--read-more-collapsed-value="${String(options.collapsedValue)}"`;
    const ariaExpanded = state === "expanded" ? "true" : "false";
    document.body.innerHTML = `
      <div data-controller="stimeo--read-more" ${valueAttribute}>
        <p id="bio" data-stimeo--read-more-target="content" ${stateAttribute}>
          ${options.contentHtml ?? "A long biography that may or may not exceed its clamp."}
        </p>
        <button data-stimeo--read-more-target="trigger"
                data-action="stimeo--read-more#toggle"
                aria-expanded="${ariaExpanded}" aria-controls="bio" hidden>Read more</button>
      </div>`;
    stubOverflow(byId("bio"), overflowing);
    application = Application.start();
    application.register("stimeo--read-more", ReadMoreController);
    await tick();
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
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

  it("keeps the trigger visible while expanded even when the text does not overflow", async () => {
    await start(false, { state: "expanded" });

    expect(content().getAttribute("data-state")).toBe("expanded");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().hidden).toBe(false);
  });

  it("seeds a fresh render as collapsed from the default Value", async () => {
    await start(true, { state: null });

    expect(content().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("seeds a fresh render as expanded from collapsed=false", async () => {
    await start(false, { state: null, collapsedValue: false });

    expect(content().getAttribute("data-state")).toBe("expanded");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().hidden).toBe(false);
  });

  it("stays expanded on reconnect when the restored DOM reads expanded (DOM wins over Value)", async () => {
    await start(true, { state: "expanded" });

    expect(content().getAttribute("data-state")).toBe("expanded");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().hidden).toBe(false);
  });

  it("stays collapsed on reconnect when the DOM reads collapsed (DOM wins over collapsed=false)", async () => {
    await start(true, { state: "collapsed", collapsedValue: false });

    expect(content().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("defers hiding a focused trigger until it blurs", async () => {
    await start(true);
    const button = trigger();
    button.focus();
    expect(document.activeElement).toBe(button);

    stubOverflow(content(), false);
    window.dispatchEvent(new Event("resize"));

    expect(button.hidden).toBe(false);
    expect(document.activeElement).toBe(button);

    button.blur();
    expect(button.hidden).toBe(true);
  });

  it("cancels a deferred hide when overflow returns before blur", async () => {
    await start(true);
    const button = trigger();
    button.focus();
    stubOverflow(content(), false);
    window.dispatchEvent(new Event("resize"));
    expect(button.hidden).toBe(false);

    stubOverflow(content(), true);
    window.dispatchEvent(new Event("resize"));
    button.blur();

    expect(button.hidden).toBe(false);
  });

  it("cancels a deferred hide when the user expands before blur", async () => {
    await start(true);
    const button = trigger();
    button.focus();
    stubOverflow(content(), false);
    window.dispatchEvent(new Event("resize"));

    button.click();
    button.blur();

    expect(content().getAttribute("data-state")).toBe("expanded");
    expect(button.hidden).toBe(false);
  });

  it("re-evaluates same-box overflow after content mutations", async () => {
    await start(false);
    expect(trigger().hidden).toBe(true);

    stubOverflow(content(), true);
    content().textContent = "A longer biography inserted by a Turbo Stream.";
    await tick();
    expect(trigger().hidden).toBe(false);

    stubOverflow(content(), false);
    content().textContent = "Short.";
    await tick();
    expect(trigger().hidden).toBe(true);
  });

  it("re-evaluates overflow when descendant media loads", async () => {
    await start(false, { contentHtml: `<img id="portrait" alt="" /> Biography.` });
    expect(trigger().hidden).toBe(true);

    stubOverflow(content(), true);
    byId("portrait").dispatchEvent(new Event("load"));

    expect(trigger().hidden).toBe(false);
  });

  it("re-evaluates overflow on viewport resize", async () => {
    await start(false);
    expect(trigger().hidden).toBe(true);

    stubOverflow(content(), true);
    window.dispatchEvent(new Event("resize"));
    expect(trigger().hidden).toBe(false);

    stubOverflow(content(), false);
    window.dispatchEvent(new Event("resize"));
    expect(trigger().hidden).toBe(true);
  });

  it("synchronizes targets added after connect from the retained logical state", async () => {
    document.body.innerHTML = `
      <div id="host" data-controller="stimeo--read-more"
           data-stimeo--read-more-collapsed-value="false"></div>`;
    application = Application.start();
    application.register("stimeo--read-more", ReadMoreController);
    await tick();

    const addedContent = document.createElement("p");
    addedContent.id = "late-content";
    addedContent.setAttribute("data-stimeo--read-more-target", "content");
    addedContent.setAttribute("data-state", "collapsed");
    stubOverflow(addedContent, false);
    const addedTrigger = document.createElement("button");
    addedTrigger.setAttribute("data-stimeo--read-more-target", "trigger");
    addedTrigger.setAttribute("data-action", "stimeo--read-more#toggle");
    addedTrigger.setAttribute("aria-expanded", "false");
    addedTrigger.hidden = true;
    byId("host").append(addedContent, addedTrigger);
    await tick();

    expect(addedContent.getAttribute("data-state")).toBe("expanded");
    expect(addedTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(addedTrigger.hidden).toBe(false);
  });

  it("rebinds content observation after target replacement and ignores the old target", async () => {
    await start(true);
    const oldContent = content();
    const replacement = document.createElement("p");
    replacement.id = "replacement";
    replacement.setAttribute("data-stimeo--read-more-target", "content");
    replacement.setAttribute("data-state", "expanded");
    stubOverflow(replacement, false);

    oldContent.replaceWith(replacement);
    await tick();

    expect(replacement.getAttribute("data-state")).toBe("collapsed");
    expect(trigger().hidden).toBe(true);

    stubOverflow(replacement, true);
    oldContent.textContent = "Detached content must no longer drive the controller.";
    await tick();
    expect(trigger().hidden).toBe(true);

    replacement.textContent = "The replacement now overflows.";
    await tick();
    expect(trigger().hidden).toBe(false);
  });

  it("clears a deferred hide when the trigger target is replaced", async () => {
    await start(true);
    const oldTrigger = trigger();
    oldTrigger.focus();
    stubOverflow(content(), false);
    window.dispatchEvent(new Event("resize"));
    expect(oldTrigger.hidden).toBe(false);

    const replacement = document.createElement("button");
    replacement.setAttribute("data-stimeo--read-more-target", "trigger");
    replacement.setAttribute("data-action", "stimeo--read-more#toggle");
    oldTrigger.replaceWith(replacement);
    await tick();
    expect(replacement.hidden).toBe(true);

    replacement.hidden = false;
    oldTrigger.dispatchEvent(new FocusEvent("blur"));
    expect(replacement.hidden).toBe(false);
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

  it("releases resize, mutation, load, and deferred-focus work after disconnect", async () => {
    await start(true);
    const button = trigger();
    button.focus();
    stubOverflow(content(), false);
    window.dispatchEvent(new Event("resize"));
    expect(button.hidden).toBe(false);

    application?.unload("stimeo--read-more");
    content().textContent = "Short after disconnect.";
    content().dispatchEvent(new Event("load"));
    window.dispatchEvent(new Event("resize"));
    button.blur();
    await tick();

    expect(button.hidden).toBe(false);
    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("false");
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
