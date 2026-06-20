import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { MasonryController } from "../src/controllers/masonry_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link MasonryController}: responsive column count derived
 * from container width, shortest-column assignment exposed via `data-column`, the
 * `--stimeo-masonry-columns` custom property, the `layout` event, and — crucially
 * — that DOM (reading/focus) order is never reordered (WCAG 1.3.2).
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Stubs an element's box so column math runs without a real layout engine. */
const stubWidth = (element: HTMLElement, width: number) => {
  element.getBoundingClientRect = () =>
    ({
      width,
      height: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
};

const markup = (count: number, attrs = "") => `
  <div data-controller="stimeo--masonry" ${attrs}>
    ${Array.from({ length: count }, (_, i) => `<div data-stimeo--masonry-target="item">Card ${i + 1}</div>`).join("")}
  </div>`;

describe("MasonryController", () => {
  let application: Application;

  const start = async (count: number, width = 0, attrs = "") => {
    document.body.innerHTML = markup(count, attrs);
    if (width > 0) stubWidth(root(), width);
    application = Application.start();
    application.register("stimeo--masonry", MasonryController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--masonry']") as HTMLElement;
  const items = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--masonry-target='item']"));
  const columns = () => root().style.getPropertyValue("--stimeo-masonry-columns");

  it("falls back to a single column when the width is unmeasurable", async () => {
    await start(3);
    expect(columns()).toBe("1");
    expect(items().map((item) => item.getAttribute("data-column"))).toEqual(["0", "0", "0"]);
  });

  it("derives the column count from width, minColumnWidth, and gap", async () => {
    // floor((800 + 16) / (240 + 16)) = floor(3.18…) = 3 columns.
    await start(6, 800);
    expect(columns()).toBe("3");
  });

  it("assigns each item to the shortest column (round-robin at equal heights)", async () => {
    await start(6, 800);
    expect(items().map((item) => item.getAttribute("data-column"))).toEqual([
      "0",
      "1",
      "2",
      "0",
      "1",
      "2",
    ]);
  });

  it("re-packs when a descendant resource finishes loading", async () => {
    await start(3, 600); // 2 columns
    // Every item reports height 0 at first, so packing is plain round-robin.
    expect(items().map((item) => item.getAttribute("data-column"))).toEqual(["0", "1", "0"]);

    // The first card grows once its image loads; the capture-phase `load` listener
    // must re-pack so the third card avoids the now-tall first column. A bare `load`
    // dispatched on the item reaches the root's capture listener without mutating
    // the DOM (so the MutationObserver is not what re-packs here).
    const tall = items()[0] as HTMLElement;
    tall.getBoundingClientRect = () =>
      ({
        width: 0,
        height: 200,
        left: 0,
        top: 0,
        right: 0,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    tall.dispatchEvent(new Event("load"));

    expect(items().map((item) => item.getAttribute("data-column"))).toEqual(["0", "1", "1"]);
  });

  it("honors a custom minColumnWidth", async () => {
    // floor((800 + 16) / (400 + 16)) = floor(1.96…) = 1 column.
    await start(4, 800, 'data-stimeo--masonry-min-column-width-value="400"');
    expect(columns()).toBe("1");
    expect(items().every((item) => item.getAttribute("data-column") === "0")).toBe(true);
  });

  it("stops observing on disconnect (no relayout after teardown)", async () => {
    await start(3, 800);
    // Invoke disconnect() directly (as the spinner teardown test does) rather than
    // relying on application.stop()'s async MutationObserver flush.
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--masonry",
    ) as MasonryController;
    controller.disconnect();
    const extra = document.createElement("div");
    extra.setAttribute("data-stimeo--masonry-target", "item");
    root().appendChild(extra);
    await tick();
    // A childList mutation would relayout (assign data-column) while connected;
    // after teardown the observer is gone, so the new item is left untouched.
    expect(extra.hasAttribute("data-column")).toBe(false);
  });

  it("emits a layout event with the column count when it changes", async () => {
    document.body.innerHTML = markup(3);
    stubWidth(root(), 800);
    const detail: number[] = [];
    root().addEventListener("stimeo--masonry:layout", (event) => {
      detail.push((event as CustomEvent<{ columns: number }>).detail.columns);
    });
    application = Application.start();
    application.register("stimeo--masonry", MasonryController);
    await tick();
    expect(detail).toEqual([3]);
  });

  it("preserves DOM order regardless of column assignment", async () => {
    await start(4, 800);
    expect(items().map((item) => item.textContent)).toEqual([
      "Card 1",
      "Card 2",
      "Card 3",
      "Card 4",
    ]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(3, 800);
    await expectNoA11yViolations(root());
  });

  // Layer ③ — the layout helper must not inject semantics: a screen reader still
  // reads the items in DOM order, so visual packing never desyncs reading order.
  it("announces the items in DOM order (no reordering of semantics)", async () => {
    await start(3, 800);
    const phrases = await captureSpeech({ container: root(), steps: 2 });
    expect(phrases).toEqual(["Card 1", "Card 2", "Card 3"]);
  });
});
