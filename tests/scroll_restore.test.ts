import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScrollRestoreController } from "../src/controllers/scroll_restore_controller";
import { expectNoA11yViolations } from "./helpers/a11y";

/**
 * Behavioral tests for {@link ScrollRestoreController}: restore on connect,
 * rAF-coalesced save on scroll, `key`/`id` namespacing, per-axis tracking,
 * multi-instance isolation, and the synchronous flush + teardown on disconnect.
 *
 * `scroll` is dispatched to drive the rAF-coalesced save; happy-dom exposes
 * `sessionStorage`, element `scrollTop`/`scrollLeft`, and `requestAnimationFrame`.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// The controller persists inside a requestAnimationFrame; waiting one frame is
// deterministic (the persist callback was queued first, so it runs before this one)
// and avoids a fixed timeout that could be slow or race the rAF.
const settle = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

describe("ScrollRestoreController", () => {
  let application: Application;

  const start = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--scroll-restore", ScrollRestoreController);
    await tick();
  };

  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    application?.stop();
    document.body.innerHTML = "";
    sessionStorage.clear();
  });

  const box = (id = "box") => document.getElementById(id) as HTMLElement;
  const stored = (key: string) => {
    const raw = sessionStorage.getItem(`stimeo--scroll-restore:${key}`);
    return raw === null ? null : JSON.parse(raw);
  };

  const markup = (key = "sidebar") => `
    <div id="box" data-controller="stimeo--scroll-restore"
         data-stimeo--scroll-restore-key-value="${key}">content</div>`;

  it("restores the saved vertical position on connect", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:sidebar", JSON.stringify({ top: 240 }));
    await start(markup());
    expect(box().scrollTop).toBe(240);
  });

  it("saves the position on scroll (coalesced through rAF)", async () => {
    await start(markup());
    box().scrollTop = 180;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("sidebar")).toEqual({ top: 180 });
  });

  it("falls back to the element id when no key is set", async () => {
    await start(`<div id="list" data-controller="stimeo--scroll-restore">content</div>`);
    box("list").scrollTop = 90;
    box("list").dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("list")).toEqual({ top: 90 });
  });

  it("does nothing when there is neither a key nor an id", async () => {
    await start(`<div data-controller="stimeo--scroll-restore">content</div>`);
    const el = document.querySelector<HTMLElement>(
      "[data-controller='stimeo--scroll-restore']",
    ) as HTMLElement;
    el.scrollTop = 50;
    el.dispatchEvent(new Event("scroll"));
    await settle();
    expect(sessionStorage.length).toBe(0);
  });

  it("tracks only the horizontal axis when axis is 'horizontal'", async () => {
    await start(`
      <div id="box" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="row"
           data-stimeo--scroll-restore-axis-value="horizontal">content</div>`);
    box().scrollLeft = 320;
    box().scrollTop = 99;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("row")).toEqual({ left: 320 });
  });

  it("restores only the configured axis, ignoring a stale field from another axis", async () => {
    // axis defaults to vertical; a stored `left` (e.g. after switching axis) must
    // not be applied to scrollLeft.
    sessionStorage.setItem("stimeo--scroll-restore:sidebar", JSON.stringify({ top: 70, left: 90 }));
    await start(markup());
    expect(box().scrollTop).toBe(70);
    expect(box().scrollLeft).toBe(0);
  });

  it("tracks and restores both axes when axis is 'both'", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:pane", JSON.stringify({ top: 12, left: 34 }));
    await start(`
      <div id="box" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="pane"
           data-stimeo--scroll-restore-axis-value="both">content</div>`);
    expect(box().scrollTop).toBe(12);
    expect(box().scrollLeft).toBe(34);
  });

  it("keeps multiple instances isolated by key", async () => {
    await start(`
      <div id="a" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="a">a</div>
      <div id="b" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="b">b</div>`);
    box("a").scrollTop = 100;
    box("a").dispatchEvent(new Event("scroll"));
    box("b").scrollTop = 200;
    box("b").dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("a")).toEqual({ top: 100 });
    expect(stored("b")).toEqual({ top: 200 });
  });

  it("flushes the last captured position synchronously on disconnect", async () => {
    await start(markup());
    const controller = application.getControllerForElementAndIdentifier(
      box(),
      "stimeo--scroll-restore",
    );
    box().scrollTop = 410;
    box().dispatchEvent(new Event("scroll")); // captured into cache; rAF still pending
    controller?.disconnect(); // flush before the rAF fires
    expect(stored("sidebar")).toEqual({ top: 410 });
  });

  it("does not overwrite the saved position with 0 when the element reads 0 at teardown", async () => {
    // Reproduces the Turbo regression: Turbo detaches the node before disconnect,
    // so a fresh scrollTop read is 0. The flush must persist the captured value.
    await start(markup());
    box().scrollTop = 260;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("sidebar")).toEqual({ top: 260 });

    const controller = application.getControllerForElementAndIdentifier(
      box(),
      "stimeo--scroll-restore",
    );
    box().scrollTop = 0; // simulate the detached element reporting 0 (no scroll event)
    controller?.disconnect();
    expect(stored("sidebar")).toEqual({ top: 260 });
  });

  it("stops saving after disconnect", async () => {
    await start(markup());
    const controller = application.getControllerForElementAndIdentifier(
      box(),
      "stimeo--scroll-restore",
    );
    controller?.disconnect();
    sessionStorage.clear();
    box().scrollTop = 999;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("sidebar")).toBeNull();
  });

  it("ignores malformed stored data without throwing", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:sidebar", "not json");
    await start(markup());
    expect(box().scrollTop).toBe(0);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(markup());
    await expectNoA11yViolations(box());
  });
});
