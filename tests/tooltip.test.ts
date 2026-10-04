import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipController } from "../src/controllers/tooltip_controller";
import { EscapeLayer } from "../src/utils/escape_layer";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
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

  it("keeps the first show deadline when a show is requested again while pending", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-show-delay-value="200"');
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(100);
    focus(trigger(), "focusin");
    vi.advanceTimersByTime(99);
    expect(content().hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(content().hidden).toBe(false);
  });

  it("cancels the pending show once every interaction ends after a repeated show request", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-show-delay-value="200"');
    fire(trigger(), "mouseenter");
    vi.advanceTimersByTime(50);
    // A second request while the first is pending schedules nothing new, so the
    // one pending show is the one the final leave cancels.
    focus(trigger(), "focusin");
    vi.advanceTimersByTime(50);
    fire(trigger(), "mouseleave");
    focus(trigger(), "focusout");
    vi.advanceTimersByTime(1000);
    expect(content().hidden).toBe(true);
  });

  it("keeps the first hide deadline when a hide is requested again while pending", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-hide-delay-value="200"');
    fire(trigger(), "mouseenter");
    fire(trigger(), "mouseleave");
    vi.advanceTimersByTime(100);
    controller().hide();
    vi.advanceTimersByTime(99);
    expect(content().hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(content().hidden).toBe(true);
  });

  it("keeps it open via the hoverable bridge after repeated hide requests", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-hide-delay-value="200"');
    fire(trigger(), "mouseenter");
    fire(trigger(), "mouseleave");
    vi.advanceTimersByTime(50);
    // A second request while the first is pending schedules nothing new, so the
    // one pending hide is the one the bridge cancels.
    controller().hide();
    vi.advanceTimersByTime(50);
    fire(content(), "mouseenter");
    vi.advanceTimersByTime(1000);
    expect(content().hidden).toBe(false);
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

  it("finishes an explicit hide when one of two active reasons ends", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-hide-delay-value="100"');
    focus(trigger(), "focusin");
    fire(trigger(), "mouseenter");
    controller().hide();

    fire(trigger(), "mouseleave");
    vi.advanceTimersByTime(150);

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

  it("leaves a newer layer on top when a show is requested again while shown", () => {
    fire(trigger(), "mouseenter");

    let aboveDismissed = 0;
    const above = new EscapeLayer();
    above.activate(document, { onDismiss: () => aboveDismissed++ });
    try {
      // A show request while the tooltip is already shown leaves the state, and
      // so the order of the Escape stack, where it was.
      focus(trigger(), "focusin");
      const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      document.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
      expect(aboveDismissed).toBe(1);
      expect(content().hidden).toBe(false);
    } finally {
      above.deactivate();
    }
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

  it("forgets a focus from before the same instance reconnected", async () => {
    fire(trigger(), "focusin");
    await vi.advanceTimersByTimeAsync(1000);
    controller().disconnect();
    controller().connect();
    fire(trigger(), "mouseenter");
    await vi.advanceTimersByTimeAsync(1000);
    expect(content().hidden).toBe(false);

    fire(trigger(), "mouseleave");
    await vi.advanceTimersByTimeAsync(1000);

    expect(content().hidden).toBe(true);
  });

  it("keeps shown content shown when it moves within the element", async () => {
    fire(trigger(), "mouseenter");
    await vi.advanceTimersByTimeAsync(0);
    const moved = content();
    expect(moved.hidden).toBe(false);
    const wrapper = document.createElement("span");
    moved.parentElement?.append(wrapper);
    wrapper.append(moved);
    await vi.advanceTimersByTimeAsync(0);

    // The node never left the element, so it is still the content this tooltip shows.
    expect(moved.hidden).toBe(false);
    const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(moved.hidden).toBe(true);
  });

  it("keeps shown content shown when another content target leaves", async () => {
    const other = document.createElement("span");
    other.setAttribute("data-stimeo--tooltip-target", "content");
    other.hidden = true;
    content().after(other);
    await vi.advanceTimersByTimeAsync(0);
    fire(trigger(), "mouseenter");
    await vi.advanceTimersByTimeAsync(0);
    expect(content().hidden).toBe(false);

    other.remove();
    await vi.advanceTimersByTimeAsync(0);

    // Only the content this tooltip shows holds what the shown state lent.
    expect(content().hidden).toBe(false);
    const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it("cleans up listeners when the content target is removed", async () => {
    disconnectAndStopApplication(application);
    await start('data-stimeo--tooltip-close-on-scroll-value="true"');
    fire(trigger(), "mouseenter");
    const detachedContent = content();
    detachedContent.remove();
    await vi.advanceTimersByTimeAsync(0);

    // The removal itself released the layer, so the press reaches whatever is below.
    const firstEscape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(firstEscape);
    expect(firstEscape.defaultPrevented).toBe(false);

    root().append(detachedContent);
    detachedContent.hidden = false;
    window.dispatchEvent(new Event("scroll"));
    expect(detachedContent.hidden).toBe(false);
    const secondEscape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(secondEscape);
    expect(secondEscape.defaultPrevented).toBe(false);
  });

  it("ignores a show request while the content target is absent", () => {
    const capture = captureStateEvents("stimeo--tooltip");
    try {
      const detachedContent = content();
      detachedContent.remove();
      expect(() => controller().show()).not.toThrow();
      expect(capture.seen).toEqual([]);
      const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      document.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(false);

      // The same request shows the tooltip once the target is back.
      root().append(detachedContent);
      controller().show();
      expect(detachedContent.hidden).toBe(false);
      expect(capture.names()).toEqual(["open"]);
    } finally {
      capture.stop();
    }
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

  // --- What the shown tooltip holds ---

  describe("what the shown tooltip holds", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--tooltip");
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
      root().setAttribute("data-stimeo--tooltip-close-on-scroll-value", String(on));
      await vi.advanceTimersByTimeAsync(0);
      controller().closeOnScrollValueChanged();
    };

    /** A server-rendered replacement for the content, as a morph swaps it in. */
    const freshContent = (): HTMLElement => {
      const element = document.createElement("span");
      element.id = "tip";
      element.setAttribute("role", "tooltip");
      element.setAttribute("data-stimeo--tooltip-target", "content");
      element.hidden = true;
      element.textContent = "Saves to disk";
      return element;
    };

    for (const hiddenByPage of [false, true]) {
      it(`releases what the tooltip holds at the next hide request (hidden by the page: ${hiddenByPage})`, async () => {
        disconnectAndStopApplication(application);
        await start(
          'data-stimeo--tooltip-close-on-scroll-value="true" data-stimeo--tooltip-hide-delay-value="200"',
        );
        fire(trigger(), "mouseenter");
        capture.clear();
        // The page hides the shown content itself, leaving the element in place.
        if (hiddenByPage) content().hidden = true;

        fire(trigger(), "mouseleave");
        vi.advanceTimersByTime(200);

        expect(content().hidden).toBe(true);
        expect(content().getAttribute("data-state")).toBe("closed");
        expect(vi.getTimerCount()).toBe(0);
        expect(pressEscape()).toBe(false);
        // No scroll listener is left: content shown again by hand stays shown.
        content().hidden = false;
        window.dispatchEvent(new Event("scroll"));
        expect(content().hidden).toBe(false);
        // Content the page already hid reads hidden, so hiding it moves nothing to report.
        expect(capture.names()).toEqual(hiddenByPage ? [] : ["close"]);
        expect(capture.reasons()).toEqual(hiddenByPage ? [] : ["pointer"]);
      });
    }

    it("releases what content the page hid holds at the next Escape, which it consumes once", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--tooltip-close-on-scroll-value="true"');
      fire(trigger(), "mouseenter");
      capture.clear();
      content().hidden = true;

      expect(pressEscape()).toBe(true);
      expect(pressEscape()).toBe(false);
      content().hidden = false;
      window.dispatchEvent(new Event("scroll"));
      expect(content().hidden).toBe(false);
      expect(capture.seen).toEqual([]);
    });

    it("releases what content the page hid holds at the next dismissing scroll", async () => {
      disconnectAndStopApplication(application);
      await start(
        'data-stimeo--tooltip-close-on-scroll-value="true" data-stimeo--tooltip-hide-delay-value="200"',
      );
      fire(trigger(), "mouseenter");
      fire(trigger(), "mouseleave");
      capture.clear();
      content().hidden = true;

      window.dispatchEvent(new Event("scroll"));
      expect(vi.getTimerCount()).toBe(0);
      expect(pressEscape()).toBe(false);
      expect(capture.seen).toEqual([]);
    });

    it("shows content the page hid again with one layer and one scroll subscription", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--tooltip-close-on-scroll-value="true"');
      focus(trigger(), "focusin");
      capture.clear();
      content().hidden = true;

      fire(trigger(), "mouseenter");
      expect(content().hidden).toBe(false);
      expect(capture.names()).toEqual(["open"]);
      window.dispatchEvent(new Event("scroll"));
      expect(content().hidden).toBe(true);
      expect(pressEscape()).toBe(false);
      expect(capture.reasons()).toEqual(["pointer", "scroll"]);
    });

    it("hides content the page showed itself, holding nothing", () => {
      // Shown by the page, not revealed here: nothing is held, and the tooltip still hides.
      content().hidden = false;
      controller().hide();
      expect(content().hidden).toBe(true);
      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["api"]);
    });

    it("writes and schedules nothing for a hide request after an Escape dismissal", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--tooltip-hide-delay-value="200"');
      fire(trigger(), "mouseenter");
      expect(pressEscape()).toBe(true);
      capture.clear();
      const observer = new MutationObserver(() => {});
      observer.observe(root(), { attributes: true, subtree: true });

      // The pointer leaving a tooltip Escape already hid is a request with nothing to hide.
      fire(trigger(), "mouseleave");
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(observer.takeRecords()).toEqual([]);
      observer.disconnect();
      expect(capture.seen).toEqual([]);
    });

    it("keeps holding the layer while the shown content stays", async () => {
      fire(trigger(), "mouseenter");
      await vi.advanceTimersByTimeAsync(0);
      expect(pressEscape()).toBe(true);
      expect(content().hidden).toBe(true);
    });

    it("releases the layer, the scroll dismissal and the pending hide when the shown content leaves", async () => {
      disconnectAndStopApplication(application);
      await start(
        'data-stimeo--tooltip-close-on-scroll-value="true" data-stimeo--tooltip-hide-delay-value="200"',
      );
      capture.clear();
      fire(trigger(), "mouseenter");
      fire(trigger(), "mouseleave");
      expect(content().hidden).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      capture.clear();

      const departed = content();
      departed.remove();
      await vi.advanceTimersByTimeAsync(0);

      expect(departed.hidden).toBe(true);
      expect(departed.getAttribute("data-state")).toBe("closed");
      expect(vi.getTimerCount()).toBe(0);
      expect(pressEscape()).toBe(false);
      // No scroll listener is left: content put back and shown by hand stays shown.
      root().append(departed);
      departed.hidden = false;
      window.dispatchEvent(new Event("scroll"));
      expect(departed.hidden).toBe(false);
      // Target churn is not a state move anyone made, so it reports nothing.
      expect(capture.seen).toEqual([]);
    });

    for (const order of ["removed first", "added first"] as const) {
      it(`hands the next show to content a morph swapped in (${order})`, async () => {
        disconnectAndStopApplication(application);
        await start('data-stimeo--tooltip-close-on-scroll-value="true"');
        capture.clear();
        focus(trigger(), "focusin");
        capture.clear();

        const departed = content();
        const arrived = freshContent();
        if (order === "removed first") {
          departed.replaceWith(arrived);
        } else {
          departed.after(arrived);
          await vi.advanceTimersByTimeAsync(0);
          departed.remove();
        }
        await vi.advanceTimersByTimeAsync(0);

        expect(arrived.hidden).toBe(true);
        expect(pressEscape()).toBe(false);
        expect(capture.seen).toEqual([]);

        fire(trigger(), "mouseenter");
        expect(arrived.hidden).toBe(false);
        window.dispatchEvent(new Event("scroll"));
        expect(arrived.hidden).toBe(true);
        // The scroll close released the one layer this show took.
        expect(pressEscape()).toBe(false);
        expect(capture.names()).toEqual(["open", "close"]);
        expect(capture.reasons()).toEqual(["pointer", "scroll"]);
      });
    }

    it("writes the hidden state onto replacement content that arrives shown", async () => {
      fire(trigger(), "mouseenter");
      const departed = content();
      const arrived = freshContent();
      arrived.hidden = false;
      departed.replaceWith(arrived);
      await vi.advanceTimersByTimeAsync(0);
      expect(arrived.hidden).toBe(true);
      expect(arrived.getAttribute("data-state")).toBe("closed");
      expect(capture.names()).toEqual(["open"]);
    });

    it("drops a pending hide along with the tooltip an Escape dismissed", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--tooltip-hide-delay-value="200"');
      capture.clear();
      fire(trigger(), "mouseenter");
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

    it("drops a request made while disconnected when the same instance reconnects", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--tooltip-show-delay-value="200"');
      capture.clear();
      controller().disconnect();
      controller().show();
      expect(vi.getTimerCount()).toBe(1);
      controller().connect();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(content().hidden).toBe(true);
      expect(capture.seen).toEqual([]);
    });

    it("leaves the DOM alone when the content's disconnect follows the controller's", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--tooltip-close-on-scroll-value="true"');
      fire(trigger(), "mouseenter");
      const shown = content();

      // Stimulus tears down the controller first, then each of its targets.
      controller().disconnect();
      controller().contentTargetDisconnected(shown);
      expect(shown.hidden).toBe(false);
      expect(pressEscape()).toBe(false);
      window.dispatchEvent(new Event("scroll"));
      expect(shown.hidden).toBe(false);

      // The same instance reconnects and holds exactly one layer again.
      controller().connect();
      fire(trigger(), "mouseenter");
      expect(pressEscape()).toBe(true);
      expect(shown.hidden).toBe(true);
      expect(pressEscape()).toBe(false);
    });

    it("releases once when the shown content leaves before the controller disconnects", async () => {
      fire(trigger(), "mouseenter");
      const departed = content();
      departed.remove();
      await vi.advanceTimersByTimeAsync(0);
      controller().contentTargetDisconnected(departed);
      controller().disconnect();
      controller().contentTargetDisconnected(departed);
      expect(pressEscape()).toBe(false);
      expect(capture.names()).toEqual(["open"]);
    });

    it("holds nothing when the open handler hides the tooltip again", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--tooltip-close-on-scroll-value="true"');
      // Recorded on the root ahead of the subscriber, so the nested close follows the open.
      const local = captureStateEvents("stimeo--tooltip", ["open", "close"], root());
      let hid = false;
      root().addEventListener("stimeo--tooltip:open", () => {
        if (hid) return;
        hid = true;
        controller().hide();
      });
      try {
        fire(trigger(), "mouseenter");
        expect(content().hidden).toBe(true);
        expect(pressEscape()).toBe(false);
        // Shown by hand, it meets no scroll listener.
        content().hidden = false;
        window.dispatchEvent(new Event("scroll"));
        expect(content().hidden).toBe(false);
        expect(local.names()).toEqual(["open", "close"]);
        expect(local.reasons()).toEqual(["pointer", "api"]);
      } finally {
        local.stop();
      }
    });

    it("holds nothing for content whose controller a subscriber unloads from the open handler", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--tooltip-close-on-scroll-value="true"');
      let unloaded = false;
      root().addEventListener("stimeo--tooltip:open", () => {
        if (unloaded) return;
        unloaded = true;
        application.unload("stimeo--tooltip");
      });
      fire(trigger(), "mouseenter");
      expect(unloaded).toBe(true);
      expect(pressEscape()).toBe(false);
      window.dispatchEvent(new Event("scroll"));
      expect(content().hidden).toBe(false);
    });

    it("wires the scroll dismissal when closeOnScroll turns on while shown", async () => {
      focus(trigger(), "focusin");
      window.dispatchEvent(new Event("scroll"));
      expect(content().hidden).toBe(false);

      await setCloseOnScroll(true);
      expect(content().hidden).toBe(false);
      expect(capture.names()).toEqual(["open"]);
      window.dispatchEvent(new Event("scroll"));
      expect(content().hidden).toBe(true);
      expect(capture.names()).toEqual(["open", "close"]);
      expect(capture.reasons()).toEqual(["focus", "scroll"]);
    });

    it("releases the scroll dismissal when closeOnScroll turns off while shown", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--tooltip-close-on-scroll-value="true"');
      capture.clear();
      focus(trigger(), "focusin");

      await setCloseOnScroll(false);
      window.dispatchEvent(new Event("scroll"));
      expect(content().hidden).toBe(false);
      // The Escape layer is untouched by the flip.
      expect(pressEscape()).toBe(true);
      expect(content().hidden).toBe(true);
      expect(capture.names()).toEqual(["open", "close"]);
      expect(capture.reasons()).toEqual(["focus", "escape"]);
    });

    it("keeps a pending hide's promise when closeOnScroll turns off", async () => {
      disconnectAndStopApplication(application);
      await start(
        'data-stimeo--tooltip-close-on-scroll-value="true" data-stimeo--tooltip-hide-delay-value="200"',
      );
      capture.clear();
      fire(trigger(), "mouseenter");
      fire(trigger(), "mouseleave");

      await setCloseOnScroll(false);
      window.dispatchEvent(new Event("scroll"));
      expect(content().hidden).toBe(false);
      vi.advanceTimersByTime(200);
      expect(content().hidden).toBe(true);
      expect(capture.names()).toEqual(["open", "close"]);
      expect(capture.reasons()).toEqual(["pointer", "pointer"]);
    });

    it("wires nothing while hidden and reads closeOnScroll afresh at each reveal", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--tooltip-show-delay-value="200"');
      capture.clear();
      await setCloseOnScroll(true);
      window.dispatchEvent(new Event("scroll"));
      expect(content().hidden).toBe(true);
      expect(capture.seen).toEqual([]);

      // Flipped during the show delay: the reveal reads the current declaration.
      fire(trigger(), "mouseenter");
      await setCloseOnScroll(false);
      await setCloseOnScroll(true);
      vi.advanceTimersByTime(200);
      window.dispatchEvent(new Event("scroll"));
      expect(content().hidden).toBe(true);

      await setCloseOnScroll(false);
      fire(trigger(), "mouseleave");
      fire(trigger(), "mouseenter");
      vi.advanceTimersByTime(200);
      window.dispatchEvent(new Event("scroll"));
      expect(content().hidden).toBe(false);
      expect(capture.reasons()).toEqual(["pointer", "scroll", "pointer"]);
    });

    it("subscribes to no scroll when closeOnScroll turns on while hidden, so a scroll leaves a pending show alone", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--tooltip-show-delay-value="200"');
      capture.clear();
      const added = vi.spyOn(window, "addEventListener");
      const scrollSubscriptions = () => added.mock.calls.filter(([type]) => type === "scroll");
      try {
        await setCloseOnScroll(true);
        expect(scrollSubscriptions()).toHaveLength(0);

        fire(trigger(), "mouseenter");
        window.dispatchEvent(new Event("scroll"));
        vi.advanceTimersByTime(200);
        expect(content().hidden).toBe(false);

        // The reveal subscribes once, and that subscription dismisses.
        expect(scrollSubscriptions()).toHaveLength(1);
        window.dispatchEvent(new Event("scroll"));
        expect(content().hidden).toBe(true);
        expect(capture.reasons()).toEqual(["pointer", "scroll"]);
      } finally {
        added.mockRestore();
      }
    });

    it("keeps a scheduled delay's deadline and reads a changed delay at the next request", async () => {
      disconnectAndStopApplication(application);
      await start(
        'data-stimeo--tooltip-show-delay-value="300" data-stimeo--tooltip-hide-delay-value="200"',
      );
      capture.clear();
      fire(trigger(), "mouseenter");
      root().setAttribute("data-stimeo--tooltip-show-delay-value", "50");
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(299);
      expect(content().hidden).toBe(true);
      vi.advanceTimersByTime(1);
      expect(content().hidden).toBe(false);

      fire(trigger(), "mouseleave");
      root().setAttribute("data-stimeo--tooltip-hide-delay-value", "1000");
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(199);
      expect(content().hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(content().hidden).toBe(true);

      // The next requests read the declarations as they are now.
      fire(trigger(), "mouseenter");
      vi.advanceTimersByTime(50);
      expect(content().hidden).toBe(false);
      fire(trigger(), "mouseleave");
      vi.advanceTimersByTime(999);
      expect(content().hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(content().hidden).toBe(true);
      expect(capture.names()).toEqual(["open", "close", "open", "close"]);
      expect(capture.reasons()).toEqual(["pointer", "pointer", "pointer", "pointer"]);
    });

    it("shows, hides and schedules nothing when only a delay changes", async () => {
      root().setAttribute("data-stimeo--tooltip-show-delay-value", "300");
      root().setAttribute("data-stimeo--tooltip-hide-delay-value", "300");
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(content().hidden).toBe(true);

      root().setAttribute("data-stimeo--tooltip-show-delay-value", "0");
      fire(trigger(), "mouseenter");
      root().setAttribute("data-stimeo--tooltip-hide-delay-value", "0");
      await vi.advanceTimersByTimeAsync(1000);
      expect(content().hidden).toBe(false);
      expect(capture.names()).toEqual(["open"]);
    });

    it("subscribes once when a subscriber turns closeOnScroll on from the open handler", async () => {
      let flipped = false;
      root().addEventListener("stimeo--tooltip:open", () => {
        if (flipped) return;
        flipped = true;
        root().setAttribute("data-stimeo--tooltip-close-on-scroll-value", "true");
        controller().closeOnScrollValueChanged();
      });
      focus(trigger(), "focusin");
      await vi.advanceTimersByTimeAsync(0);
      window.dispatchEvent(new Event("scroll"));
      expect(content().hidden).toBe(true);

      // A second subscription would outlive the close and dismiss the next reveal.
      await setCloseOnScroll(false);
      focus(trigger(), "focusout");
      focus(trigger(), "focusin");
      window.dispatchEvent(new Event("scroll"));
      expect(content().hidden).toBe(false);
      expect(capture.reasons()).toEqual(["focus", "scroll", "focus"]);
    });
  });

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--tooltip");
    });

    afterEach(() => {
      capture.stop();
    });

    it("reports a pointer show, with the state already written", async () => {
      const states: string[] = [];
      root().addEventListener("stimeo--tooltip:open", () => {
        states.push(`${content().hidden} ${content().getAttribute("data-state")}`);
      });

      trigger().dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(0);

      expect(capture.names()).toEqual(["open"]);
      expect(capture.reasons()).toEqual(["pointer"]);
      expect(states).toEqual(["false open"]);
      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);
    });

    it("reports a focus-driven show as focus and its hide as focus", async () => {
      trigger().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(capture.reasons()).toEqual(["focus"]);

      capture.clear();
      trigger().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["focus"]);
    });

    it("reports one open with the first request's reason when a pending show is requested again", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--tooltip-show-delay-value="200"');
      trigger().dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(100);
      trigger().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1000);

      expect(capture.names()).toEqual(["open"]);
      expect(capture.reasons()).toEqual(["pointer"]);
    });

    it("reports one close with the first request's reason when a pending hide is requested again", async () => {
      disconnectAndStopApplication(application);
      await start('data-stimeo--tooltip-hide-delay-value="200"');
      trigger().dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(0);
      capture.clear();

      trigger().dispatchEvent(new MouseEvent("mouseleave"));
      await vi.advanceTimersByTimeAsync(100);
      controller().hide();
      await vi.advanceTimersByTimeAsync(1000);

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["pointer"]);
    });

    it("reports Escape as escape", async () => {
      trigger().dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(0);
      capture.clear();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["escape"]);
    });

    it("stays silent while connect normalizes and on a repeated show", async () => {
      const fresh = captureStateEvents("stimeo--tooltip");
      await start();
      expect(fresh.seen).toEqual([]);
      fresh.stop();

      trigger().dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(0);
      capture.clear();
      trigger().dispatchEvent(new MouseEvent("mouseenter"));
      await vi.advanceTimersByTimeAsync(0);

      expect(capture.seen).toEqual([]);
    });
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
