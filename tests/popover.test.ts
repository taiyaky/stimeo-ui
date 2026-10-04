import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PopoverController } from "../src/controllers/popover_controller";
import { EscapeLayer } from "../src/utils/escape_layer";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link PopoverController}: the modeless dialog contract —
 * toggle + ARIA sync, focus-into-panel on open, Escape restoration, modeless
 * outside-click/Tab dismissal, indeterminate focusout handling, and teardown.
 */
describe("PopoverController", () => {
  let application: Application;

  const defaultPanelInner = `
    <label id="label" for="field">Name</label>
    <input id="field" type="text" />
    <span id="padding">Panel padding</span>
    <button id="done" data-action="click->stimeo--popover#close">Done</button>`;

  const start = async (panelInner = defaultPanelInner, closeOnScroll = false) => {
    const value = closeOnScroll ? ' data-stimeo--popover-close-on-scroll-value="true"' : "";
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--popover"${value}>
          <button id="open" data-action="click->stimeo--popover#open">Open directly</button>
          <button id="trigger" data-stimeo--popover-target="trigger"
                  aria-haspopup="dialog" aria-expanded="false" aria-controls="pop"
                  data-action="click->stimeo--popover#toggle">Edit profile</button>
          <div id="pop" data-stimeo--popover-target="panel" role="dialog"
               aria-label="Edit profile" hidden>${panelInner}</div>
        </div>
        <button id="outside">Outside</button>
      </main>`;
    application = Application.start();
    application.register("stimeo--popover", PopoverController);
    await tick();
  };

  beforeEach(() => start());

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const trigger = () => query<HTMLButtonElement>("#trigger");
  const panel = () => query("#pop");
  const controller = (): PopoverController => {
    const instance = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--popover']"),
      "stimeo--popover",
    );
    if (!(instance instanceof PopoverController)) throw new Error("Popover controller not found");
    return instance;
  };

  it("starts closed with the collapsed ARIA state", () => {
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles open on trigger click and focuses the first focusable element", () => {
    trigger().click();
    expect(panel().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(query("#pop input"));
  });

  it("uses the shared Tab-stop rules when choosing panel focus", async () => {
    disconnectAndStopApplication(application);
    await start(`
      <fieldset disabled><button id="blocked">Blocked</button></fieldset>
      <div id="editor" contenteditable>Edit</div>
      <details><summary id="summary">More</summary></details>`);

    trigger().click();

    expect(document.activeElement).toBe(query("#editor"));
  });

  it("toggles closed on a second trigger click", () => {
    trigger().click();
    trigger().click();
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("binds the public open and close actions", () => {
    query<HTMLButtonElement>("#open").click();
    expect(panel().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    query<HTMLButtonElement>("#done").click();
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("focuses the panel itself when it has no focusable children", async () => {
    disconnectAndStopApplication(application);
    await start("<p>Just text</p>");
    trigger().click();
    expect(panel().getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(panel());
  });

  it("closes on Escape and restores focus to the trigger", () => {
    trigger().click();
    query<HTMLInputElement>("#field").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("consumes the Escape it owns", () => {
    trigger().click();
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    query<HTMLInputElement>("#field").dispatchEvent(event);
    // Owning the press marks it handled so outer layers skip the same Escape.
    expect(event.defaultPrevented).toBe(true);
    expect(panel().hidden).toBe(true);
  });

  it("ignores an Escape already handled by an inner layer", () => {
    trigger().click();
    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    query<HTMLInputElement>("#field").dispatchEvent(handled);
    expect(panel().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("rescues Escape via the document fallback after focus fell to the body", () => {
    trigger().click();
    // A click on non-focusable panel content blurs the panel without a focusout
    // destination, so the popover stays open while focus sits on the body — the
    // press then starts outside the root and only the fallback can see it.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("yields the press to a newer document layer while focus sits on the body", () => {
    trigger().click();
    (document.activeElement as HTMLElement | null)?.blur();

    // A layer activated above the popover (e.g. a modal trap) owns the press;
    // this popover must stay transparent until that layer goes away.
    let aboveDismissed = 0;
    const above = new EscapeLayer();
    above.activate(document, { onDismiss: () => aboveDismissed++ });
    const first = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(aboveDismissed).toBe(1);
    expect(panel().hidden).toBe(false);

    above.deactivate();
    const second = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);
    expect(panel().hidden).toBe(true);
  });

  it("closes on an outside click without restoring focus", () => {
    trigger().click();
    query("#outside").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).not.toBe(trigger());
  });

  it("stays open when a panel click handler removes the clicked node first", () => {
    // The failure mode that decides the listener phase. On bubble,
    // the inner handler runs first and detaches the node, so by the time the
    // document listener runs `event.target` is outside the tree and
    // `contains()` says "outside" — closing on what was an *inside* click.
    // On capture the document observes it first, against the tree the user
    // actually clicked. Menus that swap items on click hit this for real.
    const item = document.createElement("button");
    item.id = "self-removing";
    item.textContent = "Remove me";
    panel().append(item);
    item.addEventListener("click", () => {
      item.remove();
    });
    trigger().click();

    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(panel().hidden).toBe(false);
  });

  it("hands off to a second popover when its trigger is clicked", async () => {
    // The trade-off capture buys: `document` now sees the click
    // before the trigger's own handler, so the open instance must let go *and*
    // the new one must still open. Milder here than in the menu family — this
    // controller's outside-click close does not restore focus, so nothing moves
    // mid-dispatch — but "the second one never opens" is the same failure.
    const second = document.createElement("div");
    second.innerHTML = `
      <div data-controller="stimeo--popover">
        <button id="trigger2" data-stimeo--popover-target="trigger"
                aria-haspopup="dialog" aria-expanded="false" aria-controls="pop2"
                data-action="click->stimeo--popover#toggle">Second</button>
        <div id="pop2" data-stimeo--popover-target="panel" role="dialog"
             aria-label="Second" hidden><button>Inside two</button></div>
      </div>`;
    document.body.append(second);
    await tick();
    trigger().click();
    expect(panel().hidden).toBe(false);

    query("#trigger2").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(panel().hidden).toBe(true); // the first let go
    expect(query("#pop2").hidden).toBe(false); // and the second still opened
  });

  it("keeps open for label and non-focusable panel clicks after an indeterminate focusout", () => {
    trigger().click();
    const input = query<HTMLInputElement>("#field");

    for (const selector of ["#label", "#padding"]) {
      input.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null, bubbles: true }));
      query(selector).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(panel().hidden).toBe(false);
    }
  });

  it("ignores focusout with no destination", () => {
    trigger().click();
    query<HTMLInputElement>("#field").dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: null, bubbles: true }),
    );
    expect(panel().hidden).toBe(false);
  });

  it("closes when focus leaves the panel (Tab out) without restoring focus", () => {
    trigger().click();
    // focus moves to an element outside the controller → modeless close, no restore.
    const outside = query<HTMLButtonElement>("#outside");
    query<HTMLInputElement>("#field").dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: outside, bubbles: true }),
    );
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes after reverse focus traversal moves panel → trigger → outside", () => {
    trigger().click();
    query<HTMLInputElement>("#field").dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: trigger(), bubbles: true }),
    );
    expect(panel().hidden).toBe(false);

    trigger().dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: query("#outside"), bubbles: true }),
    );
    expect(panel().hidden).toBe(true);
  });

  it("removes the controller keydown listener on disconnect", () => {
    trigger().click();
    controller().disconnect();
    // An Escape after teardown must not throw or mutate anything further.
    query<HTMLInputElement>("#field").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(panel().hidden).toBe(false);
  });

  it("removes the document outside-click listener on disconnect", () => {
    trigger().click();
    controller().disconnect();
    query("#outside").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel().hidden).toBe(false);
  });

  it("removes the controller focusout listener when disconnected while open", () => {
    trigger().click();
    expect(panel().hidden).toBe(false);
    controller().disconnect();

    query<HTMLInputElement>("#field").dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: query("#outside"), bubbles: true }),
    );
    // If the listener leaked it would have closed the (already detached) panel.
    expect(panel().hidden).toBe(false);
  });

  it("does not dismiss on scroll unless closeOnScroll is set", () => {
    trigger().click();
    expect(panel().hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(panel().hidden).toBe(false);
  });

  it("dismisses on scroll when closeOnScroll is set (without restoring focus)", async () => {
    disconnectAndStopApplication(application);
    await start(defaultPanelInner, true);

    trigger().click();
    expect(panel().hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    // Closing on scroll must not yank focus back to the trigger (would fight scroll).
    expect(document.activeElement).not.toBe(trigger());
  });

  it("removes closeOnScroll listeners on disconnect", async () => {
    disconnectAndStopApplication(application);
    await start(defaultPanelInner, true);
    trigger().click();
    const instance = controller();
    const close = vi.spyOn(instance, "close");

    instance.disconnect();
    window.dispatchEvent(new Event("scroll"));

    expect(close).not.toHaveBeenCalled();
    expect(panel().hidden).toBe(false);
  });

  it("keeps an open panel open when it moves within the element", async () => {
    trigger().click();
    const moved = panel();
    const wrapper = document.createElement("div");
    moved.parentElement?.append(wrapper);
    wrapper.append(moved);
    await tick();

    // The node never left the element, so it is still the panel this popover shows.
    expect(moved.hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const press = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    moved.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(moved.hidden).toBe(true);
  });

  it("keeps an open panel open when another panel target leaves", async () => {
    const other = document.createElement("div");
    other.setAttribute("data-stimeo--popover-target", "panel");
    other.hidden = true;
    panel().after(other);
    await tick();
    trigger().click();
    expect(panel().hidden).toBe(false);

    other.remove();
    await tick();

    // Only the panel this popover shows holds what the open state lent.
    expect(panel().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const press = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    panel().dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it("cleans up closeOnScroll before returning when the panel target was removed", async () => {
    disconnectAndStopApplication(application);
    await start(defaultPanelInner, true);
    trigger().click();
    const instance = controller();
    const close = vi.spyOn(instance, "close");

    panel().remove();
    await tick();
    expect(instance.hasPanelTarget).toBe(false);

    instance.close();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(close).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("scroll"));
    expect(close).toHaveBeenCalledTimes(1);
  });

  // --- A trigger that takes over ---

  /**
   * The trigger carries the open state in `aria-expanded`. A trigger that takes over —
   * in one task, or after an earlier one leaves in a later task — carries that state,
   * silently.
   */
  describe("a trigger that takes over", () => {
    const root = () => query("[data-controller='stimeo--popover']");
    const firstTrigger = () => query<HTMLButtonElement>("[data-stimeo--popover-target='trigger']");
    /** A server-rendered copy of the trigger that still reads closed. */
    const staleTrigger = (): HTMLButtonElement => {
      const copy = trigger().cloneNode(true) as HTMLButtonElement;
      copy.id = "trigger-successor";
      copy.setAttribute("aria-expanded", "false");
      return copy;
    };

    it("reflects the open panel into a trigger replaced in one task", async () => {
      trigger().click();
      const successor = staleTrigger();
      trigger().replaceWith(successor);
      await tick();

      expect(firstTrigger()).toBe(successor);
      expect(successor.getAttribute("aria-expanded")).toBe("true");
    });

    it("reflects the open panel into the trigger that stays after an earlier one leaves", async () => {
      trigger().click();
      const original = trigger();
      const successor = staleTrigger();
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(firstTrigger()).toBe(successor);
      expect(successor.getAttribute("aria-expanded")).toBe("true");
    });

    it("reflects a panel the page hid into a trigger replaced in one task", async () => {
      trigger().click();
      panel().hidden = true;
      const successor = staleTrigger();
      successor.setAttribute("aria-expanded", "true");
      trigger().replaceWith(successor);
      await tick();

      expect(successor.getAttribute("aria-expanded")).toBe("false");
    });

    it("reflects a panel the page hid into the trigger that stays after an earlier one leaves", async () => {
      trigger().click();
      panel().hidden = true;
      const original = trigger();
      const successor = staleTrigger();
      successor.setAttribute("aria-expanded", "true");
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(successor.getAttribute("aria-expanded")).toBe("false");
    });

    it("reflects the closed panel into a trigger that takes over authored expanded", async () => {
      const successor = staleTrigger();
      successor.setAttribute("aria-expanded", "true");
      trigger().replaceWith(successor);
      await tick();

      expect(successor.getAttribute("aria-expanded")).toBe("false");
    });

    it("brings a trigger that arrives after the only one left to the open state", async () => {
      trigger().click();
      const late = staleTrigger();
      trigger().remove();
      await tick();

      root().prepend(late);
      await tick();

      expect(late.getAttribute("aria-expanded")).toBe("true");
    });

    it("writes nothing when a trigger arrives behind the current one", async () => {
      trigger().click();
      const writes: MutationRecord[] = [];
      const observer = new MutationObserver((records) => writes.push(...records));
      observer.observe(root(), { attributes: true, subtree: true });
      const behind = staleTrigger();
      trigger().after(behind);
      await tick();
      writes.push(...observer.takeRecords());
      observer.disconnect();

      expect(writes.map((write) => write.attributeName)).toEqual([]);
      expect(behind.getAttribute("aria-expanded")).toBe("false");
    });

    it("reports nothing while it moves the open state", async () => {
      trigger().click();
      const events = captureStateEvents("stimeo--popover");
      const changes: Event[] = [];
      const onChange = (event: Event): void => {
        changes.push(event);
      };
      document.addEventListener("change", onChange);
      const original = trigger();
      original.after(staleTrigger());
      await tick();
      original.remove();
      await tick();

      expect(events.seen).toEqual([]);
      expect(changes).toEqual([]);
      events.stop();
      document.removeEventListener("change", onChange);
    });

    it("tolerates the removal of the only trigger", () => {
      trigger().click();
      const only = trigger();
      only.remove();

      // Drive the callback directly: happy-dom delivers target callbacks unreliably.
      expect(() => controller().triggerTargetDisconnected(only)).not.toThrow();
    });

    it("writes nothing into the trigger that stays once it has disconnected", async () => {
      const original = trigger();
      const successor = staleTrigger();
      original.after(successor);
      await tick();
      original.click();
      const instance = controller();
      instance.disconnect();
      original.remove();
      instance.triggerTargetDisconnected(original);
      instance.triggerTargetConnected();
      await tick();

      expect(successor.getAttribute("aria-expanded")).toBe("false");
    });

    it("gives a trigger that stops being the trigger its own aria-expanded back", async () => {
      trigger().click();
      const former = trigger();
      const successor = staleTrigger();
      former.after(successor);
      await tick();

      // The element stays; only the attribute naming it the trigger goes.
      former.removeAttribute("data-stimeo--popover-target");
      await tick();

      expect(former.getAttribute("aria-expanded")).toBe("false");
      expect(successor.getAttribute("aria-expanded")).toBe("true");
    });

    it("gives the trigger its own aria-expanded back when the popover loses its controller", async () => {
      trigger().click();
      const departed = trigger();

      root().removeAttribute("data-controller");
      await tick();

      expect(departed.getAttribute("aria-expanded")).toBe("false");
    });

    it("keeps a value the page wrote on a trigger that stops being the trigger", async () => {
      trigger().click();
      const former = trigger();
      former.setAttribute("aria-expanded", "mixed");

      root().removeAttribute("data-controller");
      await tick();

      expect(former.getAttribute("aria-expanded")).toBe("mixed");
    });

    it("keeps what it wrote on a trigger that moves within the popover", async () => {
      trigger().click();
      const moving = trigger();
      const writes: MutationRecord[] = [];
      const observer = new MutationObserver((records) => writes.push(...records));
      observer.observe(moving, { attributes: true, attributeFilter: ["aria-expanded"] });

      root().append(moving);
      await tick();
      writes.push(...observer.takeRecords());
      observer.disconnect();

      expect(moving.getAttribute("aria-expanded")).toBe("true");
      expect(writes).toEqual([]);
    });

    it("keeps what it wrote when the whole popover leaves the page", async () => {
      trigger().click();
      const kept = trigger();

      root().remove();
      await tick();

      expect(kept.getAttribute("aria-expanded")).toBe("true");
    });
  });

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--popover");
    });

    afterEach(() => {
      capture.stop();
    });

    it("reports a trigger click as a user open, then a user close", () => {
      const states: string[] = [];
      query("[data-controller='stimeo--popover']").addEventListener("stimeo--popover:open", () => {
        states.push(`${panel().hidden} ${trigger().getAttribute("aria-expanded")}`);
      });

      trigger().click();
      trigger().click();

      expect(capture.names()).toEqual(["open", "close"]);
      expect(capture.reasons()).toEqual(["user", "user"]);
      expect(states).toEqual(["false true"]);
      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);
    });

    it("reports a call with no DOM event as api", () => {
      controller().open();
      controller().close();

      expect(capture.reasons()).toEqual(["api", "api"]);
    });

    it("reports an outside click as outside", () => {
      trigger().click();
      capture.clear();

      query<HTMLButtonElement>("#outside").click();

      expect(capture.reasons()).toEqual(["outside"]);
    });

    it("reports Escape as escape", () => {
      trigger().click();
      capture.clear();

      query("#field").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(capture.reasons()).toEqual(["escape"]);
    });

    it("reports a focusout to an outside destination as focus", () => {
      trigger().click();
      capture.clear();

      panel().dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: query("#outside") }),
      );

      expect(capture.reasons()).toEqual(["focus"]);
    });

    it("reports a dismissing scroll as scroll", async () => {
      disconnectAndStopApplication(application);
      await start(defaultPanelInner, true);
      const fresh = captureStateEvents("stimeo--popover");
      trigger().click();
      fresh.clear();

      window.dispatchEvent(new Event("scroll"));

      expect(fresh.reasons()).toEqual(["scroll"]);
      fresh.stop();
    });

    it("stays silent for an idempotent call in either direction", () => {
      controller().close();
      expect(capture.seen).toEqual([]);

      controller().open();
      capture.clear();
      controller().open();

      expect(capture.seen).toEqual([]);
    });

    it("stays silent while connect normalizes an authored-open panel", async () => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = `
        <div data-controller="stimeo--popover">
          <button id="trigger" data-stimeo--popover-target="trigger"
                  aria-expanded="true">Edit profile</button>
          <div id="pop" data-stimeo--popover-target="panel" role="dialog"></div>
        </div>`;
      const fresh = captureStateEvents("stimeo--popover");
      application = Application.start();
      application.register("stimeo--popover", PopoverController);
      await tick();

      expect(panel().hidden).toBe(true);
      expect(fresh.seen).toEqual([]);
      fresh.stop();
    });

    it("stays silent through a disconnect and a Turbo-style reconnect", async () => {
      trigger().click();
      capture.clear();

      const element = query("[data-controller='stimeo--popover']");
      element.remove();
      await tick();
      document.body.append(element);
      await tick();

      expect(panel().hidden).toBe(true);
      expect(capture.seen).toEqual([]);
    });
  });

  // --- What the open panel holds ---

  describe("what the open panel holds", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--popover");
    });

    afterEach(() => {
      capture.stop();
    });

    const root = () => query("[data-controller='stimeo--popover']");

    /**
     * Presses Escape at the document with focus on the body, where the layer
     * claims a press, and reports whether a layer consumed it.
     */
    const pressEscape = (): boolean => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
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
      root().setAttribute("data-stimeo--popover-close-on-scroll-value", String(on));
      await tick();
      controller().closeOnScrollValueChanged();
    };

    /** A server-rendered replacement for the panel, as a morph swaps it in. */
    const freshPanel = (): HTMLElement => {
      const element = document.createElement("div");
      element.id = "pop";
      element.setAttribute("data-stimeo--popover-target", "panel");
      element.setAttribute("role", "dialog");
      element.setAttribute("aria-label", "Edit profile");
      element.hidden = true;
      element.innerHTML = '<input id="fresh-field" type="text" aria-label="Name" />';
      return element;
    };

    const leaveBy = {
      "an outside click": () => query<HTMLButtonElement>("#outside").click(),
      "focus leaving for the outside": () =>
        query("#field").dispatchEvent(
          new FocusEvent("focusout", { bubbles: true, relatedTarget: query("#outside") }),
        ),
    } as const;

    for (const [how, leave] of Object.entries(leaveBy)) {
      for (const hiddenByPage of [false, true]) {
        it(`releases what the panel holds at ${how} (hidden by the page: ${hiddenByPage})`, async () => {
          disconnectAndStopApplication(application);
          await start(defaultPanelInner, true);
          trigger().click();
          capture.clear();
          // The page hides the open panel itself, leaving the element in place.
          if (hiddenByPage) panel().hidden = true;
          expect(trigger().getAttribute("aria-expanded")).toBe("true");

          leave();

          expect(panel().hidden).toBe(true);
          expect(trigger().getAttribute("aria-expanded")).toBe("false");
          expect(pressEscape()).toBe(false);
          // No scroll listener is left: a panel shown again by hand stays shown.
          panel().hidden = false;
          window.dispatchEvent(new Event("scroll"));
          expect(panel().hidden).toBe(false);
          // A panel the page already hid reads closed, so closing it moves nothing to report.
          expect(capture.seen.length).toBe(hiddenByPage ? 0 : 1);
        });
      }

      it(`closes a panel the page showed itself at ${how}, holding nothing`, () => {
        panel().hidden = false;
        leave();
        expect(panel().hidden).toBe(true);
        expect(capture.names()).toEqual(["close"]);
      });
    }

    it("releases what a panel the page hid holds at the next Escape, which it consumes once", async () => {
      disconnectAndStopApplication(application);
      await start(defaultPanelInner, true);
      trigger().click();
      capture.clear();
      panel().hidden = true;

      // The trigger still reads expanded, so the press collapses it.
      expect(pressEscape()).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(pressEscape()).toBe(false);
      expect(capture.seen).toEqual([]);
    });

    it("releases what a panel the page hid holds at the next dismissing scroll", async () => {
      disconnectAndStopApplication(application);
      await start(defaultPanelInner, true);
      trigger().click();
      capture.clear();
      panel().hidden = true;

      window.dispatchEvent(new Event("scroll"));
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(pressEscape()).toBe(false);
      expect(capture.seen).toEqual([]);
    });

    it("writes nothing when focus leaves the trigger of a closed popover", () => {
      const observer = new MutationObserver(() => {});
      observer.observe(root(), { attributes: true, subtree: true });

      // Tabbing past a closed popover's trigger is not a close.
      trigger().dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: query("#outside") }),
      );
      expect(observer.takeRecords()).toEqual([]);
      observer.disconnect();
      expect(capture.seen).toEqual([]);
    });

    it("keeps holding the layer and aria-expanded while the open panel stays", async () => {
      trigger().click();
      await tick();
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(pressEscape()).toBe(true);
      expect(panel().hidden).toBe(true);
    });

    it("releases the layer, the scroll dismissal and aria-expanded when the open panel leaves", async () => {
      disconnectAndStopApplication(application);
      await start(defaultPanelInner, true);
      trigger().click();
      capture.clear();

      const departed = panel();
      departed.remove();
      await tick();

      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(departed.hidden).toBe(true);
      expect(pressEscape()).toBe(false);
      // No scroll listener is left: a panel put back and shown by hand stays shown.
      root().append(departed);
      departed.hidden = false;
      window.dispatchEvent(new Event("scroll"));
      expect(departed.hidden).toBe(false);
      // Target churn is not a state move anyone made, so it reports nothing.
      expect(capture.seen).toEqual([]);
    });

    for (const order of ["removed first", "added first"] as const) {
      it(`hands the next open to a panel a morph swapped in (${order})`, async () => {
        disconnectAndStopApplication(application);
        await start(defaultPanelInner, true);
        trigger().click();
        capture.clear();

        const departed = panel();
        const arrived = freshPanel();
        if (order === "removed first") {
          departed.replaceWith(arrived);
        } else {
          departed.after(arrived);
          await tick();
          departed.remove();
        }
        await tick();

        expect(trigger().getAttribute("aria-expanded")).toBe("false");
        expect(arrived.hidden).toBe(true);
        expect(pressEscape()).toBe(false);
        expect(capture.seen).toEqual([]);

        trigger().click();
        expect(arrived.hidden).toBe(false);
        expect(document.activeElement).toBe(query("#fresh-field"));
        window.dispatchEvent(new Event("scroll"));
        expect(arrived.hidden).toBe(true);
        // The scroll close released the one layer this open took.
        expect(pressEscape()).toBe(false);
        expect(capture.names()).toEqual(["open", "close"]);
        expect(capture.reasons()).toEqual(["user", "scroll"]);
      });
    }

    it("writes the closed state onto a replacement panel that arrives shown", async () => {
      trigger().click();
      const departed = panel();
      const arrived = freshPanel();
      arrived.hidden = false;
      departed.replaceWith(arrived);
      await tick();
      expect(arrived.hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(capture.names()).toEqual(["open"]);
    });

    it("leaves the DOM alone when the panel's disconnect follows the controller's", async () => {
      disconnectAndStopApplication(application);
      await start(defaultPanelInner, true);
      trigger().click();
      const shown = panel();

      // Stimulus tears down the controller first, then each of its targets.
      controller().disconnect();
      controller().panelTargetDisconnected(shown);
      expect(shown.hidden).toBe(false);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(pressEscape()).toBe(false);
      window.dispatchEvent(new Event("scroll"));
      expect(shown.hidden).toBe(false);

      // The same instance reconnects and holds exactly one layer again.
      controller().connect();
      trigger().click();
      expect(pressEscape()).toBe(true);
      expect(shown.hidden).toBe(true);
      expect(pressEscape()).toBe(false);
    });

    it("releases once when the open panel leaves before the controller disconnects", async () => {
      trigger().click();
      const departed = panel();
      departed.remove();
      await tick();
      controller().panelTargetDisconnected(departed);
      controller().disconnect();
      controller().panelTargetDisconnected(departed);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(pressEscape()).toBe(false);
      expect(capture.names()).toEqual(["open"]);
    });

    it("wires the scroll dismissal when closeOnScroll turns on while open", async () => {
      trigger().click();
      window.dispatchEvent(new Event("scroll"));
      expect(panel().hidden).toBe(false);

      await setCloseOnScroll(true);
      expect(panel().hidden).toBe(false);
      expect(capture.names()).toEqual(["open"]);
      window.dispatchEvent(new Event("scroll"));
      expect(panel().hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(capture.names()).toEqual(["open", "close"]);
      expect(capture.reasons()).toEqual(["user", "scroll"]);
    });

    it("releases the scroll dismissal when closeOnScroll turns off while open", async () => {
      disconnectAndStopApplication(application);
      await start(defaultPanelInner, true);
      trigger().click();
      capture.clear();

      await setCloseOnScroll(false);
      window.dispatchEvent(new Event("scroll"));
      expect(panel().hidden).toBe(false);
      // The Escape layer is untouched by the flip.
      expect(pressEscape()).toBe(true);
      expect(panel().hidden).toBe(true);
      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["escape"]);
    });

    it("wires nothing while closed and reads closeOnScroll afresh at each open", async () => {
      await setCloseOnScroll(true);
      window.dispatchEvent(new Event("scroll"));
      expect(panel().hidden).toBe(true);
      expect(capture.seen).toEqual([]);

      trigger().click();
      window.dispatchEvent(new Event("scroll"));
      expect(panel().hidden).toBe(true);

      await setCloseOnScroll(false);
      trigger().click();
      window.dispatchEvent(new Event("scroll"));
      expect(panel().hidden).toBe(false);
      expect(capture.reasons()).toEqual(["user", "scroll", "user"]);
    });

    it("subscribes once when a subscriber turns closeOnScroll on from the open handler", async () => {
      let flipped = false;
      root().addEventListener("stimeo--popover:open", () => {
        if (flipped) return;
        flipped = true;
        root().setAttribute("data-stimeo--popover-close-on-scroll-value", "true");
        controller().closeOnScrollValueChanged();
      });
      trigger().click();
      await tick();
      window.dispatchEvent(new Event("scroll"));
      expect(panel().hidden).toBe(true);

      // A second subscription would outlive the close and dismiss the next open.
      await setCloseOnScroll(false);
      trigger().click();
      window.dispatchEvent(new Event("scroll"));
      expect(panel().hidden).toBe(false);
      expect(capture.reasons()).toEqual(["user", "scroll", "user"]);
    });

    it("holds nothing for a panel whose controller a subscriber unloads from the open handler", async () => {
      disconnectAndStopApplication(application);
      await start(defaultPanelInner, true);
      let unloaded = false;
      root().addEventListener("stimeo--popover:open", () => {
        if (unloaded) return;
        unloaded = true;
        application.unload("stimeo--popover");
      });
      trigger().click();
      expect(unloaded).toBe(true);
      expect(panel().contains(document.activeElement)).toBe(false);
      expect(pressEscape()).toBe(false);
      window.dispatchEvent(new Event("scroll"));
      expect(panel().hidden).toBe(false);
    });

    it("wires nothing when the open handler closes the panel again", async () => {
      disconnectAndStopApplication(application);
      await start(defaultPanelInner, true);
      let closed = false;
      root().addEventListener("stimeo--popover:open", () => {
        if (closed) return;
        closed = true;
        controller().close();
        root().setAttribute("data-stimeo--popover-close-on-scroll-value", "true");
        controller().closeOnScrollValueChanged();
      });
      trigger().click();
      expect(panel().hidden).toBe(true);
      expect(pressEscape()).toBe(false);
      panel().hidden = false;
      window.dispatchEvent(new Event("scroll"));
      expect(panel().hidden).toBe(false);
    });
  });

  // --- Re-entry from a subscriber ---

  describe("re-entry from a subscriber", () => {
    it("leaves no focus inside the panel when the open handler closes it again", () => {
      query("[data-controller='stimeo--popover']").addEventListener("stimeo--popover:open", () =>
        controller().close(),
      );

      controller().open();

      expect(panel().hidden).toBe(true);
      expect(panel().contains(document.activeElement)).toBe(false);
    });

    it("takes no layer and no focus when the open handler hides the panel itself", () => {
      query("[data-controller='stimeo--popover']").addEventListener("stimeo--popover:open", () => {
        panel().hidden = true;
      });

      controller().open();

      expect(panel().contains(document.activeElement)).toBe(false);
      const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      document.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(false);
    });
  });
});

describe("PopoverController accessibility", () => {
  let application: Application;

  const startReal = async () => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--popover">
          <button data-stimeo--popover-target="trigger" aria-haspopup="dialog"
                  aria-expanded="false" aria-controls="pop2"
                  data-action="click->stimeo--popover#toggle">Edit profile</button>
          <div id="pop2" data-stimeo--popover-target="panel" role="dialog"
               aria-label="Edit profile" hidden>
            <label>Name <input type="text" /></label>
          </div>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--popover", PopoverController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("has no machine-detectable a11y violations when open", async () => {
    await startReal();
    query<HTMLButtonElement>("[data-stimeo--popover-target='trigger']").click();
    await expectNoA11yViolations(document.body);
  });

  it("announces the trigger as a popup button", async () => {
    await startReal();
    const spoken = await captureSpeech({ container: query("main"), steps: 1 });
    // Freeze the whole ordered array (not a name-only `toContain`): the trigger must
    // keep its button role, name, and the popup/collapsed state.
    expect(spoken).toEqual([
      "main",
      "button, Edit profile, 1 control, not expanded, has popup dialog",
    ]);
  });
});
