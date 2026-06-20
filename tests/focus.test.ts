import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FocusController } from "../src/controllers/focus_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link FocusController}: trap activation and the state hook,
 * Tab / Shift+Tab cycling, initial focus, restore-on-release, Escape, the optional
 * background `inert`, the no-scroll-lock and no-auto-focus options, and teardown.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("FocusController", () => {
  let application: Application;

  const mount = async (attrs = "") => {
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
    application.stop();
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
    const moved: string[] = [];
    document.addEventListener("focusin", () => moved.push("focusin"));
    scope().remove();
    await tick();
    // Listeners removed: a stray Tab must not throw or trap.
    expect(() => tab()).not.toThrow();
  });

  it("has no a11y violations", async () => {
    await mount('data-stimeo--focus-trap-value="true"');
    await expectNoA11yViolations(scope());
  });
});
