import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadMoreController } from "../src/controllers/read_more_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { byId, query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
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

/** A ResizeObserver double that records what it observes and notifies on demand. */
class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;
  readonly #callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
  }

  disconnect(): void {
    this.observed.clear();
    this.disconnected = true;
  }

  /** Notifies a resize of `element` while it is still observed. */
  resize(element: Element): void {
    if (this.observed.has(element)) this.#callback([], this);
  }
}

/** Reports a box resize of `element` through every observer created so far. */
function resizeBox(element: Element): void {
  for (const observer of FakeResizeObserver.instances) observer.resize(element);
}

describe("ReadMoreController", () => {
  let application: Application | undefined;

  const start = async (
    overflowing: boolean,
    options: {
      state?: "collapsed" | "expanded" | null;
      collapsedValue?: boolean;
      contentHtml?: string;
      triggerHtml?: string;
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
                aria-expanded="${ariaExpanded}" aria-controls="bio" hidden>${
                  options.triggerHtml ?? "Read more"
                }</button>
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
    vi.unstubAllGlobals();
    FakeResizeObserver.instances = [];
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

  it("hides the trigger once it blurs after collapsing text that fits", async () => {
    await start(false, { state: "expanded" });
    const button = trigger();
    button.focus();

    button.click();
    expect(content().getAttribute("data-state")).toBe("collapsed");
    expect(button.hidden).toBe(false);

    button.blur();
    expect(button.hidden).toBe(true);
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

  it("reads the collapsed Value at connect only and keeps the DOM state over a later declaration", async () => {
    await start(true, { state: null, collapsedValue: false });
    const host = query("[data-controller='stimeo--read-more']");
    const reconnect = async () => {
      host.remove();
      await tick();
      document.body.append(host);
      await tick();
    };
    const events = captureStateEvents("stimeo--read-more");
    expect(content().getAttribute("data-state")).toBe("expanded");

    // A declaration rewritten after connect does not move the state, and a reconnect
    // keeps what the DOM shows rather than the new declaration.
    host.setAttribute("data-stimeo--read-more-collapsed-value", "true");
    await tick();
    expect(content().getAttribute("data-state")).toBe("expanded");
    await reconnect();
    expect(content().getAttribute("data-state")).toBe("expanded");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    trigger().click();
    host.setAttribute("data-stimeo--read-more-collapsed-value", "false");
    await tick();
    expect(content().getAttribute("data-state")).toBe("collapsed");
    await reconnect();
    expect(content().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    // Only the user's collapse moved the state.
    expect(events.names()).toEqual(["close"]);
    events.stop();
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

  it("synchronizes a content target that arrives alone after connect", async () => {
    document.body.innerHTML = `
      <div id="host" data-controller="stimeo--read-more">
        <button data-stimeo--read-more-target="trigger"
                data-action="stimeo--read-more#toggle"
                aria-expanded="false" hidden>Read more</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--read-more", ReadMoreController);
    await tick();
    expect(trigger().hidden).toBe(true);

    const addedContent = document.createElement("p");
    addedContent.setAttribute("data-stimeo--read-more-target", "content");
    addedContent.setAttribute("data-state", "expanded");
    stubOverflow(addedContent, true);
    byId("host").append(addedContent);
    await tick();

    expect(addedContent.getAttribute("data-state")).toBe("collapsed");
    expect(trigger().hidden).toBe(false);
  });

  it("synchronizes a trigger target that arrives alone after connect", async () => {
    document.body.innerHTML = `
      <div id="host" data-controller="stimeo--read-more">
        <p id="bio" data-stimeo--read-more-target="content" data-state="collapsed">
          A long biography that exceeds its clamp.
        </p>
      </div>`;
    stubOverflow(byId("bio"), true);
    application = Application.start();
    application.register("stimeo--read-more", ReadMoreController);
    await tick();

    const addedTrigger = document.createElement("button");
    addedTrigger.setAttribute("data-stimeo--read-more-target", "trigger");
    addedTrigger.setAttribute("data-action", "stimeo--read-more#toggle");
    addedTrigger.setAttribute("aria-expanded", "true");
    addedTrigger.hidden = true;
    byId("host").append(addedTrigger);
    await tick();

    expect(addedTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(addedTrigger.hidden).toBe(false);
  });

  it("synchronizes a trigger that stays after an earlier one leaves", async () => {
    await start(true);
    const original = trigger();
    original.click();
    const successor = original.cloneNode(true) as HTMLButtonElement;
    successor.setAttribute("aria-expanded", "false");
    successor.hidden = true;
    original.after(successor);
    await tick();
    original.remove();
    await tick();

    expect(trigger()).toBe(successor);
    expect(successor.getAttribute("aria-expanded")).toBe("true");
    expect(successor.hidden).toBe(false);
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

  const controller = () =>
    application?.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--read-more']"),
      "stimeo--read-more",
    ) as ReadMoreController;

  it("ignores a toggle called on a disconnected instance", async () => {
    await start(true);
    const instance = controller();
    const events = captureStateEvents("stimeo--read-more");
    instance.disconnect();

    instance.toggle();

    expect(content().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(events.seen).toEqual([]);
    events.stop();
  });

  it("keeps one content observation while a sync leaves the content target in place", async () => {
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    await start(true);
    const onContent = () => observe.mock.calls.filter(([target]) => target === content()).length;
    expect(onContent()).toBe(1);

    controller().triggerTargetConnected();
    controller().contentTargetConnected();

    expect(onContent()).toBe(1);
    observe.mockRestore();
  });

  it("stops observing when the content target leaves while connected", async () => {
    await start(true);
    const leaving = content();
    leaving.remove();

    expect(() => controller().contentTargetDisconnected()).not.toThrow();

    // Nothing is observed any more: the detached text and a resize leave the trigger alone.
    stubOverflow(leaving, false);
    leaving.textContent = "Detached";
    window.dispatchEvent(new Event("resize"));
    await tick();
    expect(trigger().hidden).toBe(false);
  });

  it("releases the viewport and load listeners when the content target leaves while connected", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    try {
      await start(true);
      const onResize = added.mock.calls.find(([type]) => type === "resize")?.[1];
      expect(onResize).toBeDefined();
      const leaving = content();
      const removedFromContent = vi.spyOn(leaving, "removeEventListener");

      leaving.remove();
      await tick();

      expect(removed).toHaveBeenCalledWith("resize", onResize);
      expect(removedFromContent).toHaveBeenCalledWith("load", expect.any(Function), true);
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
  });

  it("keeps re-evaluating on viewport resizes after disconnect and connect", async () => {
    await start(true);
    const instance = controller();
    instance.disconnect();
    instance.connect();

    stubOverflow(content(), false);
    window.dispatchEvent(new Event("resize"));

    expect(trigger().hidden).toBe(true);
  });

  describe("content box", () => {
    it("re-evaluates overflow when the content box resizes", async () => {
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);
      await start(false);
      expect(trigger().hidden).toBe(true);

      stubOverflow(content(), true);
      resizeBox(content());

      expect(trigger().hidden).toBe(false);
    });

    it("stops watching the box of a replaced content target", async () => {
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);
      await start(true);
      const oldContent = content();
      const replacement = document.createElement("p");
      replacement.setAttribute("data-stimeo--read-more-target", "content");
      stubOverflow(replacement, false);
      oldContent.replaceWith(replacement);
      await tick();
      expect(trigger().hidden).toBe(true);

      stubOverflow(replacement, true);
      resizeBox(oldContent);
      expect(trigger().hidden).toBe(true);

      resizeBox(replacement);
      expect(trigger().hidden).toBe(false);
    });

    it("disconnects its ResizeObserver on disconnect", async () => {
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);
      await start(true);
      const [observer] = FakeResizeObserver.instances;
      expect(observer?.observed.has(content())).toBe(true);

      controller().disconnect();

      expect(observer?.disconnected).toBe(true);
    });
  });

  describe("deferred hide", () => {
    /** Focuses the trigger and makes the text fit, so hiding the trigger waits for its blur. */
    const deferHide = async () => {
      await start(true);
      const button = trigger();
      const added = vi.spyOn(button, "addEventListener");
      const removed = vi.spyOn(button, "removeEventListener");
      button.focus();
      stubOverflow(content(), false);
      window.dispatchEvent(new Event("resize"));
      expect(button.hidden).toBe(false);
      const onBlur = added.mock.calls.find(([type]) => type === "blur")?.[1];
      expect(onBlur).toBeDefined();
      return { button, onBlur, removed };
    };

    it("stops waiting for the blur once overflow returns", async () => {
      const { button, onBlur, removed } = await deferHide();

      stubOverflow(content(), true);
      window.dispatchEvent(new Event("resize"));

      expect(button.hidden).toBe(false);
      expect(removed).toHaveBeenCalledWith("blur", onBlur);
    });

    it("stops waiting for the blur of a focused trigger that leaves", async () => {
      const { button, onBlur, removed } = await deferHide();

      button.remove();
      await tick();

      expect(removed).toHaveBeenCalledWith("blur", onBlur);
    });

    it("stops waiting for the blur on disconnect", async () => {
      const { onBlur, removed } = await deferHide();

      controller().disconnect();

      expect(removed).toHaveBeenCalledWith("blur", onBlur);
    });

    it("hides a trigger that lost focus without a blur at the next evaluation", async () => {
      // A focused control that becomes disabled loses focus with no blur event.
      const { button, onBlur, removed } = await deferHide();
      button.setAttribute("disabled", "");
      const elsewhere = document.createElement("button");
      document.body.append(elsewhere);
      elsewhere.focus();
      expect(document.activeElement).toBe(elsewhere);

      window.dispatchEvent(new Event("resize"));

      expect(button.hidden).toBe(true);
      expect(removed).toHaveBeenCalledWith("blur", onBlur);
    });
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

  // --- Trigger labels ---

  describe("trigger labels", () => {
    const expandedLabel = (root: ParentNode = document) =>
      query("[data-stimeo--read-more-target='expandedLabel']", root);
    const collapsedLabel = (root: ParentNode = document) =>
      query("[data-stimeo--read-more-target='collapsedLabel']", root);
    /** The visibility of both halves of the pair inside the single trigger. */
    const labelVisibility = () => ({
      expanded: expandedLabel().hidden,
      collapsed: collapsedLabel().hidden,
    });

    it("shows the half that belongs to the state and hides the other, both ways", async () => {
      await start(true, {
        triggerHtml: `
          <span data-stimeo--read-more-target="collapsedLabel">Read more</span>
          <span data-stimeo--read-more-target="expandedLabel" hidden>Read less</span>`,
      });

      expect(labelVisibility()).toEqual({ expanded: true, collapsed: false });

      trigger().click();
      expect(labelVisibility()).toEqual({ expanded: false, collapsed: true });

      trigger().click();
      expect(labelVisibility()).toEqual({ expanded: true, collapsed: false });
    });

    it("overrides the authored visibility that contradicts the state, silently", async () => {
      // Which half shows is a pure function of the state, so the first reflection
      // settles it rather than reading the authored `hidden` back. Settling the
      // halves is not a move of the state, so the baseline connection says nothing.
      const capture = captureStateEvents("stimeo--read-more");
      await start(true, {
        state: "collapsed",
        triggerHtml: `
          <span data-stimeo--read-more-target="collapsedLabel" hidden>Read more</span>
          <span data-stimeo--read-more-target="expandedLabel">Read less</span>`,
      });

      expect(labelVisibility()).toEqual({ expanded: true, collapsed: false });
      expect(capture.seen).toEqual([]);
      capture.stop();
    });

    it("leaves a lone half as authored while a complete pair elsewhere moves", async () => {
      document.body.innerHTML = `
        <div data-controller="stimeo--read-more">
          <p id="paired-bio" data-stimeo--read-more-target="content" data-state="collapsed">
            A long biography that exceeds its clamp.
          </p>
          <button id="paired" data-stimeo--read-more-target="trigger"
                  data-action="stimeo--read-more#toggle"
                  aria-expanded="false" aria-controls="paired-bio">
            <span data-stimeo--read-more-target="collapsedLabel" hidden>Read more</span>
            <span data-stimeo--read-more-target="expandedLabel">Read less</span>
          </button>
        </div>
        <div data-controller="stimeo--read-more">
          <p id="lone-bio" data-stimeo--read-more-target="content" data-state="collapsed">
            Another long biography that exceeds its clamp.
          </p>
          <button id="lone" data-stimeo--read-more-target="trigger"
                  data-action="stimeo--read-more#toggle"
                  aria-expanded="false" aria-controls="lone-bio">
            <span data-stimeo--read-more-target="expandedLabel">Read less</span>
          </button>
        </div>`;
      stubOverflow(byId("paired-bio"), true);
      stubOverflow(byId("lone-bio"), true);
      application = Application.start();
      application.register("stimeo--read-more", ReadMoreController);
      await tick();

      expect(expandedLabel(byId("paired")).hidden).toBe(true);
      expect(collapsedLabel(byId("paired")).hidden).toBe(false);
      // A half with no counterpart inside its own trigger keeps what the author wrote:
      // hiding it would take the trigger's only label with it.
      expect(expandedLabel(byId("lone")).hidden).toBe(false);
    });

    it("reflects a half that arrives after connect", async () => {
      await start(true, {
        triggerHtml: `<span data-stimeo--read-more-target="collapsedLabel" hidden>Read more</span>`,
      });
      expect(collapsedLabel().hidden).toBe(true);

      const late = document.createElement("span");
      late.setAttribute("data-stimeo--read-more-target", "expandedLabel");
      late.textContent = "Read less";
      trigger().append(late);
      await tick();

      expect(labelVisibility()).toEqual({ expanded: true, collapsed: false });
    });

    it("settles the pair when the collapsed half arrives after connect", async () => {
      await start(true, {
        triggerHtml: `<span data-stimeo--read-more-target="expandedLabel">Read less</span>`,
      });
      // The pair is incomplete, so the lone half keeps what the author wrote.
      expect(expandedLabel().hidden).toBe(false);

      const late = document.createElement("span");
      late.setAttribute("data-stimeo--read-more-target", "collapsedLabel");
      late.hidden = true;
      late.textContent = "Read more";
      trigger().append(late);
      await tick();

      expect(labelVisibility()).toEqual({ expanded: true, collapsed: false });
    });
  });

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--read-more");
    });

    afterEach(() => {
      capture.stop();
    });

    it("reports a trigger click as user, after the state attributes are written", async () => {
      await start(true);
      const states: string[] = [];
      query("[data-controller='stimeo--read-more']").addEventListener(
        "stimeo--read-more:open",
        () => {
          states.push(
            `${content().getAttribute("data-state")} ${trigger().getAttribute("aria-expanded")}`,
          );
        },
      );

      trigger().click();

      expect(capture.names()).toEqual(["open"]);
      expect(capture.reasons()).toEqual(["user"]);
      expect(states).toEqual(["expanded true"]);
      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);

      trigger().click();
      expect(capture.names()).toEqual(["open", "close"]);
    });

    it("stays silent while connect establishes the baseline", async () => {
      const fresh = captureStateEvents("stimeo--read-more");
      await start(true, { state: "expanded" });

      expect(content().getAttribute("data-state")).toBe("expanded");
      expect(fresh.seen).toEqual([]);
      fresh.stop();
    });

    it("stays silent while a resize re-evaluates the overflow", async () => {
      await start(true);
      trigger().click();
      capture.clear();

      window.dispatchEvent(new Event("resize"));
      await tick();

      expect(capture.seen).toEqual([]);
    });
  });
});
