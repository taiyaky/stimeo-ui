import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PointerDragController } from "../src/controllers/pointer_drag_controller";
import { RovingController } from "../src/controllers/roving_controller";
import { SortableController } from "../src/controllers/sortable_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { delay, flushMicrotasks } from "./helpers/timing";

/**
 * Behavioral tests for {@link SortableController} driven through the real
 * composition (`stimeo--pointer-drag` on the items, `stimeo--roving` on the
 * list): keyboard grab → step → drop/cancel with live-region announcements,
 * pointer midpoint-crossing reorder (stubbed geometry — the branch logic; the
 * measurement truth stays a real-browser concern), the `reorder` event, the
 * roving yield while grabbed, and Turbo teardown/reconnect resilience.
 */

type ReorderDetail = { item: HTMLElement; from: number; to: number };

describe("SortableController", () => {
  let application: Application;

  const fixture = `
    <main>
      <div id="root" data-controller="stimeo--sortable">
        <ul data-stimeo--sortable-target="list" data-controller="stimeo--roving" aria-label="Cards">
          <li id="i1" data-stimeo--sortable-target="item" data-stimeo--sortable-name="Card A"
              data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-axis-value="y">
            <span>Card A</span>
            <button type="button" aria-label="Reorder Card A"
                    data-stimeo--pointer-drag-target="handle"
                    data-stimeo--roving-target="item">⠿</button>
          </li>
          <li id="i2" data-stimeo--sortable-target="item" data-stimeo--sortable-name="Card B"
              data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-axis-value="y">
            <span>Card B</span>
            <button type="button" aria-label="Reorder Card B"
                    data-stimeo--pointer-drag-target="handle"
                    data-stimeo--roving-target="item">⠿</button>
          </li>
          <li id="i3" data-stimeo--sortable-target="item" data-stimeo--sortable-name="Card C"
              data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-axis-value="y">
            <span>Card C</span>
            <button type="button" aria-label="Reorder Card C"
                    data-stimeo--pointer-drag-target="handle"
                    data-stimeo--roving-target="item">⠿</button>
          </li>
        </ul>
        <span role="status" aria-live="polite" data-stimeo--sortable-target="status"></span>
      </div>
    </main>`;

  /** Mounts the fixture with the full composition and records reorder events. */
  const mount = async (html = fixture): Promise<ReorderDetail[]> => {
    document.body.innerHTML = html;
    const reorders: ReorderDetail[] = [];
    document.body.addEventListener("stimeo--sortable:reorder", (event) => {
      reorders.push((event as CustomEvent<ReorderDetail>).detail);
    });
    application = Application.start();
    application.register("stimeo--sortable", SortableController);
    application.register("stimeo--pointer-drag", PointerDragController);
    application.register("stimeo--roving", RovingController);
    await delay(20);
    return reorders;
  };

  afterEach(async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    await delay(20);
  });

  const root = () => document.querySelector<HTMLElement>("#root") as HTMLElement;
  const status = () =>
    document.querySelector<HTMLElement>("[data-stimeo--sortable-target='status']") as HTMLElement;
  const order = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--sortable-target='item']")).map(
      (item) => item.id,
    );
  const handle = (id: string) =>
    document.querySelector<HTMLElement>(
      `#${id} [data-stimeo--pointer-drag-target='handle']`,
    ) as HTMLElement;
  const key = (id: string, k: string) =>
    handle(id).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  /**
   * Lays the items out along `axis` as consecutive `size`-px slots via stubbed
   * rects (happy-dom computes no layout). One implementation serves both
   * orientation suites so the two geometries cannot drift apart; the cross-axis
   * extent is arbitrary — midpoints are computed on the primary axis only.
   */
  const stubRects = (offsets: Record<string, number>, axis: "x" | "y", size: number) => {
    for (const [id, offset] of Object.entries(offsets)) {
      const item = document.querySelector<HTMLElement>(`#${id}`) as HTMLElement;
      vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
        axis === "x" ? new DOMRect(offset, 0, size, 30) : new DOMRect(0, offset, 100, size),
      );
    }
  };

  /** Dispatches a pointer event on `id`'s handle at `coord` along `axis`. */
  const pointerAt = (id: string, type: string, axis: "x" | "y", coord: number) =>
    handle(id).dispatchEvent(
      new PointerEvent(type, {
        clientX: axis === "x" ? coord : 10,
        clientY: axis === "y" ? coord : 10,
        pointerId: 1,
        bubbles: true,
      }),
    );

  describe("keyboard reorder (grab → arrows → drop)", () => {
    it("announces the grab with name, position, and total", async () => {
      await mount();
      key("i2", " ");
      expect(status().textContent).toBe("Grabbed Card B, position 2 of 3");
      expect(root().getAttribute("data-sortable-dragging")).toBe("true");
    });

    it("steps the item one position per arrow and announces each move", async () => {
      await mount();
      key("i2", " ");
      key("i2", "ArrowUp");
      expect(order()).toEqual(["i2", "i1", "i3"]);
      expect(status().textContent).toBe("Card B, position 1 of 3");

      key("i2", "ArrowDown");
      key("i2", "ArrowDown");
      expect(order()).toEqual(["i1", "i3", "i2"]);
      expect(status().textContent).toBe("Card B, position 3 of 3");
    });

    it("clamps at the ends", async () => {
      await mount();
      key("i1", " ");
      key("i1", "ArrowUp");
      expect(order()).toEqual(["i1", "i2", "i3"]);
    });

    it("dispatches reorder with zero-based from/to on drop", async () => {
      const reorders = await mount();
      key("i2", " ");
      key("i2", "ArrowUp");
      key("i2", " ");
      expect(reorders).toEqual([{ item: document.querySelector("#i2"), from: 1, to: 0 }]);
      expect(status().textContent).toBe("Dropped Card B at position 1 of 3");
      expect(root().hasAttribute("data-sortable-dragging")).toBe(false);
    });

    it("dispatches no reorder on a drop that returns to the pickup slot", async () => {
      const reorders = await mount();
      key("i2", " ");
      key("i2", "ArrowDown");
      key("i2", "ArrowUp");
      key("i2", " ");
      expect(order()).toEqual(["i1", "i2", "i3"]);
      // "Silent" is the reorder contract: no callback fires when the net
      // position is unchanged. The drop is still announced — a screen-reader
      // user must hear that they let go — so status is not frozen.
      expect(reorders).toHaveLength(0);
      expect(status().textContent).toBe("Dropped Card B at position 2 of 3");
    });

    it("restores the pickup position on Escape and announces the cancel", async () => {
      const reorders = await mount();
      key("i1", " ");
      key("i1", "ArrowDown");
      key("i1", "ArrowDown");
      expect(order()).toEqual(["i2", "i3", "i1"]);

      key("i1", "Escape");
      expect(order()).toEqual(["i1", "i2", "i3"]);
      expect(status().textContent).toBe("Reorder canceled, Card A returned to position 1 of 3");
      expect(reorders).toHaveLength(0);
      expect(root().hasAttribute("data-sortable-dragging")).toBe(false);
    });

    it("ignores cross-axis arrows (the items lock to the y axis)", async () => {
      await mount();
      key("i2", " ");
      key("i2", "ArrowRight");
      expect(order()).toEqual(["i1", "i2", "i3"]);
    });

    it("localizes announcements via data-* templates on the status element", async () => {
      await mount();
      status().setAttribute("data-grabbed", "%{name}を掴みました（%{total}件中%{position}件目）");
      key("i3", " ");
      expect(status().textContent).toBe("Card Cを掴みました（3件中3件目）");
    });

    it("replaces every occurrence of a repeated placeholder", async () => {
      await mount();
      // A locale string may repeat a placeholder (e.g. name for emphasis); each
      // occurrence must be substituted, not just the first.
      status().setAttribute("data-grabbed", "%{name}: %{name} grabbed");
      key("i3", " ");
      expect(status().textContent).toBe("Card C: Card C grabbed");
    });

    it("announces names containing $-sequences and placeholder tokens literally", async () => {
      await mount();
      // The name is author/content-derived: `$&` must not expand to the matched
      // pattern and a placeholder-shaped token inside it must not be
      // re-substituted — the live region reads exactly what the card says.
      document
        .querySelector("#i3")
        ?.setAttribute("data-stimeo--sortable-name", "Save $$ $& top %{total} plan");
      status().setAttribute("data-grabbed", "Grabbed %{name} (%{position}/%{total})");
      key("i3", " ");
      expect(status().textContent).toBe("Grabbed Save $$ $& top %{total} plan (3/3)");
    });

    it("keeps the roving tab stop on the grabbed handle (composition yield)", async () => {
      await mount();
      expect(handle("i1").tabIndex).toBe(0); // roving: first handle is the tab stop
      key("i1", " ");
      key("i1", "ArrowDown"); // consumed by pointer-drag; roving must not act
      expect(order()).toEqual(["i2", "i1", "i3"]);
      expect(handle("i1").tabIndex).toBe(0);
      expect(handle("i2").tabIndex).toBe(-1);
    });
  });

  describe("session exclusivity", () => {
    it("ignores a start from another item while a session is live", async () => {
      const reorders = await mount();
      key("i1", " "); // grab A
      key("i2", " "); // B's own pointer-drag grabs, but sortable must keep A's session
      key("i1", "ArrowDown");
      expect(order()).toEqual(["i2", "i1", "i3"]);
      key("i1", " "); // drop A
      expect(reorders).toEqual([{ item: document.querySelector("#i1"), from: 0, to: 1 }]);
    });
  });

  describe("horizontal orientation (dx is the primary axis)", () => {
    // The vertical fixture retargeted to the x axis: sortable orientation,
    // pointer-drag axis, and roving orientation all flip together.
    const horizontalFixture = fixture
      .replace(
        'data-controller="stimeo--sortable"',
        'data-controller="stimeo--sortable" data-stimeo--sortable-orientation-value="horizontal"',
      )
      .replace(
        'data-controller="stimeo--roving"',
        'data-controller="stimeo--roving" data-stimeo--roving-orientation-value="horizontal"',
      )
      .replaceAll(
        'data-stimeo--pointer-drag-axis-value="y"',
        'data-stimeo--pointer-drag-axis-value="x"',
      );

    it("steps along the x axis with Left/Right arrows and reports the reorder", async () => {
      const reorders = await mount(horizontalFixture);
      key("i1", " ");
      key("i1", "ArrowRight");
      expect(order()).toEqual(["i2", "i1", "i3"]);
      expect(status().textContent).toBe("Card A, position 2 of 3");

      key("i1", "ArrowRight");
      key("i1", " ");
      expect(order()).toEqual(["i2", "i3", "i1"]);
      expect(reorders).toEqual([{ item: document.querySelector("#i1"), from: 0, to: 2 }]);
    });

    it("ignores cross-axis (vertical) arrows when locked to x", async () => {
      await mount(horizontalFixture);
      key("i2", " ");
      key("i2", "ArrowDown");
      expect(order()).toEqual(["i1", "i2", "i3"]);
    });

    it("follows the pointer across sibling midpoints on the x axis", async () => {
      const reorders = await mount(horizontalFixture);
      // Lay the three items out horizontally (100px columns).
      stubRects({ i1: 0, i2: 100, i3: 200 }, "x", 100);
      const pointer = (id: string, type: string, x: number) => pointerAt(id, type, "x", x);
      pointer("i1", "pointerdown", 10);
      pointer("i1", "pointermove", 160); // past B's midpoint (150)
      expect(order()).toEqual(["i2", "i1", "i3"]);
      pointer("i1", "pointerup", 160);
      expect(reorders).toEqual([{ item: document.querySelector("#i1"), from: 0, to: 1 }]);
    });

    /**
     * RTL rows. `pointer-drag` reports physical coordinates and leaves RTL to its
     * consumer, and this is that consumer: DOM order runs right-to-left here, so
     * both drag paths have to be mapped back onto it. The list is laid out in
     * reverse — A occupies the rightmost 100px column.
     */
    describe("under dir=rtl", () => {
      /** The horizontal fixture with the row reversed. */
      const mountRtl = async () => {
        const reorders = await mount(horizontalFixture);
        // happy-dom does not resolve the `dir` attribute into the computed
        // style, so the direction is set the way the other RTL suites do it.
        (
          document.querySelector("[data-stimeo--sortable-target='list']") as HTMLElement
        ).style.direction = "rtl";
        return reorders;
      };

      it("steps the item toward the arrow it was pressed with", async () => {
        const reorders = await mountRtl();
        key("i1", " "); // grab A, the item at the right end of the row
        key("i1", "ArrowLeft"); // leftward on screen = later in DOM order
        expect(order()).toEqual(["i2", "i1", "i3"]);
        expect(status().textContent).toBe("Card A, position 2 of 3");

        key("i1", "ArrowRight"); // and back
        expect(order()).toEqual(["i1", "i2", "i3"]);
        key("i1", " ");
        expect(reorders).toEqual([]); // returned to the pickup slot: no reorder
      });

      it("clamps at the end the row actually starts from", async () => {
        // The guard the physical reading gets backwards: A is already first, so
        // ArrowRight (toward the row's start on screen) must not move it, while
        // the physical reading would clamp the opposite end instead.
        await mountRtl();
        key("i1", " ");
        key("i1", "ArrowRight");
        expect(order()).toEqual(["i1", "i2", "i3"]);
      });

      it("follows the pointer across sibling midpoints in reverse", async () => {
        const reorders = await mountRtl();
        // Reversed layout: A rightmost (200), B middle (100), C leftmost (0).
        stubRects({ i1: 200, i2: 100, i3: 0 }, "x", 100);
        const pointer = (id: string, type: string, x: number) => pointerAt(id, type, "x", x);
        pointer("i1", "pointerdown", 250);
        pointer("i1", "pointermove", 140); // past B's midpoint (150), moving left
        expect(order()).toEqual(["i2", "i1", "i3"]);

        // Carried to the far end, where the two readings part company: counting
        // physically here yields zero crossings and sends A back to the start.
        pointer("i1", "pointermove", 40); // past C's midpoint (50) as well
        expect(order()).toEqual(["i2", "i3", "i1"]);
        pointer("i1", "pointerup", 40);
        expect(reorders).toEqual([{ item: document.querySelector("#i1"), from: 0, to: 2 }]);
      });

      it("does not move the item before it has crossed anything", async () => {
        // The failure the physical reading produces on the very first move: with
        // A at the right end, both siblings' midpoints are below the pointer, so
        // a physical count lands on the far slot and teleports A across the row.
        await mountRtl();
        stubRects({ i1: 200, i2: 100, i3: 0 }, "x", 100);
        const pointer = (id: string, type: string, x: number) => pointerAt(id, type, "x", x);
        pointer("i1", "pointerdown", 250);
        pointer("i1", "pointermove", 245); // still over A's own column
        expect(order()).toEqual(["i1", "i2", "i3"]);
      });
    });
  });

  describe("pointer reorder (midpoint crossing)", () => {
    /** Lays the three items out vertically (30px rows) via stubbed rects. */
    const layout = () => stubRects({ i1: 0, i2: 30, i3: 60 }, "y", 30);
    const pointer = (id: string, type: string, y: number) => pointerAt(id, type, "y", y);

    it("moves the item as the pointer crosses sibling midpoints", async () => {
      const reorders = await mount();
      layout();
      pointer("i1", "pointerdown", 10);
      pointer("i1", "pointermove", 50); // past B's midpoint (45)
      expect(order()).toEqual(["i2", "i1", "i3"]);
      expect(status().textContent).toBe("Card A, position 2 of 3");

      pointer("i1", "pointermove", 80); // past C's midpoint (75)
      expect(order()).toEqual(["i2", "i3", "i1"]);

      pointer("i1", "pointerup", 80);
      expect(reorders).toEqual([{ item: document.querySelector("#i1"), from: 0, to: 2 }]);
    });

    it("does not reorder without layout geometry (happy-dom zero rects)", async () => {
      const reorders = await mount();
      pointer("i1", "pointerdown", 10);
      pointer("i1", "pointermove", 500);
      pointer("i1", "pointerup", 500);
      expect(order()).toEqual(["i1", "i2", "i3"]);
      expect(reorders).toHaveLength(0);
    });

    it("restores the pickup position when the pointer drag is canceled", async () => {
      const reorders = await mount();
      layout();
      pointer("i1", "pointerdown", 10);
      pointer("i1", "pointermove", 50);
      expect(order()).toEqual(["i2", "i1", "i3"]);

      handle("i1").dispatchEvent(
        new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }),
      );
      expect(order()).toEqual(["i1", "i2", "i3"]);
      expect(reorders).toHaveLength(0);
    });
  });

  describe("Turbo resilience", () => {
    it("stops interpreting drag events after disconnect", async () => {
      const reorders = await mount();
      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--sortable",
      ) as SortableController;
      controller.disconnect();

      key("i2", " ");
      key("i2", "ArrowUp");
      key("i2", " ");
      // pointer-drag still emits (its own controller is alive), but sortable no
      // longer reorders or announces.
      expect(order()).toEqual(["i1", "i2", "i3"]);
      expect(status().textContent).toBe("");
      expect(reorders).toHaveLength(0);
    });

    it("recovers the session when an item's pointer-drag is morphed away mid-grab", async () => {
      // A Turbo morph can strip the ITEM's data-controller while sortable (on
      // the ancestor) stays connected. pointer-drag's teardown then ends the
      // run in `cancel` (synchronously on a real morph via the DetachGate fast
      // path; via the probe here, where a direct disconnect() keeps the token),
      // so sortable restores the pickup position and frees its one-at-a-time
      // session — the list must not lock up.
      const reorders = await mount();
      key("i2", " ");
      key("i2", "ArrowUp");
      expect(order()).toEqual(["i2", "i1", "i3"]);
      // Let Stimulus settle the ArrowUp move's mutation batch (disconnect +
      // reconnect, session kept) before simulating the morph detach — a real
      // morph is a separate, later batch.
      await delay(0);

      const drag = application.getControllerForElementAndIdentifier(
        document.querySelector("#i2") as HTMLElement,
        "stimeo--pointer-drag",
      ) as PointerDragController;
      drag.disconnect(); // element kept, no reconnect (morph-style detach)
      await flushMicrotasks(); // deferred teardown → cancel bubbles to sortable
      expect(order()).toEqual(["i1", "i2", "i3"]); // pickup position restored
      expect(status().textContent).toBe("Reorder canceled, Card B returned to position 2 of 3");
      expect(root().hasAttribute("data-sortable-dragging")).toBe(false);

      key("i1", " "); // the next grab must not be swallowed by a stranded session
      expect(status().textContent).toBe("Grabbed Card A, position 1 of 3");
      key("i1", "Escape");
      expect(reorders).toHaveLength(0);
    });

    it("clears a stale dragging hook a cache restore may have snapshotted", async () => {
      await mount(
        fixture.replace(
          'data-controller="stimeo--sortable"',
          'data-controller="stimeo--sortable" data-sortable-dragging="true"',
        ),
      );
      expect(root().hasAttribute("data-sortable-dragging")).toBe(false);
    });
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(document.body);
  });

  // --- Speech-order regression ------------------------------------------------

  it("keeps the list announceable and reflects the new order after a keyboard move", async () => {
    await mount();
    const list = document.querySelector("ul") as HTMLElement;
    // Freeze the whole ordered walk (list → item → name → handle) for each order.
    const listSpeech = (names: string[]) => [
      "list, Cards",
      ...names.flatMap((name, index) => [
        `listitem, level 1, position ${index + 1}, set size 3`,
        name,
        `button, Reorder ${name}`,
        "⠿",
        `end of button, Reorder ${name}`,
        `end of listitem, level 1, position ${index + 1}, set size 3`,
      ]),
    ];
    const before = await captureSpeech({ container: list, steps: 18 });
    expect(before).toEqual(listSpeech(["Card A", "Card B", "Card C"]));

    key("i2", " ");
    key("i2", "ArrowUp");
    key("i2", " ");
    // The reorder is a real DOM move, so the reading order follows it — Card B
    // now announces before Card A (visual order never diverges from DOM order).
    const after = await captureSpeech({ container: list, steps: 18 });
    expect(after).toEqual(listSpeech(["Card B", "Card A", "Card C"]));
  });
});
