import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationMenuController } from "../src/controllers/navigation_menu_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link NavigationMenuController}: the APG disclosure
 * navigation — single-open panels, Escape/outside-click/focus-leave dismissal,
 * arrow movement between triggers (keeping Tab order), and opt-in hover open.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = (extra = "") => `
  <button id="outside">Outside</button>
  <nav data-controller="stimeo--navigation-menu" aria-label="Main" ${extra}>
    <ul>
      <li>
        <button id="t1" data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="p1"
                data-action="click->stimeo--navigation-menu#toggle
                             keydown->stimeo--navigation-menu#onTriggerKeydown">Products</button>
        <div id="p1" data-stimeo--navigation-menu-target="panel" hidden>
          <a href="/a">Product A</a><a href="/b">Product B</a>
        </div>
      </li>
      <li>
        <button id="t2" data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="p2"
                data-action="click->stimeo--navigation-menu#toggle
                             keydown->stimeo--navigation-menu#onTriggerKeydown">Company</button>
        <div id="p2" data-stimeo--navigation-menu-target="panel" hidden>
          <a href="/c">About</a>
        </div>
      </li>
    </ul>
  </nav>`;

describe("NavigationMenuController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = markup();
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const expanded = (id: string) => byId(id).getAttribute("aria-expanded");
  const panelHidden = (id: string) => byId(id).hidden;

  it("starts with all panels closed", () => {
    expect(panelHidden("p1")).toBe(true);
    expect(expanded("t1")).toBe("false");
  });

  it("opens a panel on click", () => {
    byId("t1").click();
    expect(panelHidden("p1")).toBe(false);
    expect(expanded("t1")).toBe("true");
  });

  it("toggles a panel closed on a second click", () => {
    byId("t1").click();
    byId("t1").click();
    expect(panelHidden("p1")).toBe(true);
    expect(expanded("t1")).toBe("false");
  });

  it("opens only one panel at a time", () => {
    byId("t1").click();
    byId("t2").click();
    expect(panelHidden("p1")).toBe(true);
    expect(expanded("t1")).toBe("false");
    expect(panelHidden("p2")).toBe(false);
    expect(expanded("t2")).toBe("true");
  });

  it("moves focus between triggers with ArrowRight/ArrowLeft, keeping Tab order", () => {
    byId("t1").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(byId("t2"));
    // tabindex is untouched (no roving) — triggers stay in the natural Tab order.
    expect(byId("t1").hasAttribute("tabindex")).toBe(false);
    expect(byId("t2").hasAttribute("tabindex")).toBe(false);
    byId("t2").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement).toBe(byId("t1"));
  });

  it("closes on Escape and returns focus to the trigger", () => {
    byId("t1").focus();
    byId("t1").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panelHidden("p1")).toBe(true);
    expect(document.activeElement).toBe(byId("t1"));
  });

  it("closes on an outside click", () => {
    byId("t1").click();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panelHidden("p1")).toBe(true);
  });

  it("closes when focus leaves the nav entirely", () => {
    byId("t1").click();
    const nav = document.querySelector(
      "[data-controller='stimeo--navigation-menu']",
    ) as HTMLElement;
    nav.dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: byId("outside"), bubbles: true }),
    );
    expect(panelHidden("p1")).toBe(true);
  });

  it("keeps the panel open while focus stays within the nav", () => {
    byId("t1").click();
    const nav = document.querySelector(
      "[data-controller='stimeo--navigation-menu']",
    ) as HTMLElement;
    nav.dispatchEvent(new FocusEvent("focusout", { relatedTarget: byId("t2"), bubbles: true }));
    expect(panelHidden("p1")).toBe(false);
  });

  it("releases the document listener on disconnect", () => {
    byId("t1").click();
    const nav = document.querySelector(
      "[data-controller='stimeo--navigation-menu']",
    ) as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(
      nav,
      "stimeo--navigation-menu",
    );
    controller?.disconnect();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panelHidden("p1")).toBe(false); // a surviving listener would have closed it
  });

  it("has no machine-detectable a11y violations (closed and open)", async () => {
    const nav = document.querySelector(
      "[data-controller='stimeo--navigation-menu']",
    ) as HTMLElement;
    await expectNoA11yViolations(nav);
    byId("t1").click();
    await expectNoA11yViolations(nav);
  });

  it("announces the navigation landmark and its first trigger", async () => {
    const nav = document.querySelector(
      "[data-controller='stimeo--navigation-menu']",
    ) as HTMLElement;
    const phrases = await captureSpeech({ container: nav, steps: 4 });
    expect(phrases).toEqual([
      "navigation, Main",
      "list",
      "listitem, level 1, position 1, set size 2",
      "button, Products, 1 control, not expanded",
      "end of listitem, level 1, position 1, set size 2",
    ]);
  });
});

describe("NavigationMenuController with openOnHover", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = markup('data-stimeo--navigation-menu-open-on-hover-value="true"');
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  it("opens after the hover delay on mouseenter and closes after mouseleave", () => {
    vi.useFakeTimers();
    try {
      byId("t1").dispatchEvent(new MouseEvent("mouseenter"));
      expect(byId("p1").hidden).toBe(true); // not yet — waiting out the delay
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false);

      byId("t1").dispatchEvent(new MouseEvent("mouseleave"));
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
