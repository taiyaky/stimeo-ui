import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { MasonryController } from "../src/controllers/masonry_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link MasonryController}: responsive column count derived
 * from container width, shortest-column assignment exposed via `data-column`, the
 * `--stimeo--masonry-columns` custom property, the `layout` event, and — crucially
 * — that DOM (reading/focus) order is never reordered (WCAG 1.3.2).
 */

/** Stubs an element's box so column math runs without a real layout engine. */
const stubWidth = (element: HTMLElement, width: number) => {
  element.getBoundingClientRect = () => new DOMRect(0, 0, width, 0);
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
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--masonry']") as HTMLElement;
  const items = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--masonry-target='item']"));
  const columns = () => root().style.getPropertyValue("--stimeo--masonry-columns");

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
    // the DOM (so the MutationObserver is not what re-packs here). The pass is
    // folded into a microtask, so awaiting one is enough — and awaiting only one
    // is what pins that contract.
    const tall = items()[0] as HTMLElement;
    tall.getBoundingClientRect = () => new DOMRect(0, 0, 0, 200);
    tall.dispatchEvent(new Event("load"));
    await flushMicrotasks();

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
    // Invoke disconnect() directly rather than racing the document MutationObserver
    // that normally drives context teardown.
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

  // The layout helper must not inject semantics: a screen reader still reads the
  // items in DOM order, so visual packing never desyncs reading order.
  it("announces the items in DOM order (no reordering of semantics)", async () => {
    await start(3, 800);
    const phrases = await captureSpeech({ container: root(), steps: 2 });
    expect(phrases).toEqual(["Card 1", "Card 2", "Card 3"]);
  });
  describe("declarations that cannot be read as numbers", () => {
    // A unit suffix is the ordinary typo here, and Stimulus' Number reader turns
    // it into NaN rather than raising. Every fixture below picks a numeric prefix
    // that differs from the default, so "fell back to the default" is
    // distinguishable from "parsed the prefix".

    it("falls back to the default column width", async () => {
      // 400 would give one column; the default 240 gives three.
      await start(6, 800, 'data-stimeo--masonry-min-column-width-value="400px"');
      expect(columns()).toBe("3");
      expect(items().every((item) => item.hasAttribute("data-column"))).toBe(true);
    });

    it("falls back to the default gap", async () => {
      // At 750px a gap of 0 would give three columns; the default 16 gives two.
      await start(3, 750, 'data-stimeo--masonry-gap-value="0px"');
      expect(columns()).toBe("2");
    });

    it("falls back when a value is not finite", async () => {
      // An infinite gap makes both sides of the division infinite, so the count
      // would be NaN and the column bookkeeping could not be allocated.
      await start(3, 800, 'data-stimeo--masonry-gap-value="Infinity"');
      expect(columns()).toBe("3");
      expect(items().every((item) => item.hasAttribute("data-column"))).toBe(true);
    });
  });
  describe("following runtime changes", () => {
    it("re-lays out when the column width declaration changes", async () => {
      await start(6, 800);
      expect(columns()).toBe("3");

      root().setAttribute("data-stimeo--masonry-min-column-width-value", "400");
      await tick();

      expect(columns()).toBe("1");
    });

    it("re-lays out when the gap declaration changes", async () => {
      await start(3, 750);
      expect(columns()).toBe("2");

      root().setAttribute("data-stimeo--masonry-gap-value", "0");
      await tick();

      expect(columns()).toBe("3");
    });

    it("packs an element that becomes an item without moving in the DOM", async () => {
      // A morph that only syncs attributes produces no child-list change, so the
      // element has to be noticed as a target rather than as a new node.
      await start(2, 800);
      const late = document.createElement("div");
      late.textContent = "Late";
      root().appendChild(late);
      await tick();

      late.setAttribute("data-stimeo--masonry-target", "item");
      await tick();

      expect(late.getAttribute("data-column")).toBe("2");
    });

    it("reclaims the column hook from an element that stops being an item", async () => {
      await start(3, 800);
      const dropped = items()[1] as HTMLElement;
      expect(dropped.hasAttribute("data-column")).toBe(true);

      dropped.removeAttribute("data-stimeo--masonry-target");
      await tick();

      expect(dropped.hasAttribute("data-column")).toBe(false);
    });
  });

  describe("hot-path work", () => {
    /** Counts how many times the container's box is measured. */
    const countMeasurements = async (act: () => void) => {
      const element = root();
      const measure = element.getBoundingClientRect.bind(element);
      let calls = 0;
      element.getBoundingClientRect = () => {
        calls += 1;
        return measure();
      };
      act();
      await tick();
      return calls;
    };

    /** Records the `data-column` mutations inside the grid while `act` runs. */
    const countColumnWrites = async (act: () => void) => {
      let writes = 0;
      const observer = new MutationObserver((records) => {
        writes += records.length;
      });
      observer.observe(root(), {
        attributes: true,
        subtree: true,
        attributeFilter: ["data-column"],
      });
      act();
      await tick();
      observer.disconnect();
      return writes;
    };

    it("folds a burst of resizes into a single pass", async () => {
      await start(6, 800);

      const measurements = await countMeasurements(() => {
        for (let i = 0; i < 20; i += 1) window.dispatchEvent(new Event("resize"));
      });

      expect(measurements).toBe(1);
    });

    it("writes only the assignments that actually change", async () => {
      await start(6, 800);

      const writes = await countColumnWrites(() => {
        window.dispatchEvent(new Event("resize"));
      });

      // Nothing about the box changed, so the pass has nothing to publish.
      expect(writes).toBe(0);
    });

    it("stays silent when items leave and rejoin the target set in one batch", async () => {
      await start(3, 800);
      const fired: number[] = [];
      root().addEventListener("stimeo--masonry:layout", (event) => {
        fired.push((event as CustomEvent<{ columns: number }>).detail.columns);
      });

      const container = root();
      const writes = await countColumnWrites(() => {
        // Re-appending the same elements in the same order reports every item as
        // disconnected and then connected again, so the reclaim queue holds items
        // that are still owned. The packing it produces is identical, so nothing
        // may be stripped, rewritten, or published.
        for (const item of items()) container.appendChild(item);
      });

      expect(writes).toBe(0);
      expect(fired).toEqual([]);
      expect(items().map((item) => item.getAttribute("data-column"))).toEqual(["0", "1", "2"]);
    });

    it("emits layout for a re-pack that leaves the column count alone", async () => {
      await start(3, 800);
      const fired: number[] = [];
      root().addEventListener("stimeo--masonry:layout", (event) => {
        fired.push((event as CustomEvent<{ columns: number }>).detail.columns);
      });

      const extra = document.createElement("div");
      extra.setAttribute("data-stimeo--masonry-target", "item");
      root().appendChild(extra);
      await tick();

      expect(extra.getAttribute("data-column")).toBe("0");
      expect(fired).toEqual([3]);
    });
  });
  describe("the declared triggers, from both sides", () => {
    it("re-derives the column count when the container is resized", async () => {
      await start(6, 800);
      expect(columns()).toBe("3");

      stubWidth(root(), 500);
      window.dispatchEvent(new Event("resize"));
      await tick();

      // floor((500 + 16) / (240 + 16)) = floor(2.01…) = 2 columns.
      expect(columns()).toBe("2");
    });

    it("ignores a descendant load after disconnect", async () => {
      await start(3, 800);
      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--masonry",
      ) as MasonryController;
      controller.disconnect();

      stubWidth(root(), 300);
      (items()[0] as HTMLElement).dispatchEvent(new Event("load"));
      await tick();

      expect(columns()).toBe("3");
    });

    it("ignores a viewport resize after disconnect", async () => {
      await start(3, 800);
      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--masonry",
      ) as MasonryController;
      controller.disconnect();

      stubWidth(root(), 300);
      window.dispatchEvent(new Event("resize"));
      await tick();

      expect(columns()).toBe("3");
    });

    it("keeps the column hooks when the controller disconnects", async () => {
      // Teardown reports every target as disconnected, and the hooks have to
      // survive it: a Turbo snapshot is taken from the DOM the teardown leaves.
      await start(3, 800);
      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--masonry",
      ) as MasonryController;

      controller.disconnect();
      await tick();

      expect(items().every((item) => item.hasAttribute("data-column"))).toBe(true);
    });

    it("keeps one column when the declared width and gap leave nothing to divide by", async () => {
      // `0` is a number the reader accepts, so it reaches the arithmetic as a
      // zero divisor rather than as an unreadable declaration.
      await start(
        3,
        800,
        'data-stimeo--masonry-min-column-width-value="0" data-stimeo--masonry-gap-value="0"',
      );
      expect(columns()).toBe("1");
      expect(items().every((item) => item.getAttribute("data-column") === "0")).toBe(true);
    });

    it("counts the gap on both sides of the division", async () => {
      // 496px is a width where the two readings part: with the gap in the
      // numerator floor(512 / 256) = 2, without it floor(496 / 256) = 1.
      await start(4, 496);
      expect(columns()).toBe("2");
    });
  });
});
