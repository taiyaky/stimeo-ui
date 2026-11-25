import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PopoverController } from "../src/controllers/popover_controller";
import { EscapeLayer } from "../src/utils/escape_layer";
import { query } from "./helpers/dom";
import { keyEvent, typeKey } from "./helpers/keyboard";
import { recordListeners } from "./helpers/listeners";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Popover state survives target handoff while borrowed panel attributes follow their owner. */
describe("Popover target handoff", () => {
  let application: Application;
  let events: ReturnType<typeof captureStateEvents>;

  const host = () => query("#host");
  const trigger = () => query<HTMLButtonElement>("#trigger");
  const panel = () => query("#panel");
  const instance = (): PopoverController => {
    const controller = application.getControllerForElementAndIdentifier(host(), "stimeo--popover");
    if (!(controller instanceof PopoverController)) throw new Error("Missing popover controller");
    return controller;
  };
  const mount = async (content = '<input id="field" aria-label="Name">', attributes = "hidden") => {
    document.body.innerHTML = `<div id="host" data-controller="stimeo--popover"
      data-stimeo--popover-close-on-scroll-value="true">
      <button id="trigger" data-stimeo--popover-target="trigger" aria-expanded="false"
        data-action="click->stimeo--popover#toggle">Edit</button>
      <div id="panel" data-stimeo--popover-target="panel" role="dialog"
        aria-label="Edit" ${attributes}>${content}</div>
      <div id="slot"></div>
    </div><button id="outside">Outside</button>`;
    application = Application.start();
    application.register("stimeo--popover", PopoverController);
    await tick();
  };
  const replacement = () => {
    const next = document.createElement("div");
    next.id = "panel";
    next.setAttribute("data-stimeo--popover-target", "panel");
    next.setAttribute("role", "dialog");
    next.setAttribute("aria-label", "Edit");
    next.hidden = true;
    next.innerHTML = '<input id="successor-field" aria-label="Name">';
    return next;
  };
  const pressEscape = () => {
    const press = keyEvent("Escape");
    // A missing panel leaves focus on the body, where the popover still claims Escape.
    typeKey(document, press);
    return press.defaultPrevented;
  };

  beforeEach(async () => {
    await mount();
    events = captureStateEvents("stimeo--popover");
  });
  afterEach(() => {
    events.stop();
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  for (const restored of [false, true]) {
    for (const departure of ["token", "identifier"]) {
      it(`returns hidden and fallback tabindex after ${departure}, restored=${restored}`, async () => {
        disconnectAndStopApplication(application);
        await mount("<p>Static content</p>");
        trigger().click();
        expect(panel().getAttribute("hidden")).toBeNull();
        expect(panel().getAttribute("tabindex")).toBe("-1");
        if (restored) {
          application = await restoreFromCache(application, (restoredApplication) =>
            restoredApplication.register("stimeo--popover", PopoverController),
          );
        }
        const departed = panel();
        events.clear();
        if (departure === "token") departed.removeAttribute("data-stimeo--popover-target");
        else host().removeAttribute("data-controller");
        await tick();

        expect(departed.getAttribute("hidden")).toBe("");
        expect(departed.hasAttribute("tabindex")).toBe(false);
        expect(departed.getAttributeNames().filter((name) => /-(lease|loan)$/.test(name))).toEqual(
          [],
        );
        expect(events.seen).toEqual([]);
      });
    }
  }

  it("keeps later authored visibility and tabindex when the panel stops being a target", async () => {
    disconnectAndStopApplication(application);
    await mount("<p>Static content</p>");
    trigger().click();
    const departed = panel();
    departed.setAttribute("hidden", "until-found");
    departed.setAttribute("tabindex", "3");

    departed.removeAttribute("data-stimeo--popover-target");
    await tick();

    expect(departed.getAttribute("hidden")).toBe("until-found");
    expect(departed.getAttribute("tabindex")).toBe("3");
    expect(departed.getAttributeNames().filter((name) => /-(lease|loan)$/.test(name))).toEqual([]);
  });

  it("keeps the open panel and its borrowed attributes during a same-scope move and whole-root detach", async () => {
    disconnectAndStopApplication(application);
    await mount("<p>Static content</p>");
    trigger().click();
    const kept = panel();
    const attributes = kept.outerHTML;
    query("#slot").append(kept);
    await tick();
    expect(kept.outerHTML).toBe(attributes);

    const root = host();
    root.remove();
    await tick();
    expect(kept.outerHTML).toBe(attributes);
  });

  it("keeps a later hidden-until-found value on a closed panel when focus leaves", () => {
    panel().setAttribute("hidden", "until-found");

    trigger().dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: query("#outside"), bubbles: true }),
    );

    expect(panel().getAttribute("hidden")).toBe("until-found");
    expect(events.seen).toEqual([]);
  });

  it("writes a replacement before reporting a fresh open in the same task", () => {
    const next = replacement();
    const visibility: boolean[] = [];
    host().addEventListener("stimeo--popover:open", () =>
      visibility.push(next.hasAttribute("hidden")),
    );
    panel().replaceWith(next);

    instance().open();

    expect(visibility).toEqual([false]);
    expect(document.activeElement).toBe(query("#successor-field"));
  });

  it("retains a fresh open request while no panel is present", async () => {
    panel().remove();
    await tick();

    instance().open();

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(events.names()).toEqual(["open"]);
    host().append(replacement());
    await tick();
    expect(panel().hidden).toBe(false);
    expect(document.activeElement).toBe(document.body);
    expect(pressEscape()).toBe(true);
  });

  it("carries a page-hidden panel's closed state to its replacement and releases Escape", async () => {
    trigger().click();
    events.clear();
    panel().hidden = true;
    const next = replacement();
    next.hidden = false;

    panel().replaceWith(next);
    await tick();

    expect(next.hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(pressEscape()).toBe(false);
    expect(events.seen).toEqual([]);
  });

  it("returns a departing panel's attributes before a same-task close reports", async () => {
    disconnectAndStopApplication(application);
    await mount("<p>Static content</p>", 'hidden="until-found"');
    trigger().click();
    const departed = panel();
    const returned: (string | null)[][] = [];
    host().addEventListener("stimeo--popover:close", () => {
      returned.push([departed.getAttribute("hidden"), departed.getAttribute("tabindex")]);
    });
    departed.replaceWith(replacement());

    instance().close();

    expect(returned).toEqual([["until-found", null]]);
  });

  it("conceals a former first panel that stays a target when another is inserted before it", async () => {
    disconnectAndStopApplication(application);
    await mount("<p>Static content</p>");
    trigger().click();
    const former = panel();
    former.id = "former";
    const next = replacement();
    events.clear();

    former.before(next);
    await tick();

    expect(former.hidden).toBe(true);
    expect(former.hasAttribute("tabindex")).toBe(false);
    expect(next.hidden).toBe(false);
    expect(events.seen).toEqual([]);
  });

  for (const route of ["outside click", "focusout", "document focusin"]) {
    it(`normalizes a closed replacement before a same-task ${route} returns`, () => {
      const next = replacement();
      next.hidden = false;
      panel().replaceWith(next);

      if (route === "outside click") query("#outside").click();
      else if (route === "focusout") {
        host().dispatchEvent(
          new FocusEvent("focusout", { relatedTarget: query("#outside"), bubbles: true }),
        );
      } else query("#outside").focus();

      expect(next.hidden).toBe(true);
      expect(events.seen).toEqual([]);
    });
  }

  it.each(["", 'hidden="until-found"', 'hidden="hidden" tabindex="2"'])(
    "returns exact authored panel attributes: %s",
    async (attributes) => {
      disconnectAndStopApplication(application);
      await mount("<p>Static content</p>", attributes);
      const departing = panel();
      const authoredHidden = attributes.includes("until-found")
        ? "until-found"
        : attributes.includes('hidden="hidden"')
          ? "hidden"
          : null;
      trigger().click();

      departing.removeAttribute("data-stimeo--popover-target");
      await tick();

      expect(departing.getAttribute("hidden")).toBe(authoredHidden);
      expect(departing.getAttribute("tabindex")).toBe(attributes.includes("tabindex") ? "2" : null);
    },
  );

  for (const form of ["settled", "same task", "absent"]) {
    for (const action of ["none", "close", "toggle", "open", "Escape"]) {
      it(`carries state through ${form} replacement before ${action}`, async () => {
        trigger().click();
        const departed = panel();
        const next = replacement();
        events.clear();
        if (form === "absent") {
          departed.remove();
          await tick();
        } else {
          departed.replaceWith(next);
          if (form === "settled") await tick();
        }
        let consumed: boolean | undefined;
        if (action === "Escape") consumed = pressEscape();
        else if (action !== "none") instance()[action as "open" | "close" | "toggle"]();
        if (form === "absent") host().append(next);
        await tick();

        const open = action === "none" || action === "open";
        expect(next.hidden).toBe(!open);
        expect(trigger().getAttribute("aria-expanded")).toBe(String(open));
        expect(events.names()).toEqual(open ? [] : ["close"]);
        if (action === "Escape") {
          expect(consumed).toBe(true);
          expect(document.activeElement).toBe(trigger());
          expect(pressEscape()).toBe(false);
        } else {
          expect(document.activeElement).toBe(document.body);
        }
      });
    }
  }

  it("drops scroll while absent, keeps Escape order, and resumes scroll on return", async () => {
    const ledger = recordListeners();
    const newer = new EscapeLayer();
    try {
      trigger().click();
      const departed = panel();
      const next = replacement();
      events.clear();
      departed.remove();
      window.dispatchEvent(new Event("scroll"));
      await tick();
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(ledger.live(window, "scroll")).toHaveLength(0);
      newer.activate(document, { onDismiss: () => newer.deactivate() });
      host().append(next);
      await tick();
      expect(next.hidden).toBe(false);
      expect(ledger.live(window, "scroll")).toHaveLength(1);
      expect(pressEscape()).toBe(true);
      expect(next.hidden).toBe(false);

      window.dispatchEvent(new Event("scroll"));

      expect(next.hidden).toBe(true);
      expect(events.reasons()).toEqual(["scroll"]);
      expect(ledger.live(window, "scroll")).toHaveLength(0);
      expect(pressEscape()).toBe(false);
    } finally {
      newer.deactivate();
      ledger.restore();
    }
  });

  it("closes the retained state at a known external focus destination", async () => {
    trigger().click();
    panel().remove();
    await tick();
    events.clear();

    query("#outside").focus();
    host().append(replacement());
    await tick();

    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(query("#outside"));
    expect(events.reasons()).toEqual(["focus"]);
    expect(pressEscape()).toBe(false);
  });

  it("continues opening on a panel replaced inside the open subscriber", () => {
    const next = replacement();
    host().addEventListener("stimeo--popover:open", () => panel().replaceWith(next), {
      once: true,
    });

    instance().open();

    expect(next.hidden).toBe(false);
    expect(document.activeElement).toBe(query("#successor-field"));
    expect(events.names()).toEqual(["open"]);
    expect(pressEscape()).toBe(true);
    expect(next.hidden).toBe(true);
  });

  it("does not resume an older open after a subscriber closes and opens again", () => {
    const newer = new EscapeLayer();
    const focus = vi.spyOn(query("#field"), "focus");
    let reentered = false;
    host().addEventListener(
      "stimeo--popover:open",
      () => {
        if (reentered) return;
        reentered = true;
        instance().close();
        instance().open();
        newer.activate(document, { onDismiss: () => newer.deactivate() });
      },
      { once: true },
    );
    try {
      instance().open();

      expect(focus).toHaveBeenCalledTimes(1);
      expect(pressEscape()).toBe(true);
      expect(panel().hidden).toBe(false);
      expect(pressEscape()).toBe(true);
      expect(panel().hidden).toBe(true);
    } finally {
      newer.deactivate();
    }
  });

  for (const checked of [false, true]) {
    it(`focuses the native radio-group entry, checked=${checked}`, async () => {
      disconnectAndStopApplication(application);
      await mount(`<input id="radio-1" type="radio" name="choice" aria-label="One">
        <input id="radio-2" type="radio" name="choice" aria-label="Two" ${checked ? "checked" : ""}>
        <input id="radio-3" type="radio" name="choice" aria-label="Three">`);

      trigger().click();

      expect(document.activeElement).toBe(query(checked ? "#radio-2" : "#radio-1"));
    });
  }
});
