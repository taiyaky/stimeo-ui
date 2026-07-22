import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoverCardController } from "../src/controllers/hover_card_controller";
import { EscapeLayer } from "../src/utils/escape_layer";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link HoverCardController}: delayed open/close on
 * hover/focus, pointer and focus bridges, document-level Escape dismissal,
 * lifecycle teardown/reconnect, and independent instances. Delays use the
 * default 300/200 ms driven by a mocked clock.
 */
describe("HoverCardController", () => {
  let application: Application;

  const boot = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--hover-card", HoverCardController);
    await vi.advanceTimersByTimeAsync(0);
  };

  const start = async (values = "") =>
    boot(`
      <main>
        <span data-controller="stimeo--hover-card" ${values}>
          <a href="/users/jane" data-stimeo--hover-card-target="trigger"
             aria-expanded="false" aria-controls="hc"
             data-action="mouseenter->stimeo--hover-card#open
                          mouseleave->stimeo--hover-card#close
                          focusin->stimeo--hover-card#open
                          focusout->stimeo--hover-card#close">@jane</a>
          <div id="hc" data-stimeo--hover-card-target="card"
               data-action="mouseenter->stimeo--hover-card#open
                            mouseleave->stimeo--hover-card#close
                            focusin->stimeo--hover-card#open
                            focusout->stimeo--hover-card#close" hidden>
            <a id="follow" href="/users/jane/follow">Follow</a>
          </div>
        </span>
        <button id="outside" type="button">Outside</button>
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

  const trigger = () => query<HTMLAnchorElement>("[data-stimeo--hover-card-target='trigger']");
  const card = () => query("#hc");
  const root = () => query<HTMLElement>("[data-controller='stimeo--hover-card']");
  const outside = () => query<HTMLButtonElement>("#outside");
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--hover-card",
    ) as HoverCardController;
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

  it("opens after openDelay on focusin", () => {
    trigger().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    vi.advanceTimersByTime(299);
    expect(card().hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(card().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("closes after closeDelay on mouseleave", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    fire(trigger(), "mouseleave");
    vi.advanceTimersByTime(199);
    expect(card().hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(card().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(card().getAttribute("data-state")).toBe("closed");
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

  it("stays open when a delayed close sees focus inside the card", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    query<HTMLAnchorElement>("#follow").focus();
    controller().close();
    vi.advanceTimersByTime(200);
    expect(card().hidden).toBe(false);
  });

  it("closes after focus leaves the card", () => {
    trigger().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    vi.advanceTimersByTime(300);
    const follow = query<HTMLAnchorElement>("#follow");
    follow.focus();
    follow.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    outside().focus();
    follow.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside() }));
    vi.advanceTimersByTime(199);
    expect(card().hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(card().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape pressed on the trigger, consuming the press", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    trigger().focus();
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    trigger().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(card().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("dismisses on Escape at the document level regardless of focus", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    outside().focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("yields the press to a newer document layer even with focus on the trigger", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    trigger().focus();

    // A layer shown after this card owns the press: the shared resolver
    // dismisses the newest layer, never the stale card under focus.
    let aboveDismissed = 0;
    const above = new EscapeLayer();
    above.activate(document, { onDismiss: () => aboveDismissed++ });
    const first = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    trigger().dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(aboveDismissed).toBe(1);
    expect(card().hidden).toBe(false);

    above.deactivate();
    const second = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    trigger().dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);
    expect(card().hidden).toBe(true);
  });

  it("ignores an Escape already handled by an inner layer", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    // The layered-Escape contract: a consumed press closes at most one layer.
    expect(card().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    const handledOnTrigger = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handledOnTrigger.preventDefault();
    trigger().dispatchEvent(handledOnTrigger);
    expect(card().hidden).toBe(false);
  });

  it("does not dismiss on scroll unless closeOnScroll is set", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    expect(card().hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(card().hidden).toBe(false);
  });

  it("dismisses on window scroll when closeOnScroll is set", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--hover-card-close-on-scroll-value="true"');
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    expect(card().hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(card().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("dismisses on a scrollable ancestor's scroll when closeOnScroll is set", async () => {
    disconnectAndStopApplication(application);
    await boot(`
      <div id="timeline" style="overflow:auto; height:120px">
        <span data-controller="stimeo--hover-card"
              data-stimeo--hover-card-close-on-scroll-value="true">
          <a href="/u" data-stimeo--hover-card-target="trigger" aria-expanded="false"
             data-action="mouseenter->stimeo--hover-card#open">@x</a>
          <div data-stimeo--hover-card-target="card" hidden>card</div>
        </span>
      </div>`);
    const pane = query("#timeline");
    const inner = query<HTMLElement>("[data-stimeo--hover-card-target='card']");
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    expect(inner.hidden).toBe(false);
    pane.dispatchEvent(new Event("scroll"));
    expect(inner.hidden).toBe(true);
  });

  it("clears a pending open timer on disconnect", () => {
    fire(trigger(), "mouseenter");
    controller().disconnect();
    vi.advanceTimersByTime(500);
    expect(card().hidden).toBe(true);
  });

  it("clears a pending close timer on disconnect", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    fire(trigger(), "mouseleave");
    controller().disconnect();
    vi.advanceTimersByTime(200);
    expect(card().hidden).toBe(false);
  });

  it("removes the document Escape listener on disconnect while open", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    controller().disconnect();
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(card().hidden).toBe(false);
  });

  it("removes closeOnScroll listeners on disconnect while open", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--hover-card-close-on-scroll-value="true"');
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    controller().disconnect();
    window.dispatchEvent(new Event("scroll"));
    expect(card().hidden).toBe(false);
  });

  it("opens on the first interaction after same-instance reconnect", () => {
    fire(trigger(), "mouseenter");
    controller().disconnect();
    controller().connect();
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    expect(card().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("cleans up listeners and collapsed ARIA when the card target was removed", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--hover-card-close-on-scroll-value="true"');
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    const detachedCard = card();
    detachedCard.remove();

    const firstEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    document.dispatchEvent(firstEscape);
    expect(firstEscape.defaultPrevented).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    root().append(detachedCard);
    detachedCard.hidden = false;
    window.dispatchEvent(new Event("scroll"));
    expect(detachedCard.hidden).toBe(false);
    const secondEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    document.dispatchEvent(secondEscape);
    expect(secondEscape.defaultPrevented).toBe(false);
  });

  it("keeps multiple instances independent", async () => {
    disconnectAndStopApplication(application);
    await boot(`
      <main>
        <span id="first" data-controller="stimeo--hover-card">
          <a data-stimeo--hover-card-target="trigger" aria-expanded="false"
             data-action="mouseenter->stimeo--hover-card#open">First</a>
          <div id="first-card" data-stimeo--hover-card-target="card" hidden>First card</div>
        </span>
        <span id="second" data-controller="stimeo--hover-card">
          <a data-stimeo--hover-card-target="trigger" aria-expanded="false"
             data-action="mouseenter->stimeo--hover-card#open">Second</a>
          <div id="second-card" data-stimeo--hover-card-target="card" hidden>Second card</div>
        </span>
      </main>`);
    const firstTrigger = query("#first [data-stimeo--hover-card-target='trigger']");
    const secondTrigger = query("#second [data-stimeo--hover-card-target='trigger']");
    fire(firstTrigger, "mouseenter");
    vi.advanceTimersByTime(300);
    expect(query("#first-card").hidden).toBe(false);
    expect(query("#second-card").hidden).toBe(true);

    fire(secondTrigger, "mouseenter");
    vi.advanceTimersByTime(300);
    expect(query("#first-card").hidden).toBe(false);
    expect(query("#second-card").hidden).toBe(false);
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
          <div id="hc2" data-stimeo--hover-card-target="card"
               data-action="focusin->stimeo--hover-card#open
                            focusout->stimeo--hover-card#close" hidden>
            <p>Jane Doe — Designer</p>
            <a href="/users/jane/follow">Follow</a>
          </div>
        </span>
      </main>`;
    application = Application.start();
    application.register("stimeo--hover-card", HoverCardController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
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
