import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FocusController } from "../src/controllers/focus_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

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

  it("takes every Tab in the middle of the order and moves focus itself", async () => {
    await mount();
    instance().activate();

    const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    query("#a").dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(query("#b"));

    const backward = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    query("#b").dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(query("#a"));
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

  it("gives back the tabindex it kept on a text-only scope once disconnected after focus left it", async () => {
    await mount('data-stimeo--focus-restore-value="false"');
    scope().innerHTML = "<p>Text only</p>";
    instance().activate();
    instance().deactivate();
    expect(document.activeElement).toBe(scope());
    expect(scope().getAttribute("tabindex")).toBe("-1");
    (query("#outside") as HTMLButtonElement).focus();
    const departed = scope();

    departed.remove();
    await tick();

    expect(departed.getAttribute("tabindex")).toBeNull();
  });

  /**
   * Releases a text-only scope without returning focus, so it keeps focus and the tabindex
   * lent to it, then moves focus outside.
   */
  const keepLoanThenLeave = async (): Promise<void> => {
    await mount('data-stimeo--focus-restore-value="false"');
    scope().innerHTML = "<p>Text only</p>";
    instance().activate();
    instance().deactivate();
    expect(document.activeElement).toBe(scope());
    expect(scope().getAttribute("tabindex")).toBe("-1");
    (query("#outside") as HTMLButtonElement).focus();
  };

  it("keeps the tabindex it kept on a released scope when the scope moves within the page", async () => {
    await keepLoanThenLeave();
    const controller = instance();

    document.body.append(document.createElement("hr"), scope());
    await tick();

    expect(instance()).toBe(controller);
    expect(scope().getAttribute("tabindex")).toBe("-1");
  });

  it("gives the kept tabindex back a microtask after a disconnect that leaves the scope in place with no reconnect", async () => {
    await keepLoanThenLeave();

    instance().disconnect();
    expect(scope().getAttribute("tabindex")).toBe("-1");
    await flushMicrotasks();

    expect(scope().getAttribute("tabindex")).toBeNull();
  });

  it("gives the kept tabindex back once the scope loses its identifier", async () => {
    await keepLoanThenLeave();
    const departed = scope();

    departed.removeAttribute("data-controller");
    await tick();

    expect(departed.getAttribute("tabindex")).toBeNull();
  });

  it("releases an active scope at once when it disconnects in place", async () => {
    await mount('data-stimeo--focus-inert-value="true"');
    instance().activate();
    expect(query("#outside").inert).toBe(true);

    instance().disconnect();

    expect(query("#outside").inert).toBe(false);
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

  /**
   * `inert` follows while the trap runs. Stimulus delivers Value callbacks through a
   * `MutationObserver` happy-dom may drop, so each case writes the attribute and runs
   * the callback itself; a second delivery finds the isolation already as declared.
   */
  const declareInert = (on: boolean) => {
    scope().setAttribute("data-stimeo--focus-inert-value", String(on));
    instance().inertValueChanged();
  };

  it("isolates and releases the background in place when inert changes mid-trap", async () => {
    await mount(); // inert defaults to false
    const outside = query("#outside");
    outside.focus();
    const events: string[] = [];
    scope().addEventListener("stimeo--focus:activate", () => events.push("activate"));
    scope().addEventListener("stimeo--focus:deactivate", () => events.push("deactivate"));
    instance().activate();
    query("#c").focus();

    declareInert(true);
    expect(outside.inert).toBe(true);
    expect(document.activeElement).toBe(query("#c"));

    declareInert(false);
    expect(outside.inert).toBe(false);
    expect(document.activeElement).toBe(query("#c"));

    declareInert(true);
    expect(outside.inert).toBe(true);

    // The running trap kept its opener, and nothing restarted it.
    instance().deactivate();
    expect(outside.inert).toBe(false);
    expect(document.activeElement).toBe(outside);
    expect(events).toEqual(["activate", "deactivate"]);
  });

  it("moves focus from the background into the scope when inert turns on", async () => {
    await mount();
    query("#b").setAttribute("data-stimeo--focus-target", "initial");
    await tick();
    instance().activate();
    query("#outside").focus(); // a soft boundary lets focus reach the background

    declareInert(true);
    // The background is about to drop that focus, so it goes where activation sends it.
    expect(document.activeElement).toBe(query("#b"));
  });

  it("leaves the background alone when inert changes while nothing is trapping", async () => {
    await mount();
    const outside = query("#outside");
    outside.focus();
    declareInert(true);
    expect(outside.inert).toBe(false);
    expect(document.activeElement).toBe(outside);

    instance().activate();
    expect(outside.inert).toBe(true); // the next activation reads it
    instance().deactivate();
  });

  it("ignores an inert change after disconnect", async () => {
    await mount('data-stimeo--focus-trap-value="true"');
    const outside = query("#outside");
    const controller = instance();
    controller.disconnect();
    outside.focus();
    declareInert(true);
    expect(outside.inert).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it("reads auto when the trap turns on: a mid-trap change moves no focus", async () => {
    await mount();
    const outside = query("#outside");
    outside.focus();
    instance().activate();
    query("#c").focus();

    scope().setAttribute("data-stimeo--focus-auto-value", "false");
    await tick();
    // The initial focus move belongs to the activation that made it.
    expect(document.activeElement).toBe(query("#c"));

    instance().deactivate();
    expect(document.activeElement).toBe(outside);
    instance().activate();
    expect(document.activeElement).toBe(outside); // the next activation reads the new value
    instance().deactivate();
  });

  it("reads restore when the trap turns off, so a mid-trap change decides that release", async () => {
    await mount();
    const outside = query("#outside");
    outside.focus();
    instance().activate();
    scope().setAttribute("data-stimeo--focus-restore-value", "false");
    instance().deactivate();
    expect(document.activeElement).toBe(query("#a"));

    await mount('data-stimeo--focus-restore-value="false"');
    const outside2 = query("#outside");
    outside2.focus();
    instance().activate();
    scope().setAttribute("data-stimeo--focus-restore-value", "true");
    instance().deactivate();
    expect(document.activeElement).toBe(outside2);
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

  it("drops the state hook on disconnect without announcing a release", async () => {
    await mount('data-stimeo--focus-trap-value="true"');
    const events: string[] = [];
    scope().addEventListener("stimeo--focus:deactivate", () => events.push("deactivate"));

    instance().disconnect();

    expect(scope().hasAttribute("data-focus-trapped")).toBe(false);
    expect(events).toEqual([]);
  });

  it("keeps cycling through a focusable added after activation", async () => {
    // The scope tracks live children rather than a list taken at activate time,
    // so a control the application appends later joins the cycle.
    await mount('data-stimeo--focus-trap-value="true"');
    const late = document.createElement("button");
    late.id = "late";
    late.textContent = "late";
    scope().append(late);

    // The stops are read on every press, so `late` is now the last one: Shift+Tab from
    // `#a` wraps to it rather than to `#c`, and Tab from it wraps to `#a`.
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

  it("keeps trapping through turbo:before-cache, which also fires on a page that stays", async () => {
    await mount('data-stimeo--focus-trap-value="true"');
    const events: string[] = [];
    scope().addEventListener("stimeo--focus:deactivate", () => events.push("deactivate"));
    expect(scope().getAttribute("data-focus-trapped")).toBe("true");

    document.dispatchEvent(new Event("turbo:before-cache"));
    await tick();

    expect(scope().getAttribute("data-focus-trapped")).toBe("true");
    expect(events).toEqual([]);
    declareInert(true);
    expect(query("#outside").inert).toBe(true);
  });

  it("has no a11y violations", async () => {
    await mount('data-stimeo--focus-trap-value="true"');
    await expectNoA11yViolations(scope());
  });
});
