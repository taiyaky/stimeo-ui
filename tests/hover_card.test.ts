import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoverCardController } from "../src/controllers/hover_card_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link HoverCardController}: delayed open/close on
 * hover/focus, the hoverable bridge, the focus re-check that keeps the card open
 * while a link inside it is focused, document-level Escape dismissal, and timer
 * teardown. Delays use the default 300/200 ms driven by a mocked clock.
 */
describe("HoverCardController", () => {
  let application: Application;

  const start = async (values = "") => {
    document.body.innerHTML = `
      <main>
        <span data-controller="stimeo--hover-card" ${values}>
          <a href="/users/jane" data-stimeo--hover-card-target="trigger"
             aria-expanded="false" aria-controls="hc"
             data-action="mouseenter->stimeo--hover-card#open
                          mouseleave->stimeo--hover-card#close
                          focusin->stimeo--hover-card#open
                          focusout->stimeo--hover-card#close
                          keydown->stimeo--hover-card#onKeydown">@jane</a>
          <div id="hc" data-stimeo--hover-card-target="card"
               data-action="mouseenter->stimeo--hover-card#open
                            mouseleave->stimeo--hover-card#close" hidden>
            <a id="follow" href="/users/jane/follow">Follow</a>
          </div>
        </span>
      </main>`;
    application = Application.start();
    application.register("stimeo--hover-card", HoverCardController);
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

  const trigger = () => query<HTMLAnchorElement>("[data-stimeo--hover-card-target='trigger']");
  const card = () => query("#hc");
  const fire = (el: Element, type: string) =>
    el.dispatchEvent(new MouseEvent(type, { bubbles: true }));

  it("starts closed with collapsed ARIA and data-state", () => {
    expect(card().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(card().getAttribute("data-state")).toBe("closed");
  });

  it("opens after openDelay on mouseenter and syncs ARIA", () => {
    fire(trigger(), "mouseenter");
    expect(card().hidden).toBe(true); // still within the 300ms delay
    vi.advanceTimersByTime(300);
    expect(card().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(card().getAttribute("data-state")).toBe("open");
  });

  it("closes after closeDelay on mouseleave", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    fire(trigger(), "mouseleave");
    vi.advanceTimersByTime(199);
    expect(card().hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(card().hidden).toBe(true);
  });

  it("keeps the card open when the pointer bridges into it (hoverable)", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    fire(trigger(), "mouseleave"); // schedules close
    vi.advanceTimersByTime(100);
    fire(card(), "mouseenter"); // cancels the pending close
    vi.advanceTimersByTime(300);
    expect(card().hidden).toBe(false);
  });

  it("does not open if the pointer leaves before openDelay elapses", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(100);
    fire(trigger(), "mouseleave");
    vi.advanceTimersByTime(500);
    expect(card().hidden).toBe(true);
  });

  it("stays open while focus is on a link inside the card", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    // Focus moves into the card; the trigger's focusout schedules a close…
    query<HTMLAnchorElement>("#follow").focus();
    trigger().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    vi.advanceTimersByTime(300);
    // …but the delayed close re-checks focus and aborts because it is inside.
    expect(card().hidden).toBe(false);
  });

  it("dismisses on Escape at the document level regardless of focus", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("does not dismiss on scroll unless closeOnScroll is set", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    expect(card().hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(card().hidden).toBe(false);
  });

  it("dismisses on window scroll when closeOnScroll is set", async () => {
    application.stop();
    await start('data-stimeo--hover-card-close-on-scroll-value="true"');
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    expect(card().hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(card().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("dismisses on a scrollable ancestor's scroll when closeOnScroll is set", async () => {
    application.stop();
    document.body.innerHTML = `
      <div id="timeline" style="overflow:auto; height:120px">
        <span data-controller="stimeo--hover-card"
              data-stimeo--hover-card-close-on-scroll-value="true">
          <a href="/u" data-stimeo--hover-card-target="trigger" aria-expanded="false"
             data-action="mouseenter->stimeo--hover-card#open">@x</a>
          <div data-stimeo--hover-card-target="card" hidden>card</div>
        </span>
      </div>`;
    application = Application.start();
    application.register("stimeo--hover-card", HoverCardController);
    await vi.advanceTimersByTimeAsync(0);
    const pane = query("#timeline");
    const inner = query<HTMLElement>("[data-stimeo--hover-card-target='card']");
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    expect(inner.hidden).toBe(false);
    pane.dispatchEvent(new Event("scroll"));
    expect(inner.hidden).toBe(true);
  });

  it("clears timers and the Escape listener on disconnect", () => {
    fire(trigger(), "mouseenter");
    const instance = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--hover-card']"),
      "stimeo--hover-card",
    ) as HoverCardController;
    instance.disconnect();
    vi.advanceTimersByTime(500);
    expect(card().hidden).toBe(true);
  });
});

describe("HoverCardController accessibility", () => {
  let application: Application;

  const startReal = async () => {
    document.body.innerHTML = `
      <main>
        <span data-controller="stimeo--hover-card"
              data-stimeo--hover-card-open-delay-value="0">
          <a href="/users/jane" data-stimeo--hover-card-target="trigger"
             aria-expanded="false" aria-controls="hc2"
             data-action="mouseenter->stimeo--hover-card#open">@jane</a>
          <div id="hc2" data-stimeo--hover-card-target="card" hidden>
            <p>Jane Doe — Designer</p>
            <a href="/users/jane/follow">Follow</a>
          </div>
        </span>
      </main>`;
    application = Application.start();
    application.register("stimeo--hover-card", HoverCardController);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("has no machine-detectable a11y violations when open", async () => {
    await startReal();
    query<HTMLAnchorElement>("[data-stimeo--hover-card-target='trigger']").dispatchEvent(
      new MouseEvent("mouseenter", { bubbles: true }),
    );
    await expectNoA11yViolations(document.body);
  });

  it("announces the trigger's expanded state", async () => {
    await startReal();
    query<HTMLAnchorElement>("[data-stimeo--hover-card-target='trigger']").dispatchEvent(
      new MouseEvent("mouseenter", { bubbles: true }),
    );
    const spoken = await captureSpeech({ container: query("main"), steps: 1 });
    // Freeze the whole ordered array (not a name-only `toContain`): the trigger must
    // keep its link role, name, and the expanded state once the card opens.
    expect(spoken).toEqual(["main", "link, @jane, 1 control, expanded"]);
  });
});
