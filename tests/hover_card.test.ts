import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoverCardController } from "../src/controllers/hover_card_controller";
import { EscapeLayer } from "../src/utils/escape_layer";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
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

  it("keeps the first open deadline when an open is requested again while pending", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(100);
    trigger().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    vi.advanceTimersByTime(199);
    expect(card().hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(card().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("cancels the pending open on close after a repeated open request", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(100);
    // A second request while the first is pending schedules nothing new, so the
    // one pending open is the one close cancels.
    trigger().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    vi.advanceTimersByTime(100);
    fire(trigger(), "mouseleave");
    vi.advanceTimersByTime(1000);
    expect(card().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the first close deadline when a close is requested again while pending", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    fire(trigger(), "mouseleave");
    vi.advanceTimersByTime(100);
    trigger().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    vi.advanceTimersByTime(99);
    expect(card().hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(card().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the card open when the pointer bridges in after repeated close requests", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    fire(trigger(), "mouseleave");
    vi.advanceTimersByTime(50);
    // A second request while the first is pending schedules nothing new, so the
    // one pending close is the one the bridge cancels.
    trigger().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    vi.advanceTimersByTime(50);
    fire(card(), "mouseenter");
    vi.advanceTimersByTime(1000);
    expect(card().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
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

  it("leaves a newer layer on top when the pointer crosses into the open card", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);

    let aboveDismissed = 0;
    const above = new EscapeLayer();
    above.activate(document, { onDismiss: () => aboveDismissed++ });
    try {
      // An open request while the card is already open leaves the state, and so
      // the order of the Escape stack, where it was.
      fire(trigger(), "mouseleave");
      fire(card(), "mouseenter");
      vi.advanceTimersByTime(1000);
      const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      document.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
      expect(aboveDismissed).toBe(1);
      expect(card().hidden).toBe(false);
    } finally {
      above.deactivate();
    }
  });

  it("ignores an Escape already handled by an inner layer", () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    // A consumed press closes at most one layer.
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

  it("keeps an open card open when it moves within the element", async () => {
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    const moved = card();
    expect(moved.hidden).toBe(false);
    const wrapper = document.createElement("div");
    moved.parentElement?.append(wrapper);
    wrapper.append(moved);
    await vi.advanceTimersByTimeAsync(0);

    // The node never left the element, so it is still the card this hover card shows.
    expect(moved.hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(moved.hidden).toBe(true);
  });

  it("keeps an open card open when another card target leaves", async () => {
    const other = document.createElement("div");
    other.setAttribute("data-stimeo--hover-card-target", "card");
    other.hidden = true;
    card().after(other);
    await vi.advanceTimersByTimeAsync(0);
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    expect(card().hidden).toBe(false);

    other.remove();
    await vi.advanceTimersByTimeAsync(0);

    // Only the card this hover card shows holds what the open state lent.
    expect(card().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it("cleans up listeners and collapsed ARIA when the card target was removed", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--hover-card-close-on-scroll-value="true"');
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(300);
    const detachedCard = card();
    detachedCard.remove();
    await vi.advanceTimersByTimeAsync(0);

    // The removal itself released the layer, so the press reaches whatever is below.
    const firstEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    document.dispatchEvent(firstEscape);
    expect(firstEscape.defaultPrevented).toBe(false);
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

  it("ignores an open request while the card target is absent", () => {
    const capture = captureStateEvents("stimeo--hover-card");
    try {
      const detachedCard = card();
      detachedCard.remove();
      fire(trigger(), "mouseenter");
      expect(() => vi.advanceTimersByTime(300)).not.toThrow();
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(capture.seen).toEqual([]);
      const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      document.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(false);

      // The same request opens the card once the target is back.
      root().append(detachedCard);
      fire(trigger(), "mouseenter");
      vi.advanceTimersByTime(300);
      expect(detachedCard.hidden).toBe(false);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(capture.names()).toEqual(["open"]);
    } finally {
      capture.stop();
    }
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

  // --- A trigger that takes over ---

  /**
   * The trigger carries the open state in `aria-expanded`. A trigger that takes over —
   * in one task, or after an earlier one leaves in a later task — carries that state,
   * silently.
   */
  describe("a trigger that takes over", () => {
    /** Lets Stimulus deliver the target callbacks under the mocked clock. */
    const settle = () => vi.advanceTimersByTimeAsync(0);
    const show = () => {
      fire(trigger(), "mouseenter");
      vi.advanceTimersByTime(300);
      expect(card().hidden).toBe(false);
    };
    /** A server-rendered copy of the trigger that still reads closed. */
    const staleTrigger = (): HTMLAnchorElement => {
      const copy = trigger().cloneNode(true) as HTMLAnchorElement;
      copy.setAttribute("aria-expanded", "false");
      return copy;
    };

    it("reflects the shown card into a trigger replaced in one task", async () => {
      show();
      const successor = staleTrigger();
      trigger().replaceWith(successor);
      await settle();

      expect(trigger()).toBe(successor);
      expect(successor.getAttribute("aria-expanded")).toBe("true");
    });

    it("reflects the shown card into the trigger that stays after an earlier one leaves", async () => {
      show();
      const original = trigger();
      const successor = staleTrigger();
      original.after(successor);
      await settle();
      original.remove();
      await settle();

      expect(trigger()).toBe(successor);
      expect(successor.getAttribute("aria-expanded")).toBe("true");
    });

    it("reflects a card the page hid into a trigger replaced in one task", async () => {
      show();
      card().hidden = true;
      const successor = staleTrigger();
      successor.setAttribute("aria-expanded", "true");
      trigger().replaceWith(successor);
      await settle();

      expect(successor.getAttribute("aria-expanded")).toBe("false");
    });

    it("reflects a card the page hid into the trigger that stays after an earlier one leaves", async () => {
      show();
      card().hidden = true;
      const original = trigger();
      const successor = staleTrigger();
      successor.setAttribute("aria-expanded", "true");
      original.after(successor);
      await settle();
      original.remove();
      await settle();

      expect(successor.getAttribute("aria-expanded")).toBe("false");
    });

    it("reflects the closed card into a trigger that takes over authored expanded", async () => {
      const successor = staleTrigger();
      successor.setAttribute("aria-expanded", "true");
      trigger().replaceWith(successor);
      await settle();

      expect(successor.getAttribute("aria-expanded")).toBe("false");
    });

    it("brings a trigger that arrives after the only one left to the open state", async () => {
      show();
      const late = staleTrigger();
      trigger().remove();
      await settle();

      root().prepend(late);
      await settle();

      expect(late.getAttribute("aria-expanded")).toBe("true");
    });

    it("writes nothing when a trigger arrives behind the current one", async () => {
      show();
      const writes: MutationRecord[] = [];
      const observer = new MutationObserver((records) => writes.push(...records));
      observer.observe(root(), { attributes: true, subtree: true });
      const behind = staleTrigger();
      trigger().after(behind);
      await settle();
      writes.push(...observer.takeRecords());
      observer.disconnect();

      expect(writes.map((write) => write.attributeName)).toEqual([]);
      expect(behind.getAttribute("aria-expanded")).toBe("false");
    });

    it("reports nothing while it moves the open state", async () => {
      show();
      const events = captureStateEvents("stimeo--hover-card");
      const changes: Event[] = [];
      const onChange = (event: Event): void => {
        changes.push(event);
      };
      document.addEventListener("change", onChange);
      const original = trigger();
      original.after(staleTrigger());
      await settle();
      original.remove();
      await settle();

      expect(events.seen).toEqual([]);
      expect(changes).toEqual([]);
      events.stop();
      document.removeEventListener("change", onChange);
    });

    it("tolerates the removal of the only trigger", () => {
      show();
      const only = trigger();
      only.remove();

      // Drive the callback directly: happy-dom delivers target callbacks unreliably.
      expect(() => controller().triggerTargetDisconnected(only)).not.toThrow();
    });

    it("writes nothing into the trigger that stays once it has disconnected", async () => {
      const original = trigger();
      const successor = staleTrigger();
      original.after(successor);
      await settle();
      show();
      const instance = controller();
      instance.disconnect();
      original.remove();
      instance.triggerTargetDisconnected(original);
      instance.triggerTargetConnected();
      await settle();

      expect(successor.getAttribute("aria-expanded")).toBe("false");
    });

    it("gives a trigger that stops being the trigger its own aria-expanded back", async () => {
      show();
      const former = trigger();
      const successor = staleTrigger();
      former.after(successor);
      await settle();

      // The element stays; only the attribute naming it the trigger goes.
      former.removeAttribute("data-stimeo--hover-card-target");
      await settle();

      expect(former.getAttribute("aria-expanded")).toBe("false");
      expect(successor.getAttribute("aria-expanded")).toBe("true");
    });

    it("gives the trigger its own aria-expanded back when the hover card loses its controller", async () => {
      show();
      const departed = trigger();

      root().removeAttribute("data-controller");
      await settle();

      expect(departed.getAttribute("aria-expanded")).toBe("false");
    });

    it("keeps a value the page wrote on a trigger that stops being the trigger", async () => {
      show();
      const former = trigger();
      former.setAttribute("aria-expanded", "mixed");

      root().removeAttribute("data-controller");
      await settle();

      expect(former.getAttribute("aria-expanded")).toBe("mixed");
    });

    it("keeps what it wrote on a trigger that moves within the hover card", async () => {
      show();
      const moving = trigger();
      const writes: MutationRecord[] = [];
      const observer = new MutationObserver((records) => writes.push(...records));
      observer.observe(moving, { attributes: true, attributeFilter: ["aria-expanded"] });

      root().append(moving);
      await settle();
      writes.push(...observer.takeRecords());
      observer.disconnect();

      expect(moving.getAttribute("aria-expanded")).toBe("true");
      expect(writes).toEqual([]);
    });

    it("keeps what it wrote when the whole hover card leaves the page", async () => {
      show();
      const kept = trigger();

      root().remove();
      await settle();

      expect(kept.getAttribute("aria-expanded")).toBe("true");
    });
  });

  // --- What the shown card holds ---

  describe("what the shown card holds", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--hover-card");
    });

    afterEach(() => {
      capture.stop();
    });

    /** Presses Escape at the document and reports whether a layer consumed it. */
    const pressEscape = (): boolean => {
      const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      document.dispatchEvent(press);
      return press.defaultPrevented;
    };

    /**
     * Rewrites `closeOnScroll` the way a morph does, lets Stimulus deliver the
     * callback, and delivers it once more, since a repeated delivery must change
     * nothing either.
     */
    const setCloseOnScroll = async (on: boolean): Promise<void> => {
      root().setAttribute("data-stimeo--hover-card-close-on-scroll-value", String(on));
      await vi.advanceTimersByTimeAsync(0);
      controller().closeOnScrollValueChanged();
    };

    /** A server-rendered replacement for the card, as a morph swaps it in. */
    const freshCard = (): HTMLElement => {
      const element = document.createElement("div");
      element.id = "hc";
      element.setAttribute("data-stimeo--hover-card-target", "card");
      element.hidden = true;
      element.innerHTML = '<a href="/users/jane/follow">Follow</a>';
      return element;
    };

    const openCard = (): void => {
      fire(trigger(), "mouseenter");
      vi.advanceTimersByTime(300);
    };

    for (const hiddenByPage of [false, true]) {
      it(`releases what the card holds at the next close request (hidden by the page: ${hiddenByPage})`, async () => {
        disconnectAndStopApplication(application);
        await start('data-stimeo--hover-card-close-on-scroll-value="true"');
        openCard();
        capture.clear();
        // The page hides the shown card itself, leaving the element in place.
        if (hiddenByPage) card().hidden = true;
        expect(trigger().getAttribute("aria-expanded")).toBe("true");

        fire(trigger(), "mouseleave");
        vi.advanceTimersByTime(200);

        expect(card().hidden).toBe(true);
        expect(card().getAttribute("data-state")).toBe("closed");
        expect(trigger().getAttribute("aria-expanded")).toBe("false");
        expect(vi.getTimerCount()).toBe(0);
        expect(pressEscape()).toBe(false);
        // No scroll listener is left: a card shown again by hand stays shown.
        card().hidden = false;
        window.dispatchEvent(new Event("scroll"));
        expect(card().hidden).toBe(false);
        // A card the page already hid reads closed, so closing it moves nothing to report.
        expect(capture.names()).toEqual(hiddenByPage ? [] : ["close"]);
        expect(capture.reasons()).toEqual(hiddenByPage ? [] : ["pointer"]);
      });
    }

    it("releases what a card the page hid holds at the next Escape, which it consumes once", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--hover-card-close-on-scroll-value="true"');
      openCard();
      capture.clear();
      card().hidden = true;

      // The trigger still reads expanded, so the press collapses it.
      expect(pressEscape()).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(pressEscape()).toBe(false);
      card().hidden = false;
      window.dispatchEvent(new Event("scroll"));
      expect(card().hidden).toBe(false);
      expect(capture.seen).toEqual([]);
    });

    it("releases what a card the page hid holds at the next dismissing scroll", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--hover-card-close-on-scroll-value="true"');
      openCard();
      fire(trigger(), "mouseleave");
      capture.clear();
      card().hidden = true;

      window.dispatchEvent(new Event("scroll"));
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(vi.getTimerCount()).toBe(0);
      expect(pressEscape()).toBe(false);
      expect(capture.seen).toEqual([]);
    });

    it("reopens a card the page hid with one layer and one scroll subscription", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--hover-card-close-on-scroll-value="true"');
      openCard();
      capture.clear();
      card().hidden = true;

      openCard();
      expect(card().hidden).toBe(false);
      expect(capture.names()).toEqual(["open"]);
      window.dispatchEvent(new Event("scroll"));
      expect(card().hidden).toBe(true);
      expect(pressEscape()).toBe(false);
      expect(capture.reasons()).toEqual(["pointer", "scroll"]);
    });

    it("closes a card the page showed itself, holding nothing", () => {
      // Shown by the page, not revealed here: nothing is held, and the card still closes.
      card().hidden = false;
      fire(trigger(), "mouseleave");
      vi.advanceTimersByTime(200);
      expect(card().hidden).toBe(true);
      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["pointer"]);
    });

    it("writes and schedules nothing for a close request after an Escape dismissal", () => {
      openCard();
      expect(pressEscape()).toBe(true);
      capture.clear();
      const observer = new MutationObserver(() => {});
      observer.observe(root(), { attributes: true, subtree: true });

      // The pointer leaving a card Escape already closed is a request with nothing to close.
      fire(trigger(), "mouseleave");
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(observer.takeRecords()).toEqual([]);
      observer.disconnect();
      expect(capture.seen).toEqual([]);
    });

    it("keeps holding the layer and aria-expanded while the shown card stays", async () => {
      openCard();
      await vi.advanceTimersByTimeAsync(0);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(pressEscape()).toBe(true);
      expect(card().hidden).toBe(true);
    });

    it("releases the layer, the scroll dismissal, the pending close and aria-expanded when the shown card leaves", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--hover-card-close-on-scroll-value="true"');
      openCard();
      fire(trigger(), "mouseleave");
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(vi.getTimerCount()).toBe(1);
      capture.clear();

      const departed = card();
      departed.remove();
      await vi.advanceTimersByTimeAsync(0);

      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(departed.hidden).toBe(true);
      expect(departed.getAttribute("data-state")).toBe("closed");
      expect(vi.getTimerCount()).toBe(0);
      expect(pressEscape()).toBe(false);
      // No scroll listener is left: a card put back and shown by hand stays shown.
      root().append(departed);
      departed.hidden = false;
      window.dispatchEvent(new Event("scroll"));
      expect(departed.hidden).toBe(false);
      // Target churn is not a state move anyone made, so it reports nothing.
      expect(capture.seen).toEqual([]);
    });

    for (const order of ["removed first", "added first"] as const) {
      it(`hands the next open to a card a morph swapped in (${order})`, async () => {
        disconnectAndStopApplication(application);
        await start('data-stimeo--hover-card-close-on-scroll-value="true"');
        openCard();
        capture.clear();

        const departed = card();
        const arrived = freshCard();
        if (order === "removed first") {
          departed.replaceWith(arrived);
        } else {
          departed.after(arrived);
          await vi.advanceTimersByTimeAsync(0);
          departed.remove();
        }
        await vi.advanceTimersByTimeAsync(0);

        expect(trigger().getAttribute("aria-expanded")).toBe("false");
        expect(arrived.hidden).toBe(true);
        expect(pressEscape()).toBe(false);
        expect(capture.seen).toEqual([]);

        openCard();
        expect(arrived.hidden).toBe(false);
        expect(trigger().getAttribute("aria-expanded")).toBe("true");
        window.dispatchEvent(new Event("scroll"));
        expect(arrived.hidden).toBe(true);
        // The scroll close released the one layer this open took.
        expect(pressEscape()).toBe(false);
        expect(capture.names()).toEqual(["open", "close"]);
        expect(capture.reasons()).toEqual(["pointer", "scroll"]);
      });
    }

    it("writes the closed state onto a replacement card that arrives shown", async () => {
      openCard();
      const departed = card();
      const arrived = freshCard();
      arrived.hidden = false;
      departed.replaceWith(arrived);
      await vi.advanceTimersByTimeAsync(0);
      expect(arrived.hidden).toBe(true);
      expect(arrived.getAttribute("data-state")).toBe("closed");
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(capture.names()).toEqual(["open"]);
    });

    it("drops a pending close along with the card an Escape dismissed", () => {
      openCard();
      fire(trigger(), "mouseleave");
      expect(vi.getTimerCount()).toBe(1);
      expect(pressEscape()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      const observer = new MutationObserver(() => {});
      observer.observe(root(), { attributes: true, subtree: true });
      vi.advanceTimersByTime(1000);
      expect(observer.takeRecords()).toEqual([]);
      observer.disconnect();
      expect(capture.reasons()).toEqual(["pointer", "escape"]);
    });

    it("drops a request made while disconnected when the same instance reconnects", () => {
      controller().disconnect();
      controller().open();
      expect(vi.getTimerCount()).toBe(1);
      controller().connect();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(card().hidden).toBe(true);
      expect(capture.seen).toEqual([]);
    });

    it("leaves the DOM alone when the card's disconnect follows the controller's", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--hover-card-close-on-scroll-value="true"');
      openCard();
      const shown = card();

      // Stimulus tears down the controller first, then each of its targets.
      controller().disconnect();
      controller().cardTargetDisconnected(shown);
      expect(shown.hidden).toBe(false);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(pressEscape()).toBe(false);
      window.dispatchEvent(new Event("scroll"));
      expect(shown.hidden).toBe(false);

      // The same instance reconnects and holds exactly one layer again.
      controller().connect();
      openCard();
      expect(pressEscape()).toBe(true);
      expect(shown.hidden).toBe(true);
      expect(pressEscape()).toBe(false);
    });

    it("releases once when the shown card leaves before the controller disconnects", async () => {
      openCard();
      const departed = card();
      departed.remove();
      await vi.advanceTimersByTimeAsync(0);
      controller().cardTargetDisconnected(departed);
      controller().disconnect();
      controller().cardTargetDisconnected(departed);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(pressEscape()).toBe(false);
      expect(capture.names()).toEqual(["open"]);
    });

    it("holds nothing for a card whose controller a subscriber unloads from the open handler", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--hover-card-close-on-scroll-value="true"');
      let unloaded = false;
      root().addEventListener("stimeo--hover-card:open", () => {
        if (unloaded) return;
        unloaded = true;
        application.unload("stimeo--hover-card");
      });
      openCard();
      expect(unloaded).toBe(true);
      expect(pressEscape()).toBe(false);
      window.dispatchEvent(new Event("scroll"));
      expect(card().hidden).toBe(false);
    });

    it("wires the scroll dismissal when closeOnScroll turns on while shown", async () => {
      openCard();
      window.dispatchEvent(new Event("scroll"));
      expect(card().hidden).toBe(false);

      await setCloseOnScroll(true);
      expect(card().hidden).toBe(false);
      expect(capture.names()).toEqual(["open"]);
      window.dispatchEvent(new Event("scroll"));
      expect(card().hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(capture.names()).toEqual(["open", "close"]);
      expect(capture.reasons()).toEqual(["pointer", "scroll"]);
    });

    it("releases the scroll dismissal when closeOnScroll turns off while shown", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--hover-card-close-on-scroll-value="true"');
      openCard();

      await setCloseOnScroll(false);
      window.dispatchEvent(new Event("scroll"));
      expect(card().hidden).toBe(false);
      // The Escape layer is untouched by the flip.
      expect(pressEscape()).toBe(true);
      expect(card().hidden).toBe(true);
      expect(capture.names()).toEqual(["open", "close"]);
      expect(capture.reasons()).toEqual(["pointer", "escape"]);
    });

    it("keeps a pending close's promise when closeOnScroll turns off", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--hover-card-close-on-scroll-value="true"');
      openCard();
      fire(trigger(), "mouseleave");

      await setCloseOnScroll(false);
      window.dispatchEvent(new Event("scroll"));
      expect(card().hidden).toBe(false);
      vi.advanceTimersByTime(200);
      expect(card().hidden).toBe(true);
      expect(capture.names()).toEqual(["open", "close"]);
      expect(capture.reasons()).toEqual(["pointer", "pointer"]);
    });

    it("wires nothing while closed and reads closeOnScroll afresh at each reveal", async () => {
      await setCloseOnScroll(true);
      window.dispatchEvent(new Event("scroll"));
      expect(card().hidden).toBe(true);
      expect(capture.seen).toEqual([]);

      // Flipped during the open delay: the reveal reads the current declaration.
      fire(trigger(), "mouseenter");
      await setCloseOnScroll(false);
      await setCloseOnScroll(true);
      vi.advanceTimersByTime(300);
      window.dispatchEvent(new Event("scroll"));
      expect(card().hidden).toBe(true);

      await setCloseOnScroll(false);
      openCard();
      window.dispatchEvent(new Event("scroll"));
      expect(card().hidden).toBe(false);
      expect(capture.reasons()).toEqual(["pointer", "scroll", "pointer"]);
    });

    it("subscribes to no scroll when closeOnScroll turns on while closed, so a scroll leaves a pending open alone", async () => {
      const added = vi.spyOn(window, "addEventListener");
      const scrollSubscriptions = () => added.mock.calls.filter(([type]) => type === "scroll");
      try {
        await setCloseOnScroll(true);
        expect(scrollSubscriptions()).toHaveLength(0);

        fire(trigger(), "mouseenter");
        window.dispatchEvent(new Event("scroll"));
        vi.advanceTimersByTime(300);
        expect(card().hidden).toBe(false);

        // The reveal subscribes once, and that subscription dismisses.
        expect(scrollSubscriptions()).toHaveLength(1);
        window.dispatchEvent(new Event("scroll"));
        expect(card().hidden).toBe(true);
        expect(capture.reasons()).toEqual(["pointer", "scroll"]);
      } finally {
        added.mockRestore();
      }
    });

    it("keeps a scheduled delay's deadline and reads a changed delay at the next request", async () => {
      fire(trigger(), "mouseenter");
      root().setAttribute("data-stimeo--hover-card-open-delay-value", "50");
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(299);
      expect(card().hidden).toBe(true);
      vi.advanceTimersByTime(1);
      expect(card().hidden).toBe(false);

      fire(trigger(), "mouseleave");
      root().setAttribute("data-stimeo--hover-card-close-delay-value", "1000");
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(199);
      expect(card().hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(card().hidden).toBe(true);

      // The next requests read the declarations as they are now.
      fire(trigger(), "mouseenter");
      vi.advanceTimersByTime(50);
      expect(card().hidden).toBe(false);
      fire(trigger(), "mouseleave");
      vi.advanceTimersByTime(999);
      expect(card().hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(card().hidden).toBe(true);
      expect(capture.names()).toEqual(["open", "close", "open", "close"]);
      expect(capture.reasons()).toEqual(["pointer", "pointer", "pointer", "pointer"]);
    });

    it("opens, closes and schedules nothing when only a delay changes", async () => {
      root().setAttribute("data-stimeo--hover-card-open-delay-value", "0");
      root().setAttribute("data-stimeo--hover-card-close-delay-value", "0");
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(card().hidden).toBe(true);

      openCard();
      root().setAttribute("data-stimeo--hover-card-close-delay-value", "500");
      await vi.advanceTimersByTimeAsync(1000);
      expect(card().hidden).toBe(false);
      expect(capture.names()).toEqual(["open"]);
    });

    it("subscribes once when a subscriber turns closeOnScroll on from the open handler", async () => {
      let flipped = false;
      root().addEventListener("stimeo--hover-card:open", () => {
        if (flipped) return;
        flipped = true;
        root().setAttribute("data-stimeo--hover-card-close-on-scroll-value", "true");
        controller().closeOnScrollValueChanged();
      });
      openCard();
      await vi.advanceTimersByTimeAsync(0);
      window.dispatchEvent(new Event("scroll"));
      expect(card().hidden).toBe(true);

      // A second subscription would outlive the close and dismiss the next reveal.
      await setCloseOnScroll(false);
      openCard();
      window.dispatchEvent(new Event("scroll"));
      expect(card().hidden).toBe(false);
      expect(capture.reasons()).toEqual(["pointer", "scroll", "pointer"]);
    });
  });

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--hover-card");
    });

    afterEach(() => {
      capture.stop();
    });

    it("reports a pointer open after the delay, with the state already written", async () => {
      const states: string[] = [];
      query("[data-controller='stimeo--hover-card']").addEventListener(
        "stimeo--hover-card:open",
        () => {
          states.push(`${card().hidden} ${trigger().getAttribute("aria-expanded")}`);
        },
      );

      trigger().dispatchEvent(new MouseEvent("mouseenter"));
      expect(capture.seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(300);

      expect(capture.names()).toEqual(["open"]);
      expect(capture.reasons()).toEqual(["pointer"]);
      expect(states).toEqual(["false true"]);
      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);
    });

    it("carries the pointer reason across the close delay", async () => {
      trigger().dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(300);
      capture.clear();

      trigger().dispatchEvent(new MouseEvent("mouseleave"));
      await vi.advanceTimersByTimeAsync(200);

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["pointer"]);
    });

    it("reports one open with the first request's reason when a pending open is requested again", async () => {
      trigger().dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(100);
      trigger().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1000);

      expect(capture.names()).toEqual(["open"]);
      expect(capture.reasons()).toEqual(["pointer"]);
    });

    it("reports one close with the first request's reason when a pending close is requested again", async () => {
      trigger().dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(300);
      capture.clear();

      trigger().dispatchEvent(new MouseEvent("mouseleave"));
      await vi.advanceTimersByTimeAsync(100);
      trigger().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1000);

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["pointer"]);
    });

    it("reports a focus-driven open as focus", async () => {
      trigger().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(300);

      expect(capture.reasons()).toEqual(["focus"]);
    });

    it("reports Escape as escape", async () => {
      trigger().dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(300);
      capture.clear();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["escape"]);
    });

    it("stays silent while connect normalizes and on a repeated open", async () => {
      const fresh = captureStateEvents("stimeo--hover-card");
      disconnectAndStopApplication(application);
      await start();
      expect(fresh.seen).toEqual([]);
      fresh.stop();

      trigger().dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(300);
      capture.clear();
      trigger().dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(300);

      expect(capture.seen).toEqual([]);
    });
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
