import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationMenuController } from "../src/controllers/navigation_menu_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link NavigationMenuController}: the APG disclosure
 * navigation — single-open panels, Escape/outside-click/focus-leave dismissal,
 * arrow movement between triggers (keeping Tab order), opt-in hover open, and
 * the optional `hoverArea` wrapper that widens the hover region (top-level
 * links arrangement).
 */

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
    disconnectAndStopApplication(application);
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

  it("yields a key a descendant widget already consumed", () => {
    // A composed widget that claims the key must not ALSO move the trigger focus —
    // composition depends on this yield. The guard runs ahead of the modifier check,
    // so a claimed press is yielded whether or not it carries a modifier.
    byId("t1").focus();
    const inner = document.createElement("span");
    byId("t1").append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());

    const claimed = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    const notCanceled = inner.dispatchEvent(claimed);

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(document.activeElement).toBe(byId("t1"));
  });

  it("consumes the arrow press (no sideways page scroll) and wraps at both ends", () => {
    const press = (id: string, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      byId(id).dispatchEvent(event);
      return event;
    };

    // Consuming the press is what stops the browser scrolling the page sideways.
    expect(press("t1", "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("t2"));
    // The ring wraps in both directions (last → first, first → last).
    press("t2", "ArrowRight");
    expect(document.activeElement).toBe(byId("t1"));
    press("t1", "ArrowLeft");
    expect(document.activeElement).toBe(byId("t2"));
  });

  it("leaves a modified arrow to the browser (Alt+Left/Right is history navigation)", () => {
    byId("t1").focus();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    byId("t1").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byId("t1"));
  });

  it("closes on Escape and returns focus to the trigger", () => {
    byId("t1").focus();
    byId("t1").click();
    byId("t1").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panelHidden("p1")).toBe(true);
    expect(document.activeElement).toBe(byId("t1"));
  });

  it("consumes the Escape it owns", () => {
    byId("t1").focus();
    byId("t1").click();
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    byId("t1").dispatchEvent(event);
    // Owning the press marks it handled so outer layers skip the same Escape.
    expect(event.defaultPrevented).toBe(true);
    expect(panelHidden("p1")).toBe(true);
  });

  it("ignores an Escape already handled by an inner layer", () => {
    byId("t1").focus();
    byId("t1").click();
    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    byId("t1").dispatchEvent(handled);
    expect(panelHidden("p1")).toBe(false);
    expect(document.activeElement).toBe(byId("t1"));
  });

  it("stays open on a destination-less focus loss and still closes on Escape", () => {
    byId("t1").focus();
    byId("t1").click();
    expect(panelHidden("p1")).toBe(false);

    // A null relatedTarget is indeterminate (clicks on non-focusable panel
    // content, window deactivation), so it must not close the nav — the popover
    // convention. Keyboard dismissal survives via the Escape stack's body claim.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(panelHidden("p1")).toBe(false);

    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(panelHidden("p1")).toBe(true);
    expect(document.activeElement).toBe(byId("t1"));
  });

  it("closes on an outside click", () => {
    byId("t1").click();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panelHidden("p1")).toBe(true);
  });

  it("reverses the horizontal arrows under RTL", async () => {
    // Logical direction: the triggers are an ordered row, so which one is "next"
    // follows the writing direction. `dir="rtl"` is the authoring contract, but
    // happy-dom does not resolve it into the computed style, so the direction is
    // set on the style directly.
    //
    // Three triggers, not the default two: with two, wrapping makes ArrowLeft and
    // ArrowRight land on the same one and the case cannot tell them apart.
    disconnectAndStopApplication(application);
    document.body.innerHTML = `
      <nav data-controller="stimeo--navigation-menu" aria-label="Main">
        <ul>
          <li><button id="r1" data-stimeo--navigation-menu-target="trigger"
              data-action="keydown->stimeo--navigation-menu#onTriggerKeydown">One</button></li>
          <li><button id="r2" data-stimeo--navigation-menu-target="trigger"
              data-action="keydown->stimeo--navigation-menu#onTriggerKeydown">Two</button></li>
          <li><button id="r3" data-stimeo--navigation-menu-target="trigger"
              data-action="keydown->stimeo--navigation-menu#onTriggerKeydown">Three</button></li>
        </ul>
      </nav>`;
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
    (document.querySelector("nav[data-controller]") as HTMLElement).style.direction = "rtl";

    const arrow = (id: string, key: string) =>
      byId(id).dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );

    byId("r1").focus();
    arrow("r1", "ArrowLeft"); // "next" under RTL
    expect(document.activeElement).toBe(byId("r2"));

    arrow("r2", "ArrowRight"); // "previous" — back to r1, not on to r3
    expect(document.activeElement).toBe(byId("r1"));
  });

  it("stays open when an inside click removes the clicked node first", () => {
    // The failure mode that decides the listener phase. On bubble, the inner handler
    // runs first and detaches the node, so by the time the document listener runs
    // `event.target` is outside the tree and `contains()` says "outside" — closing on
    // what was an *inside* click. On capture the document observes it first, against
    // the tree the user actually clicked.
    byId("t1").click();
    const item = document.createElement("button");
    byId("p1").append(item);
    item.addEventListener("click", () => item.remove());

    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(panelHidden("p1")).toBe(false);
  });

  // Both focusout cases move focus for real (rather than dispatching a synthetic
  // FocusEvent at the nav) so the assertion depends on the observable contract,
  // not on which element the controller happens to listen on.
  it("closes when focus leaves the nav entirely", () => {
    byId("t1").focus();
    byId("t1").click();
    byId("outside").focus();
    expect(panelHidden("p1")).toBe(true);
    // Focus is not taken back — the user asked to be elsewhere.
    expect(document.activeElement).toBe(byId("outside"));
  });

  it("keeps the panel open while focus stays within the nav", () => {
    byId("t1").focus();
    byId("t1").click();
    byId("t2").focus();
    expect(panelHidden("p1")).toBe(false);
  });

  it("releases the dismissal listeners on disconnect", () => {
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
    byId("t1").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panelHidden("p1")).toBe(false);
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
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const enter = (id: string) => byId(id).dispatchEvent(new MouseEvent("mouseenter"));
  const leave = (id: string) => byId(id).dispatchEvent(new MouseEvent("mouseleave"));

  it("opens after the hover delay on mouseenter and closes after mouseleave", () => {
    vi.useFakeTimers();
    try {
      enter("t1");
      expect(byId("p1").hidden).toBe(true); // not yet — waiting out the delay
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false);

      leave("t1");
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a panel open on hover-out while focus sits inside it", () => {
    vi.useFakeTimers();
    try {
      enter("t1");
      vi.advanceTimersByTime(150);
      const link = byId("p1").querySelector("a") as HTMLElement;
      link.focus();

      // Hiding the panel would take the focused link with it and drop focus to
      // the body; the pointer leaving is not a reason to lose the user's place.
      leave("t1");
      vi.advanceTimersByTime(300);
      expect(byId("p1").hidden).toBe(false);
      expect(document.activeElement).toBe(link);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns focus to the outgoing trigger before a hover switch hides its panel", () => {
    vi.useFakeTimers();
    try {
      enter("t1");
      vi.advanceTimersByTime(150);
      (byId("p1").querySelector("a") as HTMLElement).focus();

      enter("t2");
      vi.advanceTimersByTime(150);
      expect(byId("p2").hidden).toBe(false);
      expect(byId("p1").hidden).toBe(true);
      // Focus lands on the closing panel's trigger — never on <body>.
      expect(document.activeElement).toBe(byId("t1"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a click on a trigger whose panel the pointer is holding open", () => {
    vi.useFakeTimers();
    try {
      enter("t1");
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false);

      // Closing here would strand the panel: the pointer stays put, so
      // mouseenter never re-fires and nothing could re-open it.
      byId("t1").click();
      expect(byId("p1").hidden).toBe(false);
      expect(byId("t1").getAttribute("aria-expanded")).toBe("true");

      // Dismissal still works — the pointer leaving closes it as usual.
      leave("t1");
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still toggles a panel closed on click once the pointer has left", () => {
    vi.useFakeTimers();
    try {
      enter("t1");
      vi.advanceTimersByTime(150);
      leave("t1"); // the pointer no longer holds it open…
      byId("t1").click(); // …so an activation (click / Enter) closes it
      expect(byId("p1").hidden).toBe(true);
      expect(byId("t1").getAttribute("aria-expanded")).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a pending hover close when the panel is re-opened explicitly", () => {
    vi.useFakeTimers();
    try {
      enter("t1");
      vi.advanceTimersByTime(150);
      leave("t1"); // schedules a close 150ms out

      // Two quick activations inside that window (close, then re-open): the
      // stale reservation must not slam the freshly opened panel shut.
      byId("t1").click();
      byId("t1").click();
      vi.advanceTimersByTime(300);
      expect(byId("p1").hidden).toBe(false);
      expect(byId("t1").getAttribute("aria-expanded")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-hovering an open trigger rewrites no state", () => {
    vi.useFakeTimers();
    try {
      enter("t1");
      vi.advanceTimersByTime(150);

      const observer = new MutationObserver(() => {});
      observer.observe(byId("t1").closest("nav") as HTMLElement, {
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-expanded", "hidden"],
      });
      try {
        enter("t1");
        vi.advanceTimersByTime(150);
        // A close/open round-trip on the already-open panel would show up here.
        expect(observer.takeRecords()).toEqual([]);
      } finally {
        observer.disconnect();
      }
      expect(byId("p1").hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows a runtime flip of openOnHover in both directions", async () => {
    const nav = document.querySelector(
      "[data-controller='stimeo--navigation-menu']",
    ) as HTMLElement;
    const attribute = "data-stimeo--navigation-menu-open-on-hover-value";

    nav.setAttribute(attribute, "false");
    await tick();
    vi.useFakeTimers();
    try {
      enter("t1");
      vi.advanceTimersByTime(300);
      expect(byId("p1").hidden).toBe(true); // unwired in place
    } finally {
      vi.useRealTimers();
    }

    nav.setAttribute(attribute, "true");
    await tick();
    vi.useFakeTimers();
    try {
      enter("t1");
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false); // wired again without a reconnect
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("NavigationMenuController with a non-default hoverDelay", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = markup(
      'data-stimeo--navigation-menu-open-on-hover-value="true" ' +
        'data-stimeo--navigation-menu-hover-delay-value="400"',
    );
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  it("waits out the authored delay instead of the 150ms default", () => {
    vi.useFakeTimers();
    try {
      byId("t1").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(150); // the default would already have opened it
      expect(byId("p1").hidden).toBe(true);
      vi.advanceTimersByTime(250);
      expect(byId("p1").hidden).toBe(false);

      byId("t1").dispatchEvent(new MouseEvent("mouseleave"));
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false);
      vi.advanceTimersByTime(250);
      expect(byId("p1").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("NavigationMenuController after the Stimulus definition is unloaded", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = markup('data-stimeo--navigation-menu-open-on-hover-value="true"');
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const unload = () => application.unload("stimeo--navigation-menu");

  // `unload` runs the full Stimulus teardown, which disconnects the controller
  // *before* its targets — so the target callbacks fire on a dead controller and
  // must not resurrect the hover wiring.
  it("stops reacting to hover entirely", () => {
    vi.useFakeTimers();
    try {
      unload();
      byId("t1").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
      expect(byId("p1").hidden).toBe(true);
      expect(byId("t1").getAttribute("aria-expanded")).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a hover reservation made just before the teardown", () => {
    vi.useFakeTimers();
    try {
      byId("t1").dispatchEvent(new MouseEvent("mouseenter")); // open scheduled
      unload();
      vi.advanceTimersByTime(300);
      expect(byId("p1").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reacting to focus leaving the nav and to a hover leave", () => {
    byId("t1").focus();
    byId("t1").click();
    unload();

    byId("outside").focus(); // a surviving focusout listener would have closed it
    expect(byId("p1").hidden).toBe(false);

    vi.useFakeTimers();
    try {
      byId("t1").dispatchEvent(new MouseEvent("mouseleave"));
      vi.advanceTimersByTime(300);
      expect(byId("p1").hidden).toBe(false);
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
    disconnectAndStopApplication(application);
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
    disconnectAndStopApplication(application);
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
    disconnectAndStopApplication(application);
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
    disconnectAndStopApplication(application);
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
    // happy-dom's MutationObserver delivery is unreliable, so drive the Stimulus
    // target callback deterministically.
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
    disconnectAndStopApplication(application);
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
});

// Triggers a consumer disabled or hid at runtime: the arrow ring must route
// around them instead of consuming the press and going nowhere.
const mixedTriggersMarkup = `
  <nav data-controller="stimeo--navigation-menu" aria-label="Main">
    <ul>
      <li>
        <button id="m1" data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="mp1"
                data-action="click->stimeo--navigation-menu#toggle keydown->stimeo--navigation-menu#onTriggerKeydown">One</button>
        <div id="mp1" data-stimeo--navigation-menu-target="panel" hidden><a href="/1">A</a></div>
      </li>
      <li>
        <button id="m2" disabled data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="mp2"
                data-action="click->stimeo--navigation-menu#toggle keydown->stimeo--navigation-menu#onTriggerKeydown">Two</button>
        <div id="mp2" data-stimeo--navigation-menu-target="panel" hidden><a href="/2">B</a></div>
      </li>
      <li>
        <button id="m3" hidden data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="mp3"
                data-action="click->stimeo--navigation-menu#toggle keydown->stimeo--navigation-menu#onTriggerKeydown">Three</button>
        <div id="mp3" data-stimeo--navigation-menu-target="panel" hidden><a href="/3">C</a></div>
      </li>
      <li>
        <button id="m4" aria-disabled="true" data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="mp4"
                data-action="click->stimeo--navigation-menu#toggle keydown->stimeo--navigation-menu#onTriggerKeydown">Four</button>
        <div id="mp4" data-stimeo--navigation-menu-target="panel" hidden><a href="/4">D</a></div>
      </li>
      <li>
        <button id="m5" data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="mp5"
                data-action="click->stimeo--navigation-menu#toggle keydown->stimeo--navigation-menu#onTriggerKeydown">Five</button>
        <div id="mp5" data-stimeo--navigation-menu-target="panel" hidden><a href="/5">E</a></div>
      </li>
    </ul>
  </nav>`;

describe("NavigationMenuController with unavailable triggers", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = mixedTriggersMarkup;
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const press = (id: string, key: string): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    byId(id).dispatchEvent(event);
    return event;
  };

  /** Re-mounts the same fixture with hover opening on — a Value it does not set. */
  const remountWithHover = async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = mixedTriggersMarkup.replace(
      'aria-label="Main"',
      'aria-label="Main" data-stimeo--navigation-menu-open-on-hover-value="true"',
    );
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  };

  it("skips hidden and natively disabled triggers, but reaches aria-disabled ones", () => {
    // `disabled` (m2) and `hidden` (m3) are skipped; `aria-disabled` (m4) is not.
    // APG marks that attribute for controls that must stay *discoverable*, and a
    // nav section the user cannot arrow to is one they cannot learn exists.
    // Opening it is suppressed separately.
    byId("m1").focus();
    press("m1", "ArrowRight");
    expect(document.activeElement).toBe(byId("m4"));
    press("m4", "ArrowRight");
    expect(document.activeElement).toBe(byId("m5"));

    press("m5", "ArrowLeft");
    expect(document.activeElement).toBe(byId("m4"));
    press("m4", "ArrowLeft");
    expect(document.activeElement).toBe(byId("m1"));
  });

  it("does not open an aria-disabled trigger that is clicked", () => {
    // Reaching the trigger is what `aria-disabled` asks for; opening its panel is
    // the activation it forbids, and opening a popup counts as activation.
    //
    // Click is the path that matters: a browser turns `Enter` on a `<button>`
    // into one, and `onTriggerKeydown` handles only the arrows — so dispatching a
    // bare `Enter` keydown here would reach no activation path at all and assert
    // nothing.
    byId("m4").click();

    expect(byId("m4").getAttribute("aria-expanded")).toBe("false");
    expect(byId("mp4").hidden).toBe(true);
  });

  it("keeps an aria-disabled trigger shut when hover opening is on", async () => {
    // The hover path reaches `#openPanel` without going through `toggle`, so it
    // needs the guard in its own right. Re-mounted because hover opening is a
    // Value the shared fixture does not set, and the open is behind the hover
    // delay — advancing the timer is what makes this case discriminate at all.
    await remountWithHover();

    vi.useFakeTimers();
    try {
      // Well past `hoverDelay` (150), not exactly it: a negative assertion that
      // advances by the current default goes quietly hollow the day the default
      // changes. The other "did not happen" cases in this file use 300 too.
      byId("m4").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);

      expect(byId("m4").getAttribute("aria-expanded")).toBe("false");
      expect(byId("mp4").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an open panel alone when hover lands on an aria-disabled trigger", async () => {
    // `#openFromHover` rescues focus out of the panel it is about to hide *before*
    // opening the next one. When the next one refuses to open, that rescue has
    // bought nothing — focus leaves a panel that stays open. The guard therefore
    // has to run before the rescue, not only inside `#openPanel`.
    await remountWithHover();

    vi.useFakeTimers();
    try {
      byId("m1").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
      byId("mp1").querySelector("a")?.focus();
      const inside = document.activeElement;

      byId("m4").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);

      expect(byId("mp1").hidden).toBe(false); // nothing was hidden…
      expect(document.activeElement).toBe(inside); // …so nothing had to move
    } finally {
      vi.useRealTimers();
    }
  });
});

// A nav whose single trigger points at no panel of its own: both defensive
// branches (nothing to move to, nothing to open) must stay silent.
const strayTriggerMarkup = `
  <nav data-controller="stimeo--navigation-menu" aria-label="Stray">
    <ul>
      <li>
        <button id="s1" data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="not-a-target"
                data-action="click->stimeo--navigation-menu#toggle
                             keydown->stimeo--navigation-menu#onTriggerKeydown">Solo</button>
        <div id="sp1" data-stimeo--navigation-menu-target="panel" hidden><a href="/x">X</a></div>
      </li>
    </ul>
  </nav>`;

describe("NavigationMenuController with a single, unmatched trigger", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = strayTriggerMarkup;
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  it("opens nothing when aria-controls matches no panel target", () => {
    byId("s1").click();
    expect(byId("sp1").hidden).toBe(true);
    expect(byId("s1").getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves the arrow press alone when there is nowhere to move", () => {
    byId("s1").focus();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    byId("s1").dispatchEvent(event);
    // Nothing to focus, so the press stays the page's (no dead consumed key).
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byId("s1"));
  });
});

// Two navs on one page: each must resolve its own panels through its own
// targets, never through a global id lookup.
const twoNavsMarkup = `
  <nav data-controller="stimeo--navigation-menu" aria-label="Primary">
    <ul>
      <li>
        <button id="a1" data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="ap1"
                data-action="click->stimeo--navigation-menu#toggle">A</button>
        <div id="ap1" data-stimeo--navigation-menu-target="panel" hidden><a href="/a">A</a></div>
      </li>
    </ul>
  </nav>
  <nav data-controller="stimeo--navigation-menu" aria-label="Secondary">
    <ul>
      <li>
        <button id="b1" data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="bp1"
                data-action="click->stimeo--navigation-menu#toggle">B</button>
        <div id="bp1" data-stimeo--navigation-menu-target="panel" hidden><a href="/b">B</a></div>
      </li>
    </ul>
  </nav>`;

describe("NavigationMenuController with two navs on the page", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = twoNavsMarkup;
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  it("keeps each nav on its own panels", () => {
    byId("a1").click();
    expect(byId("ap1").hidden).toBe(false);
    expect(byId("bp1").hidden).toBe(true);

    // The click lands outside the first nav, so it dismisses — while the second
    // nav opens its own panel (no cross-instance panel resolution).
    byId("b1").click();
    expect(byId("bp1").hidden).toBe(false);
    expect(byId("b1").getAttribute("aria-expanded")).toBe("true");
    expect(byId("ap1").hidden).toBe(true);
    expect(byId("a1").getAttribute("aria-expanded")).toBe("false");
  });
});
