import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationMenuController } from "../src/controllers/navigation_menu_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link NavigationMenuController}: the APG disclosure
 * navigation — single-open panels, Escape/outside-click/focus-leave dismissal,
 * arrow movement between triggers (keeping Tab order), opt-in hover open, and
 * the optional `hoverArea` wrapper that widens the hover region (top-level
 * links arrangement).
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

// Top-level-links arrangement: each <li> holds a plain link, a disclosure
// trigger, and its panel, and is marked as a hoverArea so hovering the link
// text (not just the trigger button) opens the panel.
const hoverAreaMarkup = (extra = 'data-stimeo--navigation-menu-open-on-hover-value="true"') => `
  <nav data-controller="stimeo--navigation-menu" aria-label="Main" ${extra}>
    <ul>
      <li id="area1" data-stimeo--navigation-menu-target="hoverArea">
        <a id="link1" href="/products">Products</a>
        <button id="t1" data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="p1"
                data-action="click->stimeo--navigation-menu#toggle
                             keydown->stimeo--navigation-menu#onTriggerKeydown">Products submenu</button>
        <div id="p1" data-stimeo--navigation-menu-target="panel" hidden>
          <a href="/a">Product A</a>
        </div>
      </li>
      <li id="area2" data-stimeo--navigation-menu-target="hoverArea">
        <a id="link2" href="/company">Company</a>
        <button id="t2" data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="p2"
                data-action="click->stimeo--navigation-menu#toggle
                             keydown->stimeo--navigation-menu#onTriggerKeydown">Company submenu</button>
        <div id="p2" data-stimeo--navigation-menu-target="panel" hidden>
          <a href="/c">About</a>
        </div>
      </li>
    </ul>
  </nav>`;

describe("NavigationMenuController with openOnHover and hoverArea", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = hoverAreaMarkup();
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  it("opens the contained trigger's panel on hoverArea mouseenter (containment resolution)", () => {
    vi.useFakeTimers();
    try {
      byId("area2").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(150);
      // Resolves to the trigger *inside* the hovered area — not the first trigger.
      expect(byId("p2").hidden).toBe(false);
      expect(byId("t2").getAttribute("aria-expanded")).toBe("true");
      expect(byId("p1").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes after the hover delay on hoverArea mouseleave", () => {
    vi.useFakeTimers();
    try {
      byId("area1").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false);

      byId("area1").dispatchEvent(new MouseEvent("mouseleave"));
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(true);
      expect(byId("t1").getAttribute("aria-expanded")).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the panel open while the pointer moves within the hoverArea", () => {
    vi.useFakeTimers();
    try {
      byId("area1").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false);

      // Moving off the wrapped trigger (back onto the link in the same <li>)
      // must not schedule a close — the trigger's edges defer to the wrapper.
      byId("t1").dispatchEvent(new MouseEvent("mouseleave"));
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("NavigationMenuController hover-region continuity (relatedTarget)", () => {
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

  it("does not schedule a close when the pointer crosses straight into the panel", () => {
    vi.useFakeTimers();
    try {
      byId("t1").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false);

      // Shared-edge move: mouseleave names the panel as the destination, so no
      // close may be scheduled even without a compensating panel mouseenter.
      byId("t1").dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: byId("p1") }));
      vi.advanceTimersByTime(300);
      expect(byId("p1").hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still closes when the pointer leaves toward unrelated content", () => {
    vi.useFakeTimers();
    try {
      byId("t1").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(150);
      byId("t1").dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: byId("outside") }));
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// hoverArea whose panel lives OUTSIDE the wrapper (sibling): the wrapper covers
// only the link + trigger; the panel keeps its own listeners and shared-edge
// moves between the two regions must not flicker the panel shut.
const externalPanelMarkup = `
  <nav data-controller="stimeo--navigation-menu" aria-label="Main"
       data-stimeo--navigation-menu-open-on-hover-value="true">
    <ul>
      <li id="area1" data-stimeo--navigation-menu-target="hoverArea">
        <a id="link1" href="/products">Products</a>
        <button id="t1" data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="p1"
                data-action="click->stimeo--navigation-menu#toggle
                             keydown->stimeo--navigation-menu#onTriggerKeydown">Products submenu</button>
      </li>
    </ul>
    <div id="p1" data-stimeo--navigation-menu-target="panel" hidden>
      <a href="/a">Product A</a>
    </div>
  </nav>`;

describe("NavigationMenuController with a panel outside its hoverArea", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = externalPanelMarkup;
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  it("keeps the panel open when the pointer crosses from the area straight onto it", () => {
    vi.useFakeTimers();
    try {
      byId("area1").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false);

      byId("area1").dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: byId("p1") }));
      vi.advanceTimersByTime(300);
      expect(byId("p1").hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("NavigationMenuController with targets changing after connect", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = hoverAreaMarkup();
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const controller = (): NavigationMenuController => {
    const nav = document.querySelector(
      "[data-controller='stimeo--navigation-menu']",
    ) as HTMLElement;
    return application.getControllerForElementAndIdentifier(
      nav,
      "stimeo--navigation-menu",
    ) as NavigationMenuController;
  };

  it("wires hover for a hoverArea item added after connect", () => {
    const list = document.querySelector("[data-controller] ul") as HTMLElement;
    list.insertAdjacentHTML(
      "beforeend",
      `<li id="area3" data-stimeo--navigation-menu-target="hoverArea">
         <a href="/pricing">Pricing</a>
         <button id="t3" data-stimeo--navigation-menu-target="trigger"
                 aria-expanded="false" aria-controls="p3"
                 data-action="click->stimeo--navigation-menu#toggle
                              keydown->stimeo--navigation-menu#onTriggerKeydown">Pricing submenu</button>
         <div id="p3" data-stimeo--navigation-menu-target="panel" hidden>
           <a href="/plans">Plans</a>
         </div>
       </li>`,
    );
    // happy-dom's MutationObserver delivery is unreliable (see the testing
    // skill), so drive the Stimulus target callback deterministically.
    controller().hoverAreaTargetConnected();

    vi.useFakeTimers();
    try {
      byId("area3").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(150);
      expect(byId("p3").hidden).toBe(false);
      expect(byId("t3").getAttribute("aria-expanded")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("unwires a removed hoverArea and restores the uncovered trigger's own hover", () => {
    byId("area1").removeAttribute("data-stimeo--navigation-menu-target");
    controller().hoverAreaTargetDisconnected();

    vi.useFakeTimers();
    try {
      // The ex-wrapper no longer reacts…
      byId("area1").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
      expect(byId("p1").hidden).toBe(true);

      // …while the now-uncovered trigger got its own listeners back.
      byId("t1").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("NavigationMenuController with hoverArea but openOnHover disabled", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = hoverAreaMarkup("");
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  it("ignores hoverArea mouseenter entirely (non-destructive opt-in)", () => {
    vi.useFakeTimers();
    try {
      byId("area1").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
      expect(byId("p1").hidden).toBe(true);
      expect(byId("t1").getAttribute("aria-expanded")).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still toggles on click", () => {
    byId("t1").click();
    expect(byId("p1").hidden).toBe(false);
    byId("t1").click();
    expect(byId("p1").hidden).toBe(true);
  });
});
