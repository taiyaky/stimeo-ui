import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FocusController } from "../src/controllers/focus_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link FocusController}: trap activation and the state hook,
 * Tab / Shift+Tab cycling, initial focus, restore-on-release, Escape, the optional
 * background `inert`, the no-scroll-lock and no-auto-focus options, and teardown.
 */

describe("FocusController", () => {
  let application: Application;

  const mount = async (attrs = "") => {
    // A second mount in one test would otherwise leave the first application running,
    // and it attaches its own controller to the new scope. That extra instance reacts
    // to the same value writes one microtask later, so an assertion between the write
    // and the callback reads a state no single controller ever produced.
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = `
      <button id="outside">outside</button>
      <div id="scope" data-controller="stimeo--focus" ${attrs}>
        <button id="a">a</button>
        <input id="b" aria-label="field" />
        <button id="c">c</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--focus", FocusController);
    await tick();
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const scope = () => query("#scope");
  const instance = () =>
    application.getControllerForElementAndIdentifier(scope(), "stimeo--focus") as FocusController;
  const tab = (shift = false) =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift }));

  it("activates the trap and moves focus to the first focusable by default", async () => {
    await mount();
    const events: string[] = [];
    scope().addEventListener("stimeo--focus:activate", () => events.push("activate"));

    instance().activate();
    expect(scope().getAttribute("data-focus-trapped")).toBe("true");
    expect(document.activeElement).toBe(query("#a"));
    expect(events).toEqual(["activate"]);
  });

  it("focuses the initial target when one is given", async () => {
    await mount();
    query("#b").setAttribute("data-stimeo--focus-target", "initial");
    await tick();
    instance().activate();
    expect(document.activeElement).toBe(query("#b"));
  });

  it("cycles Tab and Shift+Tab within the scope", async () => {
    await mount();
    instance().activate();

    (query("#c") as HTMLButtonElement).focus();
    tab(); // at last → wraps to first
    expect(document.activeElement).toBe(query("#a"));

    (query("#a") as HTMLButtonElement).focus();
    tab(true); // Shift+Tab at first → wraps to last
    expect(document.activeElement).toBe(query("#c"));
  });

  it("restores focus to the opener on release", async () => {
    await mount();
    const outside = query("#outside") as HTMLButtonElement;
    outside.focus();

    instance().activate();
    expect(document.activeElement).not.toBe(outside); // pulled inside

    instance().deactivate();
    expect(scope().hasAttribute("data-focus-trapped")).toBe(false);
    expect(document.activeElement).toBe(outside); // returned to the opener
  });

  it("releases the trap on Escape", async () => {
    await mount();
    const events: string[] = [];
    scope().addEventListener("stimeo--focus:deactivate", () => events.push("deactivate"));
    instance().activate();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(scope().hasAttribute("data-focus-trapped")).toBe(false);
    expect(events).toEqual(["deactivate"]);
  });

  it("does not move focus when auto is off", async () => {
    await mount('data-stimeo--focus-auto-value="false"');
    const outside = query("#outside") as HTMLButtonElement;
    outside.focus();
    instance().activate();
    expect(document.activeElement).toBe(outside); // focus left where it was
  });

  it("does not restore focus when restore is off", async () => {
    await mount('data-stimeo--focus-restore-value="false"');
    const outside = query("#outside") as HTMLButtonElement;
    outside.focus();
    instance().activate();
    instance().deactivate();
    expect(document.activeElement).not.toBe(outside);
  });

  it("isolates the background with inert only when requested", async () => {
    await mount(); // inert defaults to false
    const outside = query("#outside");
    instance().activate();
    expect(outside.inert).toBe(false); // soft boundary: background stays reachable
    instance().deactivate();

    await mount('data-stimeo--focus-inert-value="true"');
    const outside2 = query("#outside");
    instance().activate();
    expect(outside2.inert).toBe(true);
    instance().deactivate();
    expect(outside2.inert).toBe(false);
  });

  it("reads inert when the trap turns on, not while it is running", async () => {
    await mount(); // inert defaults to false
    const outside = query("#outside");
    instance().activate();

    scope().setAttribute("data-stimeo--focus-inert-value", "true");
    await tick();
    // The isolation belongs to the activation that started it, so a value written
    // mid-trap describes the next one rather than reshaping this one.
    expect(outside.inert).toBe(false);

    instance().deactivate();
    instance().activate();
    expect(outside.inert).toBe(true);
    instance().deactivate();
  });

  it("never locks page scroll (it is a focus scope, not a modal)", async () => {
    await mount();
    document.body.style.overflow = "scroll";
    instance().activate();
    expect(document.body.style.overflow).toBe("scroll"); // untouched
    instance().deactivate();
  });

  it("activates on connect when trap is set", async () => {
    await mount('data-stimeo--focus-trap-value="true"');
    expect(scope().getAttribute("data-focus-trapped")).toBe("true");
    expect(document.activeElement).toBe(query("#a"));
  });

  it("tears down without yanking focus on disconnect", async () => {
    await mount('data-stimeo--focus-trap-value="true"');
    query("#outside").focus();
    scope().remove();
    await tick();

    // Whether the listener is gone is read from the press itself. Focus is the wrong
    // witness here: the removed scope holds no tab stops, so a surviving handler takes
    // its empty-container path — it consumes the press and moves nothing, leaving
    // `activeElement` exactly where an unhandled press would.
    const press = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    document.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(query("#outside"));
  });

  it("keeps cycling through a focusable added after activation", async () => {
    // The scope tracks live children rather than a list taken at activate time,
    // so a control the application appends later joins the cycle.
    await mount('data-stimeo--focus-trap-value="true"');
    const late = document.createElement("button");
    late.id = "late";
    late.textContent = "late";
    scope().append(late);

    // The wrap is what the scope controls: a press in the middle of the order is
    // left to the engine. Reaching `late` from the front edge is what shows the
    // boundary moved — before it was appended, Shift+Tab from `#a` landed on `#c`.
    query("#a").focus();
    tab(true);
    expect(document.activeElement).toBe(late);
    tab();
    expect(document.activeElement).toBe(query("#a"));
  });

  it("does not re-enter activation while already trapping", async () => {
    await mount('data-stimeo--focus-trap-value="true"');
    const events: string[] = [];
    scope().addEventListener("stimeo--focus:activate", () => events.push("activate"));
    query("#c").focus();

    instance().activate();
    await tick();

    // Already trapping: no second announcement, and the caller keeps the focus it
    // had rather than being sent back to the initial element.
    expect(events).toEqual([]);
    expect(document.activeElement).toBe(query("#c"));
  });

  it("does not announce a release when nothing is trapping", async () => {
    await mount();
    const events: string[] = [];
    scope().addEventListener("stimeo--focus:deactivate", () => events.push("deactivate"));

    instance().deactivate();
    await tick();

    expect(events).toEqual([]);
    expect(scope().hasAttribute("data-focus-trapped")).toBe(false);
  });

  it("switches with the trap value at runtime", async () => {
    await mount();
    const events: string[] = [];
    scope().addEventListener("stimeo--focus:activate", () => events.push("activate"));
    scope().addEventListener("stimeo--focus:deactivate", () => events.push("deactivate"));

    scope().setAttribute("data-stimeo--focus-trap-value", "true");
    await tick();
    expect(scope().getAttribute("data-focus-trapped")).toBe("true");

    scope().setAttribute("data-stimeo--focus-trap-value", "false");
    await tick();
    expect(scope().hasAttribute("data-focus-trapped")).toBe(false);
    // One announcement per switch, in the order the switches happened.
    expect(events).toEqual(["activate", "deactivate"]);
  });

  it("returns the element to its untrapped form before the page is cached", async () => {
    await mount('data-stimeo--focus-trap-value="true"');
    const events: string[] = [];
    scope().addEventListener("stimeo--focus:deactivate", () => events.push("deactivate"));
    expect(scope().getAttribute("data-focus-trapped")).toBe("true");

    document.dispatchEvent(new Event("turbo:before-cache"));
    await tick();

    // The trap releases itself on the same event, so the hook is what would reach
    // the snapshot — describing a scope that is no longer trapping.
    expect(scope().hasAttribute("data-focus-trapped")).toBe(false);
    // Silent: the page is being frozen, not closed by anyone.
    expect(events).toEqual([]);
  });

  it("has no a11y violations", async () => {
    await mount('data-stimeo--focus-trap-value="true"');
    await expectNoA11yViolations(scope());
  });
});
