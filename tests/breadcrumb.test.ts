import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { BreadcrumbController } from "../src/controllers/breadcrumb_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link BreadcrumbController}: overflow-driven collapsing
 * of the author-marked middle items, the disclosure toggle (`aria-expanded` +
 * `hidden`), reset-on-fit, the `toggle` event, and resize teardown.
 *
 * happy-dom has no layout engine, so `scrollWidth`/`clientWidth` are stubbed to
 * drive the overflow condition deterministically.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = `
  <nav data-controller="stimeo--breadcrumb" aria-label="Breadcrumb">
    <ol data-stimeo--breadcrumb-target="list">
      <li><a href="/">Home</a></li>
      <li data-stimeo--breadcrumb-target="ellipsis" hidden>
        <button type="button" aria-expanded="false" aria-controls="bc-collapsed"
                aria-label="Show full path"
                data-stimeo--breadcrumb-target="trigger"
                data-action="stimeo--breadcrumb#toggle">…</button>
      </li>
      <li id="bc-collapsed" data-stimeo--breadcrumb-target="collapsible"><a href="/a">Section A</a></li>
      <li data-stimeo--breadcrumb-target="collapsible"><a href="/a/b">Sub B</a></li>
      <li><a href="/a/b/c" aria-current="page">Item C</a></li>
    </ol>
  </nav>`;

describe("BreadcrumbController", () => {
  let application: Application;

  const start = async () => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--breadcrumb", BreadcrumbController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--breadcrumb']") as HTMLElement;
  const list = () =>
    document.querySelector<HTMLElement>("[data-stimeo--breadcrumb-target='list']") as HTMLElement;
  const ellipsis = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--breadcrumb-target='ellipsis']",
    ) as HTMLElement;
  const trigger = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--breadcrumb-target='trigger']",
    ) as HTMLElement;
  const collapsibles = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--breadcrumb-target='collapsible']"),
    );
  const hiddenStates = () => collapsibles().map((item) => item.hidden);

  /**
   * Stubs the geometry that drives overflow and notifies via a viewport resize.
   * Both widths live on the **list** element (not the host `nav`) so the overflow
   * check stays independent of any host padding.
   */
  const resizeTo = (scrollWidth: number, clientWidth: number) => {
    Object.defineProperty(list(), "scrollWidth", { configurable: true, value: scrollWidth });
    Object.defineProperty(list(), "clientWidth", { configurable: true, value: clientWidth });
    window.dispatchEvent(new Event("resize"));
  };

  it("shows the full trail when it fits", async () => {
    await start();
    resizeTo(80, 500);
    expect(hiddenStates()).toEqual([false, false]);
    expect(ellipsis().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses the middle items and shows the ellipsis when overflowing", async () => {
    await start();
    resizeTo(500, 100);
    expect(hiddenStates()).toEqual([true, true]);
    expect(ellipsis().hidden).toBe(false);
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

  it("resets the expanded state when the trail fits again", async () => {
    await start();
    resizeTo(500, 100);
    trigger().click(); // expanded
    resizeTo(80, 500); // now fits
    expect(hiddenStates()).toEqual([false, false]);
    expect(ellipsis().hidden).toBe(true);
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

  it("stops reacting to resizes after disconnect", async () => {
    await start();
    resizeTo(80, 500); // fits
    // Invoke disconnect() directly to avoid happy-dom's flaky async controller
    // teardown lifecycle (mirrors the combobox/scrollspy suites).
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--breadcrumb",
    );
    controller?.disconnect();
    resizeTo(500, 100); // would collapse if still observing
    expect(hiddenStates()).toEqual([false, false]);
  });

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

  it("has no machine-detectable a11y violations", async () => {
    await start();
    resizeTo(80, 500);
    await expectNoA11yViolations(root());
  });
});
