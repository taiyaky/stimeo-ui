import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { BreadcrumbController } from "../src/controllers/breadcrumb_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link BreadcrumbController}: overflow-driven collapsing
 * of the author-marked middle items, the disclosure toggle (`aria-expanded` +
 * `hidden`), reset-on-fit, focus rescue, DOM-restored state on reconnect, the
 * `toggle` event, and resize/mutation teardown.
 *
 * happy-dom has no layout engine, so `scrollWidth`/`clientWidth` are stubbed to
 * drive the overflow condition deterministically. The geometry can be stubbed
 * *before* the controller connects (`start(markup, geometry)`) so the very first
 * render is observable, which is what the reconnect/restore cases need.
 */

/** Geometry driving the overflow decision, read from the **list** element. */
interface Geometry {
  scrollWidth: number;
  clientWidth: number;
}

/**
 * Markup builder so each case can vary one thing (missing target, no
 * collapsible items, a restored expanded state) instead of duplicating the trail.
 */
const buildMarkup = ({
  list = true,
  ellipsis = true,
  trigger = true,
  collapsible = true,
  expanded = false,
  id = "bc",
}: {
  list?: boolean;
  ellipsis?: boolean;
  trigger?: boolean;
  collapsible?: boolean;
  expanded?: boolean;
  id?: string;
} = {}): string => {
  const listAttr = list ? ` data-stimeo--breadcrumb-target="list"` : "";
  const triggerAttrs = trigger ? ` data-stimeo--breadcrumb-target="trigger"` : "";
  const ellipsisItem = ellipsis
    ? `<li data-stimeo--breadcrumb-target="ellipsis" ${expanded ? "" : "hidden"}>
        <button type="button" aria-expanded="${expanded}" aria-controls="${id}-a ${id}-b"
                aria-label="Show full path"${triggerAttrs}
                data-action="click->stimeo--breadcrumb#toggle">…</button>
      </li>`
    : "";
  const middle = collapsible
    ? `<li id="${id}-a" data-stimeo--breadcrumb-target="collapsible"><a href="/a">Section A</a></li>
       <li id="${id}-b" data-stimeo--breadcrumb-target="collapsible"><a href="/a/b">Sub B</a></li>`
    : `<li id="${id}-a"><a href="/a">Section A</a></li>
       <li id="${id}-b"><a href="/a/b">Sub B</a></li>`;

  return `
  <nav data-controller="stimeo--breadcrumb" aria-label="Breadcrumb">
    <ol${listAttr}>
      <li><a href="/">Home</a></li>
      ${ellipsisItem}
      ${middle}
      <li><a href="/a/b/c" aria-current="page">Item C</a></li>
    </ol>
  </nav>`;
};

const markup = buildMarkup();

/** Minimal controllable ResizeObserver double that records observed elements. */
class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
  }

  disconnect(): void {
    this.observed.clear();
    this.disconnected = true;
  }

  /** Test helper: simulate a notification for an element still being observed. */
  trigger(element?: Element): void {
    if (element && !this.observed.has(element)) return;
    this.callback([], this);
  }
}

