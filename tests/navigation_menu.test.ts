import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationMenuController } from "../src/controllers/navigation_menu_controller";
import { EscapeLayer } from "../src/utils/escape_layer";
import { expectNoA11yViolations } from "./helpers/a11y";
import { press as keyboardPress, keyEvent, typeKey } from "./helpers/keyboard";
import { recordListeners } from "./helpers/listeners";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
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
    keyboardPress(byId("t1"), "ArrowRight");
    expect(document.activeElement).toBe(byId("t2"));
    // tabindex is untouched (no roving) — triggers stay in the natural Tab order.
    expect(byId("t1").hasAttribute("tabindex")).toBe(false);
    expect(byId("t2").hasAttribute("tabindex")).toBe(false);
    keyboardPress(byId("t2"), "ArrowLeft");
    expect(document.activeElement).toBe(byId("t1"));
  });

  it("yields a key a descendant widget already consumed", () => {
    // A composed widget that claims the key must not ALSO move the trigger focus —
    // composition depends on this yield. The guard runs ahead of the modifier check,
    // so a claimed press is yielded whether or not it carries a modifier.
    byId("t1").focus();
    const inner = document.createElement("span");
    inner.tabIndex = 0;
    byId("t1").append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());

    const claimed = keyEvent("ArrowRight");
    const notCanceled = !keyboardPress(inner, claimed).defaultPrevented;

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(document.activeElement).toBe(inner);
  });

  it("consumes the arrow press (no sideways page scroll) and wraps at both ends", () => {
    const press = (id: string, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
      const event = keyEvent(key, { ...init });
      keyboardPress(byId(id), event);
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
    const event = keyEvent("ArrowRight", { altKey: true });
    keyboardPress(byId("t1"), event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byId("t1"));
  });

  it("closes on Escape and returns focus to the trigger", () => {
    byId("t1").focus();
    byId("t1").click();
    keyboardPress(byId("t1"), "Escape");
    expect(panelHidden("p1")).toBe(true);
    expect(document.activeElement).toBe(byId("t1"));
  });

  it("consumes the Escape it owns", () => {
    byId("t1").focus();
    byId("t1").click();
    const event = keyEvent("Escape");
    keyboardPress(byId("t1"), event);
    // Owning the press marks it handled so outer layers skip the same Escape.
    expect(event.defaultPrevented).toBe(true);
    expect(panelHidden("p1")).toBe(true);
  });

  it("ignores an Escape already handled by an inner layer", () => {
    byId("t1").focus();
    byId("t1").click();
    const handled = keyEvent("Escape");
    handled.preventDefault();
    keyboardPress(byId("t1"), handled);
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

    const event = keyEvent("Escape");
    // Keep the indeterminate body focus while the document Escape fallback handles the key.
    typeKey(document, event);
    expect(event.defaultPrevented).toBe(true);
    expect(panelHidden("p1")).toBe(true);
    expect(document.activeElement).toBe(byId("t1"));
  });

  it("closes on an outside click", () => {
    byId("t1").click();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panelHidden("p1")).toBe(true);
  });

  it.each([false, true])(
    "reverses horizontal arrows using an optional list (%s)",
    async (withList) => {
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
        <ul ${withList ? 'data-stimeo--navigation-menu-target="list"' : ""}>
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
      const nav = document.querySelector<HTMLElement>("nav[data-controller]") as HTMLElement;
      const list = nav.querySelector<HTMLElement>("ul") as HTMLElement;
      const directionElement = withList ? list : nav;
      directionElement.style.direction = "rtl";
      byId("r1").style.direction = "ltr";

      const arrow = (id: string, key: string) => keyboardPress(byId(id), key);

      byId("r1").focus();
      arrow("r1", "ArrowLeft"); // "next" under RTL
      expect(document.activeElement).toBe(byId("r2"));

      arrow("r2", "ArrowRight"); // "previous" — back to r1, not on to r3
      expect(document.activeElement).toBe(byId("r1"));

      directionElement.style.direction = "ltr";
      arrow("r1", "ArrowRight");
      expect(document.activeElement).toBe(byId("r2"));

      if (withList) {
        const replacement = list.cloneNode(true) as HTMLElement;
        replacement.style.direction = "rtl";
        list.replaceWith(replacement);
        await tick();
        arrow("r1", "ArrowLeft");
        expect(document.activeElement).toBe(byId("r2"));
      }
    },
  );

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
    keyboardPress(byId("t1"), "Escape");
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

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--navigation-menu");
    });

    afterEach(() => {
      capture.stop();
    });

    it("reports a trigger click with the panel that moved, after the attributes", () => {
      const states: string[] = [];
      byId("t1")
        .closest("nav")
        ?.addEventListener("stimeo--navigation-menu:open", () => {
          states.push(`${panelHidden("p1")} ${expanded("t1")}`);
        });

      byId("t1").click();

      expect(capture.names()).toEqual(["open"]);
      expect(capture.seen[0]?.detail).toEqual({ reason: "user", index: 0, panel: byId("p1") });
      expect(states).toEqual(["false true"]);
      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);

      byId("t1").click();
      expect(capture.names()).toEqual(["open", "close"]);
      expect(capture.reasons()).toEqual(["user", "user"]);
    });

    it("reports the outgoing close before the incoming open when panels switch", () => {
      byId("t1").click();
      capture.clear();

      byId("t2").click();

      expect(capture.names()).toEqual(["close", "open"]);
      expect(capture.seen[0]?.detail).toEqual({ reason: "user", index: 0, panel: byId("p1") });
      expect(capture.seen[1]?.detail).toEqual({ reason: "user", index: 1, panel: byId("p2") });
    });

    it("reports an outside click as outside and Escape as escape", () => {
      byId("t1").click();
      capture.clear();
      byId("outside").click();

      expect(capture.reasons()).toEqual(["outside"]);

      byId("t1").click();
      capture.clear();
      keyboardPress(byId("t1"), "Escape");

      expect(capture.reasons()).toEqual(["escape"]);
    });

    it("reports a focusout to an outside destination as focus", () => {
      byId("t1").click();
      capture.clear();

      byId("p1").dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: byId("outside") }),
      );

      expect(capture.reasons()).toEqual(["focus"]);
    });

    it("stays silent while an arrow key only moves focus between triggers", () => {
      byId("t1").click();
      capture.clear();

      keyboardPress(byId("t1"), "ArrowRight");

      // The arrow moves the focus, it does not open or close anything.
      expect(panelHidden("p1")).toBe(false);
      expect(document.activeElement).toBe(byId("t2"));
      expect(capture.seen).toEqual([]);
    });

    it("stays silent while connect normalizes an authored-open panel", async () => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = markup().replace(
        'aria-expanded="false" aria-controls="p1"',
        'aria-expanded="true" aria-controls="p1"',
      );
      const fresh = captureStateEvents("stimeo--navigation-menu");
      application = Application.start();
      application.register("stimeo--navigation-menu", NavigationMenuController);
      await tick();

      expect(panelHidden("p1")).toBe(true);
      expect(fresh.seen).toEqual([]);
      fresh.stop();
    });

    it("stays silent through a disconnect and a Turbo-style reconnect", async () => {
      byId("t1").click();
      capture.clear();

      const element = document.querySelector("nav") as HTMLElement;
      element.remove();
      await tick();
      document.body.append(element);
      await tick();

      expect(panelHidden("p1")).toBe(true);
      expect(capture.seen).toEqual([]);
    });
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
  const controller = (): NavigationMenuController =>
    application.getControllerForElementAndIdentifier(
      document.querySelector("nav") as HTMLElement,
      "stimeo--navigation-menu",
    ) as NavigationMenuController;

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

  it("closes a panel the pointer holds open on click once openOnHover is turned off", async () => {
    const nav = document.querySelector(
      "[data-controller='stimeo--navigation-menu']",
    ) as HTMLElement;
    vi.useFakeTimers();
    try {
      enter("t1");
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false);

      nav.setAttribute("data-stimeo--navigation-menu-open-on-hover-value", "false");
      await vi.advanceTimersByTimeAsync(0);
      // The click reads the declaration in force: with hover opening off, the
      // pointer no longer holds the panel, so the activation closes it.
      byId("t1").click();
      expect(byId("p1").hidden).toBe(true);
      expect(byId("t1").getAttribute("aria-expanded")).toBe("false");
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
        vi.advanceTimersByTime(300);
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

  it("stays silent when hover reopens the panel that is already open", () => {
    vi.useFakeTimers();
    const capture = captureStateEvents("stimeo--navigation-menu");
    try {
      enter("t1");
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false);
      capture.clear();

      // The guard that refuses a re-open lives on this path only: the click
      // action never reaches it (it toggles instead).
      enter("t1");
      vi.advanceTimersByTime(300);

      expect(byId("p1").hidden).toBe(false);
      expect(capture.seen).toEqual([]);
    } finally {
      capture.stop();
      vi.useRealTimers();
    }
  });

  it("moves back on top of the Escape stack when hover reaches its open panel again", () => {
    vi.useFakeTimers();
    const later = new EscapeLayer();
    const dismissed: string[] = [];
    try {
      enter("t1");
      vi.advanceTimersByTime(150);
      later.activate(document, { onDismiss: () => dismissed.push("later") });

      enter("t1");
      vi.advanceTimersByTime(150);
      byId("t1").focus();
      keyboardPress(byId("t1"), "Escape");

      expect(byId("p1").hidden).toBe(true);
      expect(dismissed).toEqual([]);
    } finally {
      later.deactivate();
      vi.useRealTimers();
    }
  });

  it("drops a pending hover open when Escape closes the panel", () => {
    vi.useFakeTimers();
    try {
      enter("t1");
      vi.advanceTimersByTime(150);
      byId("t1").focus();
      enter("t1");
      keyboardPress(byId("t1"), "Escape");
      expect(byId("p1").hidden).toBe(true);

      vi.advanceTimersByTime(300);
      expect(byId("p1").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the panel open, with no close reported, when the pointer returns within the delay", () => {
    vi.useFakeTimers();
    const capture = captureStateEvents("stimeo--navigation-menu");
    try {
      enter("t1");
      vi.advanceTimersByTime(150);
      leave("t1");
      vi.advanceTimersByTime(100);
      enter("t1");
      vi.advanceTimersByTime(50); // past the deadline the leave reserved
      expect(byId("p1").hidden).toBe(false);

      vi.advanceTimersByTime(300);
      expect(capture.names()).toEqual(["open"]);
    } finally {
      capture.stop();
      vi.useRealTimers();
    }
  });

  it("drops a pending hover open when the pointer leaves before the delay", () => {
    vi.useFakeTimers();
    const capture = captureStateEvents("stimeo--navigation-menu");
    try {
      enter("t1");
      vi.advanceTimersByTime(100);
      leave("t1");
      vi.advanceTimersByTime(50); // past the deadline the enter reserved
      expect(byId("p1").hidden).toBe(true);

      vi.advanceTimersByTime(300);
      expect(capture.seen).toEqual([]);
    } finally {
      capture.stop();
      vi.useRealTimers();
    }
  });

  it.each([
    ["trigger", "t1", "triggerTargetDisconnected"],
    ["panel", "p1", "panelTargetDisconnected"],
  ] as const)("unwires a %s that leaves the targets", (_kind, id, callback) => {
    byId(id).removeAttribute("data-stimeo--navigation-menu-target");
    controller()[callback]();

    vi.useFakeTimers();
    try {
      byId("t2").click();
      leave(id);
      vi.advanceTimersByTime(300);
      expect(byId("p2").hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the hover listeners of a trigger that leaves the targets", () => {
    const departed = byId("t1");
    controller().disconnect();
    const ledger = recordListeners();
    try {
      controller().connect();
      expect(ledger.live(departed).map(({ type }) => type)).toEqual(["mouseenter", "mouseleave"]);

      departed.removeAttribute("data-stimeo--navigation-menu-target");
      controller().triggerTargetDisconnected();

      expect(ledger.live(departed)).toEqual([]);
      expect(ledger.live(byId("t2")).map(({ type }) => type)).toEqual(["mouseenter", "mouseleave"]);
    } finally {
      ledger.restore();
    }
  });

  it("hands a trigger's hover edges to a hoverArea that starts wrapping it", () => {
    const area = byId("t1").closest("li") as HTMLElement;
    area.setAttribute("data-stimeo--navigation-menu-target", "hoverArea");
    controller().hoverAreaTargetConnected();

    vi.useFakeTimers();
    try {
      area.dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(150);
      expect(byId("p1").hidden).toBe(false);

      leave("t1"); // off the trigger, still inside the wrapper
      vi.advanceTimersByTime(300);
      expect(byId("p1").hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// A panel rendered before its trigger (`p2`) and a trigger rendered before its
// panel (`t3`): each missing half arrives on its own after connect.
const halfPairsMarkup = `
  <button id="outside">Outside</button>
  <nav data-controller="stimeo--navigation-menu" aria-label="Main"
       data-stimeo--navigation-menu-open-on-hover-value="true">
    <ul>
      <li id="awaits-trigger">
        <div id="p2" data-stimeo--navigation-menu-target="panel" hidden><a href="/c">About</a></div>
      </li>
      <li id="awaits-panel">
        <button id="t3" data-stimeo--navigation-menu-target="trigger"
                aria-expanded="false" aria-controls="p3">Pricing</button>
      </li>
    </ul>
  </nav>`;

describe("NavigationMenuController with a trigger or panel arriving alone", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = halfPairsMarkup;
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const controller = (): NavigationMenuController =>
    application.getControllerForElementAndIdentifier(
      document.querySelector("nav") as HTMLElement,
      "stimeo--navigation-menu",
    ) as NavigationMenuController;

  it("wires hover for a trigger that arrives after its panel", () => {
    byId("awaits-trigger").insertAdjacentHTML(
      "afterbegin",
      `<button id="t2" data-stimeo--navigation-menu-target="trigger"
               aria-expanded="false" aria-controls="p2">Company</button>`,
    );
    // The test stays synchronous, so it calls the Stimulus target callback directly
    // instead of waiting for the MutationObserver delivery.
    controller().triggerTargetConnected();

    vi.useFakeTimers();
    try {
      byId("t2").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(150);
      expect(byId("p2").hidden).toBe(false);
      expect(byId("t2").getAttribute("aria-expanded")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("wires hover for a panel that arrives after its trigger", () => {
    byId("awaits-panel").insertAdjacentHTML(
      "beforeend",
      `<div id="p3" data-stimeo--navigation-menu-target="panel" hidden><a href="/p">Plans</a></div>`,
    );
    controller().panelTargetConnected();

    vi.useFakeTimers();
    try {
      byId("t3").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(150);
      expect(byId("p3").hidden).toBe(false);

      // Across onto the panel, then away from it: the panel's own leave closes it.
      byId("t3").dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: byId("p3") }));
      byId("p3").dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: byId("outside") }));
      vi.advanceTimersByTime(150);
      expect(byId("p3").hidden).toBe(true);
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

  it("keeps a scheduled hover timer's deadline and reads a changed delay at the next hover", async () => {
    vi.useFakeTimers();
    const capture = captureStateEvents("stimeo--navigation-menu");
    const nav = document.querySelector("nav") as HTMLElement;
    const setDelay = async (ms: number): Promise<void> => {
      nav.setAttribute("data-stimeo--navigation-menu-hover-delay-value", String(ms));
      await vi.advanceTimersByTimeAsync(0);
    };
    try {
      byId("t1").dispatchEvent(new MouseEvent("mouseenter"));
      await setDelay(100);
      vi.advanceTimersByTime(399);
      expect(byId("p1").hidden).toBe(true);
      vi.advanceTimersByTime(1);
      expect(byId("p1").hidden).toBe(false);

      byId("t1").dispatchEvent(new MouseEvent("mouseleave"));
      await setDelay(1000);
      vi.advanceTimersByTime(99);
      expect(byId("p1").hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(byId("p1").hidden).toBe(true);

      // The next hover reads the declaration as it is now.
      byId("t1").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(999);
      expect(byId("p1").hidden).toBe(true);
      vi.advanceTimersByTime(1);
      expect(byId("p1").hidden).toBe(false);
      expect(capture.names()).toEqual(["open", "close", "open"]);
      expect(capture.reasons()).toEqual(["pointer", "pointer", "pointer"]);
    } finally {
      capture.stop();
      vi.useRealTimers();
    }
  });

  it("opens, closes and schedules nothing when only the delay changes", async () => {
    vi.useFakeTimers();
    const capture = captureStateEvents("stimeo--navigation-menu");
    const nav = document.querySelector("nav") as HTMLElement;
    try {
      nav.setAttribute("data-stimeo--navigation-menu-hover-delay-value", "0");
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);

      byId("t1").click();
      nav.setAttribute("data-stimeo--navigation-menu-hover-delay-value", "50");
      await vi.advanceTimersByTimeAsync(1000);
      expect(byId("p1").hidden).toBe(false);
      expect(capture.names()).toEqual(["open"]);
    } finally {
      capture.stop();
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
      vi.advanceTimersByTime(300);
      expect(byId("p1").hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["disabled", "hidden", "aria-disabled"] as const)(
    "never opens the %s trigger from the hoverArea that wraps it",
    (constraint) => {
      // The wrapper stays hoverable whatever its trigger carries, so the hover
      // reaches the controller and the refusal has to be the controller's.
      const trigger = byId("t2");
      if (constraint === "aria-disabled") trigger.setAttribute("aria-disabled", "true");
      else trigger.toggleAttribute(constraint, true);
      vi.useFakeTimers();
      try {
        byId("area2").dispatchEvent(new MouseEvent("mouseenter"));
        vi.advanceTimersByTime(300);
        expect(byId("p2").hidden).toBe(true);
        expect(trigger.getAttribute("aria-expanded")).toBe("false");

        // The neighbouring area's enabled trigger opens through the same wiring.
        byId("area1").dispatchEvent(new MouseEvent("mouseenter"));
        vi.advanceTimersByTime(300);
        expect(byId("p1").hidden).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );
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
    // The test stays synchronous, so it calls the Stimulus target callback directly
    // instead of waiting for the MutationObserver delivery.
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
    const event = keyEvent(key);
    keyboardPress(byId(id), event);
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

  /** Each constraint and the fixture trigger that carries it. */
  const CONSTRAINED = { "aria-disabled": "m4", disabled: "m2", hidden: "m3" } as const;
  type Constraint = keyof typeof CONSTRAINED;
  const CONSTRAINTS = Object.keys(CONSTRAINED) as Constraint[];
  const ROUTES = ["click", "element", "probe"] as const;
  type Route = (typeof ROUTES)[number];

  /** The panel `id`'s trigger controls. */
  const panelOf = (id: string): HTMLElement => byId(byId(id).getAttribute("aria-controls") ?? "");

  const instance = (): NavigationMenuController => {
    const root = document.querySelector("[data-controller='stimeo--navigation-menu']");
    const found =
      root && application.getControllerForElementAndIdentifier(root, "stimeo--navigation-menu");
    if (!(found instanceof NavigationMenuController)) throw new Error("Expected nav controller");
    return found;
  };

  /** Records the nav's state events; scoped to its root, which each test replaces. */
  const captureNav = () =>
    captureStateEvents(
      "stimeo--navigation-menu",
      ["open", "close"],
      document.querySelector("nav") ?? document,
    );

  /**
   * Drives `toggle` on `id` through one route: a DOM click, the element API, or a
   * non-click Event handed to the action. The engine dispatches no click on a
   * natively `disabled` button; a script's `click()` still reaches a `hidden` one.
   * The probe bubbles and is cancelable, and is returned, so a row can show the
   * action left it alone.
   */
  const drive = (id: string, route: Route): Event | null => {
    const trigger = byId(id);
    if (route === "click") {
      trigger.click();
      return null;
    }
    if (route === "element") {
      instance().toggle(trigger);
      return null;
    }
    const probe = new Event("probe", { bubbles: true, cancelable: true });
    trigger.addEventListener("probe", (event) => instance().toggle(event), { once: true });
    trigger.dispatchEvent(probe);
    return probe;
  };

  it.each(CONSTRAINTS.flatMap((constraint) => ROUTES.map((route) => [constraint, route] as const)))(
    "refuses to open the %s trigger through %s, leaving the open panel alone",
    async (constraint, route) => {
      const id = CONSTRAINED[constraint];
      byId("m1").focus();
      byId("m1").click();
      const capture = captureNav();
      const reached = vi.fn();
      instance().element.addEventListener("probe", reached);

      const probe = drive(id, route);
      await tick();
      capture.stop();

      // The refusal neither cancels the probe nor stops it short of the nav root.
      if (probe) {
        expect(probe.defaultPrevented).toBe(false);
        expect(reached).toHaveBeenCalledOnce();
      }
      expect(capture.seen).toEqual([]);
      expect(byId("m1").getAttribute("aria-expanded")).toBe("true");
      expect(byId("mp1").hidden).toBe(false);
      expect(byId(id).getAttribute("aria-expanded")).toBe("false");
      expect(panelOf(id).hidden).toBe(true);
      expect(document.activeElement).toBe(byId("m1"));
    },
  );

  it.each(ROUTES)("still opens an enabled trigger through %s", async (route) => {
    byId("m1").focus();
    byId("m1").click();
    const capture = captureNav();

    drive("m5", route);
    await tick();
    capture.stop();

    const reason = route === "element" ? "api" : "user";
    expect(capture.names()).toEqual(["close", "open"]);
    expect(capture.reasons()).toEqual([reason, reason]);
    expect(byId("mp1").hidden).toBe(true);
    expect(byId("m5").getAttribute("aria-expanded")).toBe("true");
    expect(byId("mp5").hidden).toBe(false);
    expect(document.activeElement).toBe(byId("m1"));
  });

  it.each(
    CONSTRAINTS.flatMap((constraint) =>
      (["element", "probe"] as const).map((route) => [constraint, route] as const),
    ),
  )("still closes an open panel whose trigger turned %s, through %s", async (constraint, route) => {
    // Opening is the activation the constraint forbids, so a panel already open
    // behind a constrained trigger still closes through that trigger.
    byId("m1").click();
    if (constraint === "aria-disabled") byId("m1").setAttribute("aria-disabled", "true");
    else byId("m1").toggleAttribute(constraint, true);
    const capture = captureNav();

    drive("m1", route);
    await tick();
    capture.stop();

    expect(capture.names()).toEqual(["close"]);
    expect(capture.reasons()).toEqual([route === "element" ? "api" : "user"]);
    expect(byId("m1").getAttribute("aria-expanded")).toBe("false");
    expect(byId("mp1").hidden).toBe(true);
  });

  it.each(CONSTRAINTS)("keeps the %s trigger shut when hover opening is on", async (constraint) => {
    // The hover path reaches `#openPanel` without going through `toggle`, so it
    // needs the guard in its own right. Re-mounted because hover opening is a
    // Value the shared fixture does not set, and the open is behind the hover
    // delay — advancing the timer is what makes this case discriminate at all.
    await remountWithHover();
    const id = CONSTRAINED[constraint];
    let delivered = 0;
    byId(id).addEventListener("mouseenter", () => delivered++);
    const capture = captureNav();

    vi.useFakeTimers();
    try {
      // Well past `hoverDelay` (150), not exactly it: a negative assertion that
      // advances by the current default goes quietly hollow the day the default
      // changes. The other "did not happen" cases in this file that run on the
      // default delay use 300 too.
      byId(id).dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);

      // The engine delivers `mouseenter` to a natively disabled button too, so the
      // hover handler ran and the refusal is the controller's.
      expect(delivered).toBe(1);
      expect(byId(id).getAttribute("aria-expanded")).toBe("false");
      expect(panelOf(id).hidden).toBe(true);
      expect(capture.seen).toEqual([]);

      // The same wiring opens an enabled trigger.
      byId("m5").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);

      expect(byId("mp5").hidden).toBe(false);
      expect(capture.names()).toEqual(["open"]);
    } finally {
      capture.stop();
      vi.useRealTimers();
    }
  });

  it.each(CONSTRAINTS)(
    "drops a pending hover open when toggle refuses the %s trigger",
    async (constraint) => {
      // Every explicit activation cancels the hover reservation, a refused one
      // included; the refusal itself opens nothing and reports nothing.
      await remountWithHover();
      const capture = captureNav();

      vi.useFakeTimers();
      try {
        byId("m1").dispatchEvent(new MouseEvent("mouseenter"));
        instance().toggle(byId(CONSTRAINED[constraint]));
        vi.advanceTimersByTime(300);

        expect(byId("mp1").hidden).toBe(true);
        expect(byId("m1").getAttribute("aria-expanded")).toBe("false");
        expect(capture.seen).toEqual([]);
      } finally {
        capture.stop();
        vi.useRealTimers();
      }
    },
  );

  it.each(CONSTRAINTS)(
    "leaves an open panel alone when hover lands on the %s trigger",
    async (constraint) => {
      // `#openFromHover` rescues focus out of the panel it is about to hide *before*
      // opening the next one. When the next one refuses to open, that rescue has
      // bought nothing — focus leaves a panel that stays open. The guard therefore
      // has to run before the rescue.
      await remountWithHover();

      vi.useFakeTimers();
      try {
        byId("m1").dispatchEvent(new MouseEvent("mouseenter"));
        vi.advanceTimersByTime(300);
        byId("mp1").querySelector("a")?.focus();
        const inside = document.activeElement;

        byId(CONSTRAINED[constraint]).dispatchEvent(new MouseEvent("mouseenter"));
        vi.advanceTimersByTime(300);

        expect(byId("mp1").hidden).toBe(false); // nothing was hidden…
        expect(document.activeElement).toBe(inside); // …so nothing had to move
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

/**
 * A click is judged once, when it starts: a capture listener takes the verdict
 * before any consumer handler on the trigger runs, and `toggle` keeps it when the
 * trigger it resolves is among those the verdict was taken for. A consumer command
 * that marks its own trigger busy during that click (`disabled` or `aria-disabled`
 * while it runs) therefore still gets the open it started, exactly as when its
 * handler changes nothing. A trigger the verdict was not taken for — a handler that
 * ran first moved the target out of it — is judged when `toggle` runs, as is any
 * other event.
 */
describe("NavigationMenuController judging a click when it starts", () => {
  let application: Application;

  /**
   * Mounts `html` and runs `prepare` before Stimulus binds the actions, so a
   * listener `prepare` adds to a trigger runs ahead of the controller's action there.
   */
  const mountWith = async (prepare: () => void, html = markup()): Promise<void> => {
    document.body.innerHTML = html;
    prepare();
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  const instance = (): NavigationMenuController => {
    const root = document.querySelector("[data-controller='stimeo--navigation-menu']");
    const found =
      root && application.getControllerForElementAndIdentifier(root, "stimeo--navigation-menu");
    if (!(found instanceof NavigationMenuController)) throw new Error("Expected nav controller");
    return found;
  };

  /** What a consumer command writes on its own trigger; `none` is the positive control. */
  const MARKS = ["none", "disabled", "aria-disabled"] as const;
  type Mark = (typeof MARKS)[number];

  /** Adds a consumer command on `id` that marks its own trigger with `mark` each time it runs. */
  const addCommand = (id: string, mark: Mark, command: () => void, type = "click"): void => {
    const trigger = byId(id);
    trigger.addEventListener(type, () => {
      command();
      if (mark === "aria-disabled") trigger.setAttribute("aria-disabled", "true");
      else if (mark === "disabled") trigger.toggleAttribute("disabled", true);
    });
  };

  it.each(MARKS)("opens the panel of a trigger whose click marks it %s", async (mark) => {
    const command = vi.fn();
    await mountWith(() => addCommand("t2", mark, command));
    byId("t1").click();
    const capture = captureStateEvents("stimeo--navigation-menu");

    byId("t2").click();
    await tick();
    capture.stop();

    expect(command).toHaveBeenCalledOnce();
    expect(capture.names()).toEqual(["close", "open"]);
    expect(capture.reasons()).toEqual(["user", "user"]);
    expect(byId("p1").hidden).toBe(true);
    expect(byId("t2").getAttribute("aria-expanded")).toBe("true");
    expect(byId("p2").hidden).toBe(false);
  });

  it.each(MARKS)(
    "judges a non-click event when toggle runs, after a command marked the trigger %s",
    async (mark) => {
      const command = vi.fn();
      await mountWith(() => addCommand("t2", mark, command, "probe"));
      byId("t1").click();
      byId("t2").addEventListener("probe", (event) => instance().toggle(event));
      const capture = captureStateEvents("stimeo--navigation-menu");

      byId("t2").dispatchEvent(new Event("probe", { bubbles: true, cancelable: true }));
      await tick();
      capture.stop();

      expect(command).toHaveBeenCalledOnce();
      expect(capture.names()).toEqual(mark === "none" ? ["close", "open"] : []);
      expect(byId("t2").getAttribute("aria-expanded")).toBe(mark === "none" ? "true" : "false");
      expect(byId("p1").hidden).toBe(mark === "none");
    },
  );

  // A trigger nested in another trigger is the shape where more than one trigger holds
  // the click target. The capture listener records a verdict for both, and the click is
  // refused when either one refuses activation, so the action bound on the inner
  // trigger refuses it whichever of the two is `hidden`.
  it.each(["outer", "inner"] as const)(
    "refuses the inner trigger of a nested pair when toggle runs (%s hidden)",
    async (hiddenOne) => {
      await mountWith(
        () => {},
        `<nav data-controller="stimeo--navigation-menu" aria-label="Main">
          <div id="outer" data-stimeo--navigation-menu-target="trigger"
               aria-expanded="false" aria-controls="outer-panel">
            <span id="inner" data-stimeo--navigation-menu-target="trigger"
                  aria-expanded="false" aria-controls="inner-panel"
                  data-action="click->stimeo--navigation-menu#toggle">Run</span>
          </div>
          <div id="outer-panel" data-stimeo--navigation-menu-target="panel" hidden>Outer</div>
          <div id="inner-panel" data-stimeo--navigation-menu-target="panel" hidden>Inner</div>
        </nav>`,
      );
      byId(hiddenOne).hidden = true;
      const capture = captureStateEvents("stimeo--navigation-menu");

      byId("inner").click();
      await tick();
      capture.stop();

      expect(capture.names()).toEqual([]);
      expect(byId("inner-panel").hidden).toBe(true);
    },
  );

  it("releases its click capture listener on disconnect", async () => {
    await mountWith(() => {});
    const controller = instance();
    controller.disconnect();
    const ledger = recordListeners();
    try {
      controller.connect();
      const clicks = ledger.live(controller.element, "click").filter(({ capture }) => capture);
      expect(clicks).toHaveLength(1);

      controller.disconnect();

      expect(clicks.filter(({ live }) => live)).toEqual([]);
    } finally {
      ledger.restore();
    }
  });
});

/**
 * Triggers nested in one another. An operation is refused when any trigger this nav
 * owns that holds the operation's target refuses activation — the target being the
 * event's target, the element handed to `toggle`, or the trigger a hover lands on. A
 * `hidden`, natively `disabled` or `aria-disabled` inner trigger therefore refuses what
 * lands inside it whichever trigger receives the action, and an outer trigger that
 * refuses refuses what lands inside it too. What lands on the outer trigger outside the
 * inner one is judged on the outer trigger alone.
 */
describe("NavigationMenuController with nested triggers", () => {
  let application: Application;

  afterEach(() => {
    vi.useRealTimers();
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const expanded = (id: string) => byId(id).getAttribute("aria-expanded");

  const instance = (): NavigationMenuController => {
    const root = document.querySelector("[data-controller='stimeo--navigation-menu']");
    const found =
      root && application.getControllerForElementAndIdentifier(root, "stimeo--navigation-menu");
    if (!(found instanceof NavigationMenuController)) throw new Error("Expected nav controller");
    return found;
  };

  /**
   * The state the inner trigger carries; `enabled` with an enabled outer is the positive
   * control.
   */
  const INNER = {
    enabled: "",
    "aria-disabled": 'aria-disabled="true"',
    hidden: "hidden",
    disabled: "disabled",
  } as const;
  type Inner = keyof typeof INNER;

  /** The state the outer trigger carries; its `aria-disabled` reaches the inner trigger too. */
  const OUTER = { enabled: "", "aria-disabled": 'aria-disabled="true"', hidden: "hidden" } as const;
  type Outer = keyof typeof OUTER;

  /**
   * Where an operation lands and which trigger receives the action; `label` is the text
   * holder inside the inner trigger, `element` hands the landing trigger to `toggle`,
   * and `hover` is a `mouseenter` on it. A natively `disabled` button is dispatched no
   * click of its own, while happy-dom delivers one dispatched on content inside it, so
   * a click inside the inner trigger lands on the label.
   */
  const ROUTES = {
    "a click inside the inner, received by the inner": {
      kind: "click",
      at: "label",
      receiver: "inner",
    },
    "a click inside the inner, received by the outer": {
      kind: "click",
      at: "label",
      receiver: "outer",
    },
    "the inner as the element": { kind: "element", at: "inner", receiver: "inner" },
    "a probe inside the inner, received by the inner": {
      kind: "probe",
      at: "label",
      receiver: "inner",
    },
    "a probe inside the inner, received by the outer": {
      kind: "probe",
      at: "label",
      receiver: "outer",
    },
    "a hover on the inner": { kind: "hover", at: "inner", receiver: "inner" },
    "a click on the outer": { kind: "click", at: "outer", receiver: "outer" },
    "the outer as the element": { kind: "element", at: "outer", receiver: "outer" },
    "a probe on the outer": { kind: "probe", at: "outer", receiver: "outer" },
    "a hover on the outer": { kind: "hover", at: "outer", receiver: "outer" },
  } as const;
  type Route = keyof typeof ROUTES;

  /** Whether `route` lands inside the inner trigger. */
  const insideInner = (route: Route): boolean => ROUTES[route].at !== "outer";

  /** Whether a trigger holding the route's target refuses activation. */
  const refuses = (inner: Inner, outer: Outer, route: Route): boolean =>
    outer !== "enabled" || (insideInner(route) && inner !== "enabled");

  const ROWS = (Object.keys(INNER) as Inner[]).flatMap((inner) =>
    (Object.keys(OUTER) as Outer[]).flatMap((outer) =>
      (Object.keys(ROUTES) as Route[]).map((route) => ({
        inner,
        outer,
        route,
        outcome: refuses(inner, outer, route) ? "refuses" : "opens",
      })),
    ),
  );

  /** Mounts a trigger nested in another trigger, each controlling its own panel. */
  const mountPair = async (inner: Inner, outer: Outer): Promise<void> => {
    document.body.innerHTML = `
      <nav data-controller="stimeo--navigation-menu" aria-label="Main"
           data-stimeo--navigation-menu-open-on-hover-value="true">
        <div id="outer" ${OUTER[outer]} data-stimeo--navigation-menu-target="trigger"
             aria-expanded="false" aria-controls="outer-panel">
          <button id="inner" ${INNER[inner]} data-stimeo--navigation-menu-target="trigger"
                  aria-expanded="false"
                  aria-controls="inner-panel"><span id="label">Run</span></button>
        </div>
        <div id="outer-panel" data-stimeo--navigation-menu-target="panel" hidden>Outer</div>
        <div id="inner-panel" data-stimeo--navigation-menu-target="panel" hidden>Inner</div>
      </nav>`;
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  };

  /**
   * Delivers `route` to `toggle`, or hovers. A consumer command listens where an event
   * lands; the nav stops no click, so every click and probe reaches it.
   */
  const drive = (route: Route) => {
    const { kind, at, receiver } = ROUTES[route];
    const command = vi.fn();
    if (kind === "element") {
      instance().toggle(byId(at));
      return { event: null, command };
    }
    if (kind === "hover") {
      vi.useFakeTimers();
      byId(at).dispatchEvent(new MouseEvent("mouseenter"));
      // Well past the default `hoverDelay` of 150.
      vi.advanceTimersByTime(300);
      vi.useRealTimers();
      return { event: null, command };
    }
    byId(at).addEventListener(kind, command);
    byId(receiver).addEventListener(kind, (event) => instance().toggle(event));
    const event =
      kind === "click"
        ? new MouseEvent("click", { bubbles: true, cancelable: true })
        : new Event("probe", { bubbles: true, cancelable: true });
    byId(at).dispatchEvent(event);
    return { event, command };
  };

  const REASONS = { click: "user", probe: "user", element: "api", hover: "pointer" } as const;

  it.each(ROWS)(
    "$outcome the $inner inner trigger in the $outer outer trigger through $route",
    async ({ inner, outer, route }) => {
      await mountPair(inner, outer);
      const capture = captureStateEvents("stimeo--navigation-menu");

      const { event, command } = drive(route);
      await tick();
      capture.stop();

      if (event) {
        expect(event.defaultPrevented).toBe(false);
        expect(command).toHaveBeenCalledOnce();
      }
      const { kind, at, receiver } = ROUTES[route];
      const opened = kind === "element" || kind === "hover" ? at : receiver;
      const shut = opened === "inner" ? "outer" : "inner";
      if (refuses(inner, outer, route)) {
        expect(capture.seen).toEqual([]);
        expect(expanded("outer")).toBe("false");
        expect(expanded("inner")).toBe("false");
        expect(byId("outer-panel").hidden).toBe(true);
        expect(byId("inner-panel").hidden).toBe(true);
      } else {
        expect(capture.names()).toEqual(["open"]);
        expect(capture.reasons()).toEqual([REASONS[kind]]);
        expect(expanded(opened)).toBe("true");
        expect(byId(`${opened}-panel`).hidden).toBe(false);
        expect(expanded(shut)).toBe("false");
        expect(byId(`${shut}-panel`).hidden).toBe(true);
      }
    },
  );

  it.each(["enabled", "hidden"] as const)(
    "judges a probe dispatched at the text inside the %s inner trigger by the triggers holding it",
    async (inner) => {
      await mountPair(inner, "enabled");
      const text = byId("label").firstChild as Text;
      // Pinned: the target is a node that is not an element.
      expect(text.nodeType).toBe(Node.TEXT_NODE);
      byId("outer").addEventListener("probe", (event) => instance().toggle(event));
      const capture = captureStateEvents("stimeo--navigation-menu");

      text.dispatchEvent(new Event("probe", { bubbles: true }));
      await tick();
      capture.stop();

      expect(capture.names()).toEqual(inner === "hidden" ? [] : ["open"]);
      expect(byId("outer-panel").hidden).toBe(inner === "hidden");
    },
  );
});

/**
 * `aria-disabled="true"` extends to every focusable descendant, so a trigger inside
 * an element that carries it never opens, through a click, an element, any other
 * event or hover, as if it carried the attribute itself. Its click is not swallowed,
 * and it stays an arrow-key destination.
 */
describe("NavigationMenuController under an aria-disabled ancestor", () => {
  let application: Application;

  /** One trigger and its panel in their own list item. */
  const entry = (id: string, label: string) => `
    <li id="${id}-li">
      <button id="${id}" data-stimeo--navigation-menu-target="trigger"
              aria-expanded="false" aria-controls="${id}-panel"
              data-action="click->stimeo--navigation-menu#toggle
                           keydown->stimeo--navigation-menu#onTriggerKeydown">${label}</button>
      <div id="${id}-panel" data-stimeo--navigation-menu-target="panel" hidden>
        <a href="/${id}">${label}</a>
      </div>
    </li>`;

  beforeEach(async () => {
    const hover = 'data-stimeo--navigation-menu-open-on-hover-value="true"';
    document.body.innerHTML = `
      <div id="ni-outer">
        <nav id="ni-nav" data-controller="stimeo--navigation-menu" aria-label="Main" ${hover}>
          <ul>${entry("ni-one", "One")}${entry("ni-two", "Two")}</ul>
        </nav>
      </div>
      <nav id="ni-other" data-controller="stimeo--navigation-menu" aria-label="Other" ${hover}>
        <ul>${entry("ni-three", "Three")}</ul>
      </nav>`;
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

  const ROUTES = ["click", "element", "probe", "hover"] as const;
  type Route = (typeof ROUTES)[number];

  /** The trigger outside each aria-disabled ancestor, which keeps working beside it. */
  const CONTROLS = { "ni-two-li": "ni-one", "ni-nav": "ni-three", "ni-outer": "ni-three" } as const;
  type Ancestor = keyof typeof CONTROLS;
  const ROWS = (Object.keys(CONTROLS) as Ancestor[]).flatMap((ancestor) =>
    ROUTES.map((route) => [ancestor, route] as const),
  );

  /** What a click or a probe showed on the page: cancelled, handled on the trigger, reached. */
  interface Seen {
    prevented: boolean;
    handled: number;
    reached: number;
  }

  /**
   * Drives `toggle` on `id` through `route`, or hovers it past the delay. A click
   * and a probe are cancelable and bubble; a consumer handler on the trigger and a
   * listener on the document report whether each got past the trigger.
   */
  const drive = (id: string, route: Route): Seen | null => {
    const trigger = byId(id);
    const root = trigger.closest("[data-controller~='stimeo--navigation-menu']");
    const controller =
      root && application.getControllerForElementAndIdentifier(root, "stimeo--navigation-menu");
    if (!(controller instanceof NavigationMenuController))
      throw new Error("Expected nav controller");
    if (route === "element") {
      controller.toggle(trigger);
      return null;
    }
    if (route === "hover") {
      vi.useFakeTimers();
      try {
        trigger.dispatchEvent(new MouseEvent("mouseenter"));
        vi.advanceTimersByTime(300);
      } finally {
        vi.useRealTimers();
      }
      return null;
    }
    const seen = { prevented: false, handled: 0, reached: 0 };
    const handler = () => seen.handled++;
    const reached = () => seen.reached++;
    const type = route === "click" ? "click" : "probe";
    trigger.addEventListener(type, handler);
    if (route === "probe") {
      trigger.addEventListener("probe", (event) => controller.toggle(event), { once: true });
    }
    document.addEventListener(type, reached);
    const event =
      route === "click"
        ? new MouseEvent("click", { bubbles: true, cancelable: true })
        : new Event("probe", { bubbles: true, cancelable: true });
    trigger.dispatchEvent(event);
    document.removeEventListener(type, reached);
    trigger.removeEventListener(type, handler);
    seen.prevented = event.defaultPrevented;
    return seen;
  };

  /** The reason each route reports for an open. */
  const REASONS = { click: "user", element: "api", probe: "user", hover: "pointer" } as const;

  it.each(ROWS)(
    "never opens a trigger under an aria-disabled %s through %s",
    async (ancestor, route) => {
      byId("ni-one").click(); // opens One before the ancestor turns aria-disabled
      byId(ancestor).setAttribute("aria-disabled", "true");
      const capture = captureStateEvents("stimeo--navigation-menu");

      const seen = drive("ni-two", route);
      await tick();
      capture.stop();

      // The nav leaves the click itself alone; only the open is refused.
      if (route === "click" || route === "probe") {
        expect(seen).toEqual({ prevented: false, handled: 1, reached: 1 });
      }
      expect(capture.seen).toEqual([]);
      expect(expanded("ni-one")).toBe("true");
      expect(byId("ni-one-panel").hidden).toBe(false);
      expect(expanded("ni-two")).toBe("false");
      expect(byId("ni-two-panel").hidden).toBe(true);
    },
  );

  it.each(ROWS)(
    "still opens the trigger outside an aria-disabled %s through %s",
    async (ancestor, route) => {
      byId(ancestor).setAttribute("aria-disabled", "true");
      const control = CONTROLS[ancestor];
      const capture = captureStateEvents("stimeo--navigation-menu");

      drive(control, route);
      await tick();
      capture.stop();

      expect(capture.names()).toEqual(["open"]);
      expect(capture.reasons()).toEqual([REASONS[route]]);
      expect(expanded(control)).toBe("true");
      expect(byId(`${control}-panel`).hidden).toBe(false);
    },
  );

  it("keeps triggers under an aria-disabled nav reachable with the arrow keys", () => {
    byId("ni-nav").setAttribute("aria-disabled", "true");

    keyboardPress(byId("ni-one"), "ArrowRight");
    expect(document.activeElement).toBe(byId("ni-two"));

    keyboardPress(byId("ni-two"), "ArrowLeft");
    expect(document.activeElement).toBe(byId("ni-one"));
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
    const event = keyEvent("ArrowRight");
    keyboardPress(byId("s1"), event);
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

/** Explicit target calls share the DOM action while retaining their own provenance. */
describe("NavigationMenuController target API", () => {
  let application: Application;
  const element = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing API fixture ${id}`);
    return found;
  };
  const instance = (): NavigationMenuController =>
    application.getControllerForElementAndIdentifier(
      element("api-root"),
      "stimeo--navigation-menu",
    ) as NavigationMenuController;
  beforeEach(async () => {
    document.body.innerHTML = `<button id="api-outside">Outside</button><div id="api-root" data-controller="stimeo--navigation-menu" ><button id="api-a" data-stimeo--navigation-menu-target="trigger" aria-controls="api-panel-a" aria-expanded="false" data-action="click->stimeo--navigation-menu#toggle"><span>a</span></button><div id="api-panel-a" role="region" data-stimeo--navigation-menu-target="panel" hidden>Panel</div><button id="api-b" data-stimeo--navigation-menu-target="trigger" aria-controls="api-panel-b" aria-expanded="false" data-action="click->stimeo--navigation-menu#toggle"><span>b</span></button><div id="api-panel-b" role="region" data-stimeo--navigation-menu-target="panel" hidden>Panel</div></div>`;
    application = Application.start();
    application.register("stimeo--navigation-menu", NavigationMenuController);
    await tick();
  });
  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("opens a panel from a DOM click as the positive control", () => {
    const reports: Array<{ reason?: string }> = [];
    element("api-root").addEventListener("stimeo--navigation-menu:open", (event) => {
      reports.push((event as CustomEvent<{ reason?: string }>).detail);
    });
    element("api-b").click();
    expect(element("api-b").getAttribute("aria-expanded")).toBe("true");
    expect(reports).toHaveLength(1);
  });

  it.each([false, true])(
    "accepts an owned target or its descendant (%s) through the element API",
    (descendant) => {
      const reports: Array<{ reason?: string }> = [];
      element("api-root").addEventListener("stimeo--navigation-menu:open", (event) => {
        reports.push((event as CustomEvent<{ reason?: string }>).detail);
      });
      element("api-b").click();
      expect(element("api-b").getAttribute("aria-expanded")).toBe("true");
      expect(reports).toHaveLength(1);
      element("api-outside").focus();
      const target = descendant ? element("api-a").querySelector("span") : element("api-a");
      if (!(target instanceof HTMLElement)) throw new Error("Missing API descendant");
      instance().toggle(target);
      expect(element("api-a").getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(element("api-outside"));
      expect(reports.at(-1)?.reason).toBe("api");
      expect(reports[0]?.reason).toBe("user");
    },
  );
  it.each(["foreign", "undeclared", "detached", "nested"])(
    "rejects %s targets through element and Event entry points before accepting an owned target",
    (kind) => {
      const reports: unknown[] = [];
      element("api-root").addEventListener("stimeo--navigation-menu:open", (event) => {
        reports.push((event as CustomEvent<unknown>).detail);
      });
      const invalid = element("api-b").cloneNode(true);
      if (!(invalid instanceof HTMLElement)) throw new Error("Missing cloned target");
      invalid.id = "api-invalid";
      invalid.removeAttribute("data-action");
      if (kind === "foreign") document.body.append(invalid);
      if (kind === "undeclared") {
        invalid.removeAttribute("data-stimeo--navigation-menu-target");
        element("api-root").append(invalid);
      }
      if (kind === "nested") {
        const nested = document.createElement("div");
        nested.setAttribute("data-controller", "stimeo--navigation-menu");
        nested.append(invalid);
        element("api-a").append(nested);
      }
      element("api-outside").focus();
      const before = element("api-root").innerHTML;
      instance().toggle(invalid);
      invalid.addEventListener("probe", (event) => instance().toggle(event));
      invalid.dispatchEvent(new Event("probe"));
      expect(element("api-root").innerHTML).toBe(before);
      expect(reports).toEqual([]);
      expect(document.activeElement).toBe(element("api-outside"));
      instance().toggle(element("api-b"));
      expect(element("api-b").getAttribute("aria-expanded")).toBe("true");
      expect(reports).toHaveLength(1);
    },
  );

  it.each([
    ["focusin", "focus"],
    ["pointerenter", "pointer"],
    ["click", "user"],
  ])("retains %s Event provenance for an action bound on a target descendant", (type, reason) => {
    const reports: Array<{ reason: string }> = [];
    element("api-root").addEventListener("stimeo--navigation-menu:open", (event) => {
      reports.push((event as CustomEvent<{ reason: string }>).detail);
    });
    const child = element("api-b").querySelector("span");
    if (!(child instanceof HTMLElement)) throw new Error("Missing action descendant");
    child.addEventListener(type, (event) => instance().toggle(event));
    child.dispatchEvent(new Event(type));
    expect(element("api-b").getAttribute("aria-expanded")).toBe("true");
    expect(reports.map((detail) => detail.reason)).toEqual([reason]);
  });

  it.each(
    (["aria-disabled", "disabled", "hidden"] as const).flatMap((constraint) =>
      [false, true].map((descendant) => [constraint, descendant] as const),
    ),
  )(
    "refuses the %s trigger through the element API, from the trigger or its descendant (%s)",
    async (constraint, descendant) => {
      const trigger = element("api-b");
      if (constraint === "aria-disabled") trigger.setAttribute("aria-disabled", "true");
      else trigger.toggleAttribute(constraint, true);
      element("api-outside").focus();
      const capture = captureStateEvents(
        "stimeo--navigation-menu",
        ["open", "close"],
        element("api-root"),
      );
      const source = descendant ? trigger.querySelector("span") : trigger;
      if (!(source instanceof HTMLElement)) throw new Error("Missing API source");

      instance().toggle(source);
      await tick();
      capture.stop();

      expect(capture.seen).toEqual([]);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(element("api-panel-b").hidden).toBe(true);
      expect(document.activeElement).toBe(element("api-outside"));
    },
  );

  it("rejects a nested origin even when the Event handler belongs to an owned outer target", () => {
    const nested = document.createElement("div");
    nested.setAttribute("data-controller", "stimeo--navigation-menu");
    const child = document.createElement("span");
    child.setAttribute("data-stimeo--navigation-menu-target", "trigger");
    nested.append(child);
    element("api-b").append(nested);
    const reports = vi.fn();
    element("api-root").addEventListener("stimeo--navigation-menu:open", reports);
    const before = element("api-root").innerHTML;
    element("api-b").addEventListener("probe", (event) => instance().toggle(event));
    child.dispatchEvent(new Event("probe", { bubbles: true }));
    expect(element("api-root").innerHTML).toBe(before);
    expect(reports).not.toHaveBeenCalled();
    instance().toggle(element("api-b"));
    expect(reports).toHaveBeenCalledOnce();
  });
  it("does not reacquire hover listeners from a Value callback after disconnect", () => {
    vi.useFakeTimers();
    try {
      instance().openOnHoverValue = true;
      instance().openOnHoverValueChanged();
      instance().disconnect();
      instance().openOnHoverValueChanged();
      element("api-b").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
      expect(element("api-panel-b").hidden).toBe(true);
      instance().connect();
      element("api-b").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
      expect(element("api-panel-b").hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restore focus from an Escape layer after authored markup has closed its last panel", () => {
    element("api-a").focus();
    instance().toggle(element("api-a"));
    element("api-a").setAttribute("aria-expanded", "false");
    element("api-panel-a").hidden = true;
    const errors: unknown[] = [];
    const captureError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", captureError);
    try {
      expect(() => keyboardPress(element("api-a"), "Escape")).not.toThrow();
      expect(errors).toEqual([]);
      expect(document.activeElement).toBe(element("api-a"));
      expect(element("api-panel-a").hidden).toBe(true);
      instance().toggle(element("api-b"));
      element("api-b").focus();
      keyboardPress(element("api-b"), "Escape");
      expect(element("api-panel-b").hidden).toBe(true);
      expect(document.activeElement).toBe(element("api-b"));
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener("error", captureError);
    }
  });

  it("ignores hover areas without a trigger while owned triggers still open after the delay", () => {
    vi.useFakeTimers();
    try {
      const empty = document.createElement("div");
      empty.setAttribute("data-stimeo--navigation-menu-target", "hoverArea");
      element("api-root").append(empty);
      instance().openOnHoverValue = true;
      instance().openOnHoverValueChanged();
      const pending = vi.getTimerCount();
      empty.dispatchEvent(new MouseEvent("mouseenter"));
      expect(vi.getTimerCount()).toBe(pending);
      element("api-b").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
      expect(element("api-panel-b").hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending hover close when the pointer reaches the controlled panel", () => {
    vi.useFakeTimers();
    try {
      instance().openOnHoverValue = true;
      instance().openOnHoverValueChanged();
      element("api-a").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
      expect(element("api-panel-a").hidden).toBe(false);
      element("api-a").dispatchEvent(new MouseEvent("mouseleave"));
      element("api-panel-a").dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(300);
      expect(element("api-panel-a").hidden).toBe(false);
      element("api-panel-a").dispatchEvent(new MouseEvent("mouseleave"));
      vi.advanceTimersByTime(300);
      expect(element("api-panel-a").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an empty controls declaration even when an owned panel has no id", () => {
    const unnamed = document.createElement("div");
    unnamed.setAttribute("data-stimeo--navigation-menu-target", "panel");
    unnamed.hidden = true;
    element("api-root").append(unnamed);
    element("api-b").setAttribute("aria-controls", "");
    const reports = vi.fn();
    element("api-root").addEventListener("stimeo--navigation-menu:open", reports);
    instance().toggle(element("api-b"));
    expect(unnamed.hidden).toBe(true);
    expect(reports).not.toHaveBeenCalled();
    element("api-b").setAttribute("aria-controls", "api-panel-b");
    instance().toggle(element("api-b"));
    expect(element("api-panel-b").hidden).toBe(false);
    expect(reports).toHaveBeenCalledOnce();
  });
  it("uses relatedTarget only for MouseEvent leave notifications", () => {
    vi.useFakeTimers();
    try {
      instance().openOnHoverValue = true;
      instance().openOnHoverValueChanged();
      instance().toggle(element("api-a"));
      const options = { relatedTarget: element("api-b") };
      element("api-a").dispatchEvent(new MouseEvent("mouseleave", options));
      vi.advanceTimersByTime(300);
      expect(element("api-panel-a").hidden).toBe(false);
      element("api-a").dispatchEvent(new FocusEvent("mouseleave", options));
      vi.advanceTimersByTime(300);
      expect(element("api-panel-a").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The trigger `toggle` resolves is the one the action is bound to (the event's
 * `currentTarget`), whatever the event's target has become since. A handler that moves
 * the target out of a refused trigger before `toggle` runs leaves the trigger itself
 * to judge, so it still does not open.
 */
describe("NavigationMenuController when the target leaves the resolved trigger", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it.each([
    ["aria-disabled", 'aria-disabled="true"', []],
    ["hidden", "hidden", []],
    ["disabled", "disabled", []],
    ["enabled", "", ["open"]],
  ] as const)(
    "judges the %s trigger when a handler moves the probe target out of it",
    async (_state, helpState, reported) => {
      document.body.innerHTML = `
        <nav id="nav" data-controller="stimeo--navigation-menu" aria-label="Main">
          <button id="help" ${helpState} data-stimeo--navigation-menu-target="trigger"
                  aria-expanded="false"
                  aria-controls="help-panel"><span id="label">Help</span></button>
          <div id="help-panel" data-stimeo--navigation-menu-target="panel" hidden>Help</div>
        </nav>`;
      application = Application.start();
      application.register("stimeo--navigation-menu", NavigationMenuController);
      await tick();
      const controller = application.getControllerForElementAndIdentifier(
        document.getElementById("nav") as HTMLElement,
        "stimeo--navigation-menu",
      ) as NavigationMenuController;
      const nav = document.getElementById("nav") as HTMLElement;
      const help = document.getElementById("help") as HTMLElement;
      const label = document.getElementById("label") as HTMLElement;
      label.addEventListener("probe", () => nav.append(label));
      help.addEventListener("probe", (event) => controller.toggle(event));
      const capture = captureStateEvents("stimeo--navigation-menu");

      label.dispatchEvent(new Event("probe", { bubbles: true }));
      await tick();
      capture.stop();

      expect(capture.names()).toEqual(reported);
    },
  );

  it.each([
    ["aria-disabled", 'aria-disabled="true"', []],
    ["enabled", "", ["open"]],
  ] as const)(
    "judges the %s trigger whose click target a document capture handler moves into another",
    async (_state, helpState, reported) => {
      document.body.innerHTML = `
        <nav id="nav" data-controller="stimeo--navigation-menu" aria-label="Main">
          <button id="help" ${helpState} data-stimeo--navigation-menu-target="trigger"
                  aria-expanded="false"
                  aria-controls="help-panel"><span id="label">Help</span></button>
          <div id="help-panel" data-stimeo--navigation-menu-target="panel" hidden>Help</div>
          <button id="docs" data-stimeo--navigation-menu-target="trigger"
                  aria-expanded="false" aria-controls="docs-panel">Docs</button>
          <div id="docs-panel" data-stimeo--navigation-menu-target="panel" hidden>Docs</div>
        </nav>`;
      application = Application.start();
      application.register("stimeo--navigation-menu", NavigationMenuController);
      await tick();
      const controller = application.getControllerForElementAndIdentifier(
        document.getElementById("nav") as HTMLElement,
        "stimeo--navigation-menu",
      ) as NavigationMenuController;
      const help = document.getElementById("help") as HTMLElement;
      const docs = document.getElementById("docs") as HTMLElement;
      const label = document.getElementById("label") as HTMLElement;
      // Runs before the controller's own capture pass, so the click is recorded for Docs.
      const move = () => docs.append(label);
      document.addEventListener("click", move, { capture: true });
      help.addEventListener("click", (event) => controller.toggle(event));
      const capture = captureStateEvents("stimeo--navigation-menu");

      label.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      document.removeEventListener("click", move, { capture: true });
      await tick();
      capture.stop();

      expect(capture.names()).toEqual(reported);
    },
  );
});

/**
 * A click on a nested pair of triggers is judged for both when it starts, so a handler
 * that marks either one `aria-disabled` during the click does not undo the open that
 * click started, whichever trigger `toggle` is bound to.
 */
describe("NavigationMenuController with a nested pair marked during a click", () => {
  let application: Application;
  const element = (id: string) => document.getElementById(id) as HTMLElement;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it.each([
    ["no trigger", "inner", "none"],
    ["the inner trigger", "inner", "inner"],
    ["the inner trigger", "outer", "inner"],
    ["the outer trigger", "inner", "outer"],
    ["the outer trigger", "outer", "outer"],
  ] as const)(
    "opens when a handler marks %s aria-disabled, with toggle on the %s trigger",
    async (_marked, receiver, marked) => {
      document.body.innerHTML = `
        <nav id="nav" data-controller="stimeo--navigation-menu" aria-label="Main">
          <div id="outer" data-stimeo--navigation-menu-target="trigger"
               aria-expanded="false" aria-controls="outer-panel">
            <button id="inner" data-stimeo--navigation-menu-target="trigger"
                    aria-expanded="false"
                    aria-controls="inner-panel"><span id="label">Run</span></button>
          </div>
          <div id="outer-panel" data-stimeo--navigation-menu-target="panel" hidden>Outer</div>
          <div id="inner-panel" data-stimeo--navigation-menu-target="panel" hidden>Inner</div>
        </nav>`;
      application = Application.start();
      application.register("stimeo--navigation-menu", NavigationMenuController);
      await tick();
      const controller = application.getControllerForElementAndIdentifier(
        element("nav"),
        "stimeo--navigation-menu",
      ) as NavigationMenuController;
      element("label").addEventListener("click", () => {
        if (marked !== "none") element(marked).setAttribute("aria-disabled", "true");
      });
      element(receiver).addEventListener("click", (event) => controller.toggle(event));
      const capture = captureStateEvents("stimeo--navigation-menu");

      element("label").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await tick();
      capture.stop();

      expect(capture.names()).toEqual(["open"]);
    },
  );
});