describe("BreadcrumbController", () => {
  let application: Application;
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

  /** Scoped queries so multi-instance cases can address one trail at a time. */
  const queries = (scope: ParentNode) => ({
    list: () =>
      scope.querySelector<HTMLElement>("[data-stimeo--breadcrumb-target='list']") as HTMLElement,
    ellipsis: () =>
      scope.querySelector<HTMLElement>(
        "[data-stimeo--breadcrumb-target='ellipsis']",
      ) as HTMLElement,
    trigger: () =>
      scope.querySelector<HTMLElement>("[data-stimeo--breadcrumb-target='trigger']") as HTMLElement,
    collapsibles: () =>
      Array.from(
        scope.querySelectorAll<HTMLElement>("[data-stimeo--breadcrumb-target='collapsible']"),
      ),
    hiddenStates: () =>
      Array.from(
        scope.querySelectorAll<HTMLElement>("[data-stimeo--breadcrumb-target='collapsible']"),
      ).map((item) => item.hidden),
  });

  const document_ = queries(document);
  const { list, ellipsis, trigger, collapsibles, hiddenStates } = document_;
  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--breadcrumb']") as HTMLElement;

  /**
   * Stubs the geometry that drives overflow. Both widths live on the **list**
   * element (not the host `nav`) so the overflow check stays independent of any
   * host padding.
   */
  const stubGeometry = (element: HTMLElement, { scrollWidth, clientWidth }: Geometry): void => {
    Object.defineProperty(element, "scrollWidth", { configurable: true, value: scrollWidth });
    Object.defineProperty(element, "clientWidth", { configurable: true, value: clientWidth });
  };

  /**
   * Renders `html`, optionally stubbing every list's geometry **before** Stimulus
   * connects, then starts the application.
   */
  const start = async (
    html: string = markup,
    geometry?: Geometry,
    prepare?: (list: HTMLElement) => void,
  ) => {
    document.body.innerHTML = html;
    for (const element of document.querySelectorAll<HTMLElement>(
      "[data-stimeo--breadcrumb-target='list']",
    )) {
      if (geometry) stubGeometry(element, geometry);
      prepare?.(element);
    }
    application = Application.start();
    application.register("stimeo--breadcrumb", BreadcrumbController);
    await tick();
  };

  /**
   * Geometry that *answers from the current DOM* instead of a frozen number: the trail
   * is as wide as the items currently rendered in it.
   *
   * A frozen `scrollWidth` cannot distinguish **when** the controller measures, only
   * what it does with the verdict — so it cannot tell a correct pass from one that
   * measured a stale layout. Each visible item counts 100px and the ellipsis 40px,
   * which is enough to put the two orderings on opposite sides of a threshold.
   */
  const stubLiveGeometry = (list: HTMLElement, clientWidth: number): void => {
    Object.defineProperty(list, "clientWidth", { configurable: true, value: clientWidth });
    Object.defineProperty(list, "scrollWidth", {
      configurable: true,
      get: () =>
        Array.from(list.querySelectorAll("li")).reduce((total, item) => {
          if (item.hidden) return total;
          const isEllipsis = item.getAttribute("data-stimeo--breadcrumb-target") === "ellipsis";
          return total + (isEllipsis ? 40 : 100);
        }, 0),
    });
  };

  /** Re-stubs the default list's geometry and notifies through a viewport resize. */
  const resizeTo = (scrollWidth: number, clientWidth: number) => {
    stubGeometry(list(), { scrollWidth, clientWidth });
    window.dispatchEvent(new Event("resize"));
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
      originalResizeObserver = undefined;
    }
    FakeResizeObserver.instances = [];
  });

  it("shows the full trail when it fits", async () => {
    await start();
    resizeTo(80, 500);
    expect(hiddenStates()).toEqual([false, false]);
    expect(ellipsis().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the fitting state on connect, before any resize", async () => {
    await start(markup, { scrollWidth: 80, clientWidth: 500 });
    expect(hiddenStates()).toEqual([false, false]);
    expect(ellipsis().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the collapsed state on connect, before any resize", async () => {
    await start(markup, { scrollWidth: 500, clientWidth: 100 });
    expect(hiddenStates()).toEqual([true, true]);
    expect(ellipsis().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses the middle items and shows the ellipsis when overflowing", async () => {
    await start();
    resizeTo(500, 100);
    expect(hiddenStates()).toEqual([true, true]);
    expect(ellipsis().hidden).toBe(false);
    // The disclosure must advertise the collapsed state, not a stale expansion.
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("decides overflow from the list's own width, ignoring host padding", async () => {
    await start();
    // Simulate a padded host: the nav is wide, but the list's own content box is
    // narrow and its content overflows it. The decision must follow the list.
    Object.defineProperty(root(), "clientWidth", { configurable: true, value: 1000 });
    resizeTo(500, 100); // list scroll 500 > list client 100
    expect(hiddenStates()).toEqual([true, true]);
    expect(ellipsis().hidden).toBe(false);
  });

  it("tolerates a sub-pixel overshoot instead of collapsing a trail that fits", async () => {
    await start();
    // Fractional layout metrics (zoom, rounding) routinely overshoot by <1px.
    resizeTo(301, 300);
    expect(hiddenStates()).toEqual([false, false]);
    expect(ellipsis().hidden).toBe(true);
    // Beyond the tolerance it still collapses.
    resizeTo(302, 300);
    expect(hiddenStates()).toEqual([true, true]);
  });

  it("expands and re-collapses via the disclosure trigger", async () => {
    await start();
    resizeTo(500, 100);
    trigger().click();
    expect(hiddenStates()).toEqual([false, false]);
    expect(ellipsis().hidden).toBe(false); // ellipsis stays while overflowing
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    trigger().click();
    expect(hiddenStates()).toEqual([true, true]);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("wires the disclosure's click action to toggle (no key handler of our own)", async () => {
    await start();
    resizeTo(500, 100);
    const button = trigger() as HTMLButtonElement;
    // What this proves: the trigger is a native <button> whose *click* runs `toggle`.
    // What it deliberately does not claim: key activation. happy-dom never synthesizes
    // a click from a keydown on a native button, so a synthetic `keydown` here would
    // assert nothing — Enter/Space activation needs a real engine.
    expect(button.tagName).toBe("BUTTON");
    button.click();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    button.click();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("resets the expanded state when the trail fits again", async () => {
    await start();
    resizeTo(500, 100);
    trigger().click(); // expanded
    resizeTo(80, 500); // now fits
    expect(hiddenStates()).toEqual([false, false]);
    expect(ellipsis().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("ignores toggle while the trail fits (no stale aria-expanded, no event)", async () => {
    await start();
    resizeTo(80, 500);
    const details: Array<{ expanded: boolean }> = [];
    root().addEventListener("stimeo--breadcrumb:toggle", (event) => {
      details.push((event as CustomEvent).detail);
    });

    trigger().click();

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(hiddenStates()).toEqual([false, false]);
    expect(details).toEqual([]);
    // …and the next collapse starts collapsed rather than pre-expanded.
    resizeTo(500, 100);
    expect(hiddenStates()).toEqual([true, true]);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("dispatches toggle with the expanded flag", async () => {
    await start();
    resizeTo(500, 100);
    const details: Array<{ expanded: boolean }> = [];
    root().addEventListener("stimeo--breadcrumb:toggle", (event) => {
      details.push((event as CustomEvent).detail);
    });
    trigger().click();
    trigger().click();
    expect(details).toEqual([{ expanded: true }, { expanded: false }]);
  });

  describe("focus safety", () => {
    it("moves focus to the disclosure when the collapse hides the focused item", async () => {
      await start(markup, { scrollWidth: 80, clientWidth: 500 });
      const link = collapsibles()[0]?.querySelector("a") as HTMLAnchorElement;
      link.focus();
      expect(document.activeElement).toBe(link);

      resizeTo(500, 100); // collapses, hiding the focused item

      expect(hiddenStates()).toEqual([true, true]);
      expect(document.activeElement).toBe(trigger());
    });

    it("keeps a focused ellipsis visible until it loses focus", async () => {
      await start(markup, { scrollWidth: 500, clientWidth: 100 });
      trigger().focus();
      expect(document.activeElement).toBe(trigger());

      resizeTo(80, 500); // fits again — the ellipsis would normally hide

      expect(ellipsis().hidden).toBe(false);
      expect(document.activeElement).toBe(trigger());
      expect(hiddenStates()).toEqual([false, false]);

      trigger().blur();

      expect(ellipsis().hidden).toBe(true);
    });

    it("releases the deferred hide listener on disconnect", async () => {
      await start(markup, { scrollWidth: 500, clientWidth: 100 });
      trigger().focus();
      resizeTo(80, 500);
      expect(ellipsis().hidden).toBe(false);

      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--breadcrumb",
      );
      controller?.disconnect();
      trigger().blur();

      expect(ellipsis().hidden).toBe(false); // no post-disconnect mutation
    });
  });

  describe("reconnect / Turbo cache restore", () => {
    it("keeps the expanded trail the DOM restores", async () => {
      // A cached snapshot of a trail the user had expanded: aria-expanded="true"
      // and the middle items visible. The DOM is the source of truth.
      await start(buildMarkup({ expanded: true }), { scrollWidth: 500, clientWidth: 100 });

      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(hiddenStates()).toEqual([false, false]);
      expect(ellipsis().hidden).toBe(false);
    });

    it("re-reads the expanded state when a new instance connects to the same DOM", async () => {
      await start(markup, { scrollWidth: 500, clientWidth: 100 });
      trigger().click(); // expanded, written to the DOM
      expect(trigger().getAttribute("aria-expanded")).toBe("true");

      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--breadcrumb",
      );
      controller?.disconnect();
      controller?.connect(); // fresh lifecycle over the very same DOM

      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(hiddenStates()).toEqual([false, false]);
    });
  });

  describe("edge cases", () => {
    it("never offers the disclosure when there is nothing to collapse", async () => {
      await start(buildMarkup({ collapsible: false }), { scrollWidth: 500, clientWidth: 100 });

      expect(collapsibles()).toEqual([]);
      expect(ellipsis().hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");

      trigger().click(); // a disclosure controlling nothing must stay inert
      expect(ellipsis().hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("stays inert without a list target", async () => {
      await start(buildMarkup({ list: false }));
      // Nothing to measure: the resize notification must be a safe no-op.
      expect(() => window.dispatchEvent(new Event("resize"))).not.toThrow();
      expect(hiddenStates()).toEqual([false, false]);
      expect(ellipsis().hidden).toBe(true);
    });

    // Fail-safe: collapsing needs a way back. Without the full disclosure set
    // (ellipsis + trigger) hiding the middle items would strand them with no
    // control that can reveal them, so the trail degrades to a plain APG
    // breadcrumb — every item visible — instead of losing information.
    it("shows every item when both ellipsis and trigger are missing", async () => {
      await start(buildMarkup({ ellipsis: false, trigger: false }), {
        scrollWidth: 500,
        clientWidth: 100,
      });
      expect(hiddenStates()).toEqual([false, false]);
    });

    it("shows every item when only the trigger is missing (bare ellipsis)", async () => {
      await start(buildMarkup({ trigger: false }), { scrollWidth: 500, clientWidth: 100 });
      expect(hiddenStates()).toEqual([false, false]);
      // The ellipsis is decoration without a trigger to operate it, so it hides.
      expect(ellipsis().hidden).toBe(true);
    });

    // `buildMarkup` nests the trigger inside the ellipsis item, so the
    // trigger-without-ellipsis half needs its own markup. The contract does not
    // require that nesting — a trail may place the button anywhere in the list.
    const triggerWithoutEllipsis = `
      <nav data-controller="stimeo--breadcrumb" aria-label="Breadcrumb">
        <ol data-stimeo--breadcrumb-target="list">
          <li><a href="/">Home</a></li>
          <li><button type="button" aria-expanded="false" aria-label="Show full path"
                      data-stimeo--breadcrumb-target="trigger"
                      data-action="click->stimeo--breadcrumb#toggle">…</button></li>
          <li id="bc-a" data-stimeo--breadcrumb-target="collapsible"><a href="/a">Section A</a></li>
          <li id="bc-b" data-stimeo--breadcrumb-target="collapsible"><a href="/a/b">Sub B</a></li>
          <li><a href="/a/b/c" aria-current="page">Item C</a></li>
        </ol>
      </nav>`;

    it("shows every item when only the ellipsis is missing", async () => {
      await start(triggerWithoutEllipsis, { scrollWidth: 500, clientWidth: 100 });
      expect(hiddenStates()).toEqual([false, false]);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("keeps toggle inert while the disclosure set is incomplete", async () => {
      // The trigger exists but the ellipsis does not: `toggle` must not flip
      // state or dispatch, or the trail would collapse with no way back.
      await start(triggerWithoutEllipsis, { scrollWidth: 500, clientWidth: 100 });
      const events: unknown[] = [];
      root().addEventListener("stimeo--breadcrumb:toggle", (e) => events.push(e));

      trigger().click();

      expect(events).toEqual([]);
      expect(hiddenStates()).toEqual([false, false]);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("restores every item when the trigger leaves while collapsed", async () => {
      // The disclosure set can break up at runtime (Turbo Stream swap, morph).
      // Losing the only control that reveals the items must release them, not
      // leave them hidden behind a control that no longer exists.
      await start(buildMarkup(), { scrollWidth: 500, clientWidth: 100 });
      expect(hiddenStates()).toEqual([true, true]);

      trigger().remove();
      await tick();

      expect(hiddenStates()).toEqual([false, false]);
      expect(ellipsis().hidden).toBe(true);
    });

    it("collapses once a late-arriving trigger completes the disclosure", async () => {
      // The mirror case: markup that starts incomplete must pick up the normal
      // collapsing behavior as soon as the missing target shows up.
      await start(buildMarkup({ trigger: false }), { scrollWidth: 500, clientWidth: 100 });
      expect(hiddenStates()).toEqual([false, false]);

      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-stimeo--breadcrumb-target", "trigger");
      ellipsis().append(button);
      await tick();

      expect(hiddenStates()).toEqual([true, true]);
      expect(ellipsis().hidden).toBe(false);
      expect(button.getAttribute("aria-expanded")).toBe("false");
    });

    it("keeps two trails on the same page independent", async () => {
      await start(`${buildMarkup({ id: "one" })}${buildMarkup({ id: "two" })}`);
      const [first, second] = Array.from(
        document.querySelectorAll<HTMLElement>("[data-controller='stimeo--breadcrumb']"),
      ) as [HTMLElement, HTMLElement];
      const a = queries(first);
      const b = queries(second);

      stubGeometry(a.list(), { scrollWidth: 500, clientWidth: 100 });
      stubGeometry(b.list(), { scrollWidth: 80, clientWidth: 500 });
      window.dispatchEvent(new Event("resize"));

      expect(a.hiddenStates()).toEqual([true, true]);
      expect(a.ellipsis().hidden).toBe(false);
      expect(b.hiddenStates()).toEqual([false, false]);
      expect(b.ellipsis().hidden).toBe(true);

      a.trigger().click();
      expect(a.hiddenStates()).toEqual([false, false]);
      expect(b.trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("collapses an item added to the trail at runtime", async () => {
      await start(markup, { scrollWidth: 500, clientWidth: 100 });
      expect(hiddenStates()).toEqual([true, true]);

      const added = document.createElement("li");
      added.id = "bc-c";
      added.setAttribute("data-stimeo--breadcrumb-target", "collapsible");
      added.innerHTML = '<a href="/a/b/c2">Added</a>';
      list().appendChild(added);
      await tick();

      expect(hiddenStates()).toEqual([true, true, true]);
    });

    it("reveals an item that stops being a collapsible target while collapsed", async () => {
      await start(markup, { scrollWidth: 500, clientWidth: 100 });
      const [first] = collapsibles() as [HTMLElement];
      expect(first.hidden).toBe(true);

      // Dropping the marker takes the item out of the managed set. Nothing else
      // walks it afterwards, so the `hidden` this controller owns has to come off
      // here or the item is stranded invisible for the rest of the connection.
      first.removeAttribute("data-stimeo--breadcrumb-target");
      await tick();

      expect(first.hidden).toBe(false);
      expect(hiddenStates()).toEqual([true]); // the remaining target still collapses
    });

    it("re-measures after the last collapsible target leaves", async () => {
      // One collapsible only: once its marker is gone there is nothing left to collapse,
      // so the disclosure must retire. Reaching that state *requires* re-measuring —
      // dropping the re-measure leaves the ellipsis on screen controlling nothing.
      await start(
        `<nav data-controller="stimeo--breadcrumb" aria-label="Breadcrumb">
          <ol data-stimeo--breadcrumb-target="list">
            <li><a href="/">Home</a></li>
            <li data-stimeo--breadcrumb-target="ellipsis" hidden>
              <button type="button" aria-expanded="false" aria-controls="solo"
                      aria-label="Show full path" data-stimeo--breadcrumb-target="trigger"
                      data-action="click->stimeo--breadcrumb#toggle">…</button>
            </li>
            <li id="solo" data-stimeo--breadcrumb-target="collapsible"><a href="/a">Only</a></li>
            <li><a href="/a/b" aria-current="page">Item</a></li>
          </ol>
        </nav>`,
        undefined,
        (element) => stubLiveGeometry(element, 250),
      );
      const only = document.querySelector<HTMLElement>("#solo") as HTMLElement;
      expect(only.hidden).toBe(true);
      expect(ellipsis().hidden).toBe(false);

      only.removeAttribute("data-stimeo--breadcrumb-target");
      await tick();

      expect(only.hidden).toBe(false);
      expect(ellipsis().hidden).toBe(true);
    });

    it("reveals the departing item before re-measuring, not after", async () => {
      // The width the re-measure sees has to include the item just handed back. Measuring
      // first and revealing afterwards reads a trail that is one item too narrow: here it
      // reports "fits" (300 ≤ 350) and retires the disclosure, while the rendered trail is
      // really 400 wide and still needs it.
      await start(markup, undefined, (element) => stubLiveGeometry(element, 350));
      const [first] = collapsibles() as [HTMLElement];
      expect(hiddenStates()).toEqual([true, true]);

      first.removeAttribute("data-stimeo--breadcrumb-target");
      await tick();

      expect(first.hidden).toBe(false);
      expect(hiddenStates()).toEqual([true]); // the surviving target stays collapsed
      expect(ellipsis().hidden).toBe(false);
    });

    it("leaves a former collapsible item visible through later collapses", async () => {
      await start(markup, { scrollWidth: 500, clientWidth: 100 });
      const [first] = collapsibles() as [HTMLElement];
      first.removeAttribute("data-stimeo--breadcrumb-target");
      await tick();

      resizeTo(80, 500); // fits — everything visible
      resizeTo(500, 100); // overflows again — only the surviving target may hide
      expect(first.hidden).toBe(false);
      expect(hiddenStates()).toEqual([true]);
    });

    it("re-measures when only the text changes (same box, wider content)", async () => {
      await start(markup, { scrollWidth: 80, clientWidth: 500 });
      expect(hiddenStates()).toEqual([false, false]);

      // The list box is unchanged (no resize fires) — only its text got longer.
      stubGeometry(list(), { scrollWidth: 900, clientWidth: 500 });
      const link = collapsibles()[0]?.querySelector("a") as HTMLAnchorElement;
      link.textContent = "A considerably longer section label";
      await tick();

      expect(hiddenStates()).toEqual([true, true]);
      expect(ellipsis().hidden).toBe(false);
    });

    it("re-measures on demand via the update action", async () => {
      await start(markup, { scrollWidth: 80, clientWidth: 500 });
      expect(hiddenStates()).toEqual([false, false]);

      stubGeometry(list(), { scrollWidth: 900, clientWidth: 500 });
      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--breadcrumb",
      ) as BreadcrumbController;
      controller.update();

      expect(hiddenStates()).toEqual([true, true]);
    });
  });

  describe("teardown", () => {
    it("stops reacting to resizes after disconnect", async () => {
      await start();
      resizeTo(80, 500); // fits
      // Invoke disconnect() directly to avoid happy-dom's flaky async controller
      // teardown lifecycle.
      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--breadcrumb",
      );
      controller?.disconnect();
      resizeTo(500, 100); // would collapse if still observing
      expect(hiddenStates()).toEqual([false, false]);
    });

    it("stops reacting to list mutations after disconnect", async () => {
      await start(markup, { scrollWidth: 80, clientWidth: 500 });
      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--breadcrumb",
      );
      controller?.disconnect();

      stubGeometry(list(), { scrollWidth: 900, clientWidth: 500 });
      const link = collapsibles()[0]?.querySelector("a") as HTMLAnchorElement;
      link.textContent = "A considerably longer section label";
      await tick();

      expect(hiddenStates()).toEqual([false, false]);
    });

    it("observes the list element and releases the observer on disconnect", async () => {
      originalResizeObserver = globalThis.ResizeObserver;
      globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof globalThis.ResizeObserver;
      await start(markup, { scrollWidth: 80, clientWidth: 500 });

      const observer = FakeResizeObserver.instances[0];
      expect(observer?.observed.has(list())).toBe(true);

      // The element-resize path really drives a re-measure (not only `window`).
      stubGeometry(list(), { scrollWidth: 900, clientWidth: 500 });
      observer?.trigger();
      expect(hiddenStates()).toEqual([true, true]);

      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--breadcrumb",
      );
      controller?.disconnect();
      expect(observer?.disconnected).toBe(true);
    });

    it("unbinds the disclosure action after the controller is unloaded", async () => {
      await start(markup, { scrollWidth: 500, clientWidth: 100 });
      expect(hiddenStates()).toEqual([true, true]);

      application.unload("stimeo--breadcrumb");
      await tick();

      trigger().click();
      expect(hiddenStates()).toEqual([true, true]);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });
  });

  describe("accessibility", () => {
    it("announces the breadcrumb landmark and trail", async () => {
      await start();
      resizeTo(80, 500);
      const phrases = await captureSpeech({ container: root(), steps: 3 });
      // Freeze the whole ordered array (not a name-only `toContain`) so a lost role,
      // dropped position, or reordering surfaces as a diff.
      expect(phrases).toEqual([
        "navigation, Breadcrumb",
        "list",
        "listitem, level 1, position 1, set size 4",
        "link, Home",
      ]);
    });

    it("announces the disclosure and the shortened trail while collapsed", async () => {
      await start();
      resizeTo(500, 100);
      const phrases = await captureSpeech({ container: root(), steps: 6 });
      // The hidden middle items leave the tree (set size drops to 3) and the
      // disclosure announces its collapsed state and how many items it controls.
      expect(phrases).toEqual([
        "navigation, Breadcrumb",
        "list",
        "listitem, level 1, position 1, set size 3",
        "link, Home",
        "end of listitem, level 1, position 1, set size 3",
        "listitem, level 1, position 2, set size 3",
        "button, Show full path, 2 controls, not expanded",
      ]);
    });

    it("announces the expanded trail after the disclosure is pressed", async () => {
      await start();
      resizeTo(500, 100);
      trigger().click();
      const phrases = await captureSpeech({ container: root(), steps: 6 });
      // Every item is back in the tree (set size 5) and the disclosure flips to
      // "expanded" while staying available as the re-collapse control.
      expect(phrases).toEqual([
        "navigation, Breadcrumb",
        "list",
        "listitem, level 1, position 1, set size 5",
        "link, Home",
        "end of listitem, level 1, position 1, set size 5",
        "listitem, level 1, position 2, set size 5",
        "button, Show full path, 2 controls, expanded",
      ]);
    });

    it("has no machine-detectable a11y violations", async () => {
      await start();
      resizeTo(80, 500);
      await expectNoA11yViolations(root());
    });

    it("has no machine-detectable a11y violations while collapsed", async () => {
      await start();
      resizeTo(500, 100);
      await expectNoA11yViolations(root());
    });

    it("has no machine-detectable a11y violations while expanded", async () => {
      await start();
      resizeTo(500, 100);
      trigger().click();
      await expectNoA11yViolations(root());
    });
  });
});
