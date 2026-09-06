import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PointerDragController } from "../src/controllers/pointer_drag_controller";
import { RovingController } from "../src/controllers/roving_controller";
import { SortableController } from "../src/controllers/sortable_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { press } from "./helpers/keyboard";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { delay, flushMicrotasks } from "./helpers/timing";

/**
 * Behavioral tests for {@link SortableController} driven through the real
 * composition (`stimeo--pointer-drag` on the items, `stimeo--roving` on the
 * list): keyboard grab → step → drop/cancel with shared-announcer messages,
 * pointer midpoint-crossing reorder (stubbed geometry — the branch logic; the
 * measurement truth stays a real-browser concern), the `reorder` event, the
 * roving yield while grabbed, and Turbo teardown/reconnect resilience.
 */

type ReorderDetail = { item: HTMLElement; from: number; to: number };

describe("SortableController", () => {
  let application: Application;

  const fixture = `
    <main>
      <div id="root" data-controller="stimeo--sortable"
           data-stimeo--sortable-announce-grabbed-text-value="Grabbed {name}, position {position} of {total}"
           data-stimeo--sortable-announce-moved-text-value="{name}, position {position} of {total}"
           data-stimeo--sortable-announce-dropped-text-value="Dropped {name} at position {position} of {total}"
           data-stimeo--sortable-announce-canceled-text-value="Reorder canceled, {name} returned to position {position} of {total}">
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
      </div>
    </main>`;

  /** Every message handed to the page's shared announcer, in order. */
  let announcements: string[] = [];
  const onAnnouncement = (event: Event) => {
    announcements.push((event as CustomEvent<{ message: string }>).detail.message);
  };
  /** The wording the announcer was last given, or `""` when it heard nothing. */
  const announced = () => announcements[announcements.length - 1] ?? "";

  /** Mounts the fixture with the full composition and records reorder events. */
  const mount = async (html = fixture): Promise<ReorderDetail[]> => {
    document.body.innerHTML = html;
    announcements = [];
    window.addEventListener("stimeo--announcer:announce", onAnnouncement);
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
    window.removeEventListener("stimeo--announcer:announce", onAnnouncement);
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    await delay(20);
  });

  const root = () => document.querySelector<HTMLElement>("#root") as HTMLElement;
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

  /** Stubs `id` as an element with no layout box (`display: none` reports this). */
  const stubEmptyRect = (id: string) => {
    const item = document.querySelector<HTMLElement>(`#${id}`) as HTMLElement;
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 0, 0));
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
      expect(announced()).toBe("Grabbed Card B, position 2 of 3");
      expect(root().getAttribute("data-sortable-dragging")).toBe("true");
    });

    it("steps the item one position per arrow and announces each move", async () => {
      await mount();
      key("i2", " ");
      key("i2", "ArrowUp");
      expect(order()).toEqual(["i2", "i1", "i3"]);
      expect(announced()).toBe("Card B, position 1 of 3");

      key("i2", "ArrowDown");
      key("i2", "ArrowDown");
      expect(order()).toEqual(["i1", "i3", "i2"]);
      expect(announced()).toBe("Card B, position 3 of 3");
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
      expect(announced()).toBe("Dropped Card B at position 1 of 3");
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
      expect(announced()).toBe("Dropped Card B at position 2 of 3");
    });

    it("restores the pickup position on Escape and announces the cancel", async () => {
      const reorders = await mount();
      key("i1", " ");
      key("i1", "ArrowDown");
      key("i1", "ArrowDown");
      expect(order()).toEqual(["i2", "i3", "i1"]);

      key("i1", "Escape");
      expect(order()).toEqual(["i1", "i2", "i3"]);
      expect(announced()).toBe("Reorder canceled, Card A returned to position 1 of 3");
      expect(reorders).toHaveLength(0);
      expect(root().hasAttribute("data-sortable-dragging")).toBe(false);
    });

    it("ignores cross-axis arrows (the items lock to the y axis)", async () => {
      await mount();
      key("i2", " ");
      key("i2", "ArrowRight");
      expect(order()).toEqual(["i1", "i2", "i3"]);
    });

    it("fills the consumer's wording with the item's name and place", async () => {
      // The three placeholders are this component's contract; the substitution
      // rules themselves (repeats, unknown tokens, `$` literals) belong to the
      // shared `fillTemplate` and are pinned by tests/utils/announce.test.ts.
      // The name is author/content-derived, so a `$`-sequence in it must reach
      // the announcer exactly as the card spells it.
      await mount();
      root().setAttribute(
        "data-stimeo--sortable-announce-grabbed-text-value",
        "{name}を掴みました（{total}件中{position}件目）",
      );
      document
        .querySelector("#i3")
        ?.setAttribute("data-stimeo--sortable-name", "Save $$ $& top {total} plan");
      key("i3", " ");
      expect(announced()).toBe("Save $$ $& top {total} planを掴みました（3件中3件目）");
    });

    it("stays silent for a step the consumer gave no wording", async () => {
      // Opt-in: the library ships no English copy, so an unset template
      // announces nothing rather than falling back to a built-in string.
      await mount();
      root().removeAttribute("data-stimeo--sortable-announce-grabbed-text-value");
      key("i2", " ");
      expect(announcements).toEqual([]);
      key("i2", "ArrowUp");
      expect(announced()).toBe("Card B, position 1 of 3"); // moved is still authored
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
      expect(announced()).toBe("Card A, position 2 of 3");

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
        expect(announced()).toBe("Card A, position 2 of 3");

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
      expect(announced()).toBe("Card A, position 2 of 3");

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
      expect(announcements).toEqual([]);
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
      expect(announced()).toBe("Reorder canceled, Card B returned to position 2 of 3");
      expect(root().hasAttribute("data-sortable-dragging")).toBe(false);

      key("i1", " "); // the next grab must not be swallowed by a stranded session
      expect(announced()).toBe("Grabbed Card A, position 1 of 3");
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

  describe("session lifetime", () => {
    it("frees the session when the dragged item loses its target attribute", async () => {
      // A morph can strip the item's own target attribute while the element and
      // both controllers stay connected. The drag then has no owner the
      // controller can recognise, so the session has to end instead of holding
      // the one-at-a-time slot for the rest of the page's life.
      await mount();
      press(handle("i2"), " ");
      press(handle("i2"), "ArrowUp");
      expect(order()).toEqual(["i2", "i1", "i3"]);

      (document.querySelector("#i2") as HTMLElement).removeAttribute(
        "data-stimeo--sortable-target",
      );
      await delay(0);
      expect(root().hasAttribute("data-sortable-dragging")).toBe(false);
      // The element is still in the document, so the half-finished move is
      // undone — it goes back to the slot it was picked up from.
      expect(Array.from(document.querySelectorAll("li")).map((row) => row.id)).toEqual([
        "i1",
        "i2",
        "i3",
      ]);

      announcements = [];
      press(handle("i1"), " ");
      expect(announced()).toBe("Grabbed Card A, position 1 of 2");
    });

    it("frees the session when the dragged item is removed from the document", async () => {
      // A broadcast row delete, the collaborative case: pointer-drag
      // deliberately stays silent on a detached tree, so the cancel never
      // bubbles and only the target callback can end the session.
      const reorders = await mount();
      press(handle("i2"), " ");
      (document.querySelector("#i2") as HTMLElement).remove();
      await delay(0);
      expect(root().hasAttribute("data-sortable-dragging")).toBe(false);
      // The row is gone for good: ending the session must not put it back.
      expect(order()).toEqual(["i1", "i3"]);
      expect(reorders).toHaveLength(0);

      announcements = [];
      press(handle("i1"), " ");
      expect(announced()).toBe("Grabbed Card A, position 1 of 2");
    });

    it("keeps the session across the in-page move its own reorder performs", async () => {
      // The same target callbacks fire for the controller's own re-insert, so
      // the two have to be told apart or every arrow would end the drag.
      const reorders = await mount();
      press(handle("i2"), " ");
      press(handle("i2"), "ArrowUp");
      await delay(0);
      expect(root().getAttribute("data-sortable-dragging")).toBe("true");
      press(handle("i2"), " ");
      expect(reorders).toEqual([{ item: document.querySelector("#i2"), from: 1, to: 0 }]);
    });
  });

  describe("container resolution", () => {
    /** The documented list-less shape: items sit directly under the controller. */
    const listless = `
      <main>
        <div id="root" data-controller="stimeo--sortable"
             data-stimeo--sortable-announce-moved-text-value="{name}, position {position} of {total}">
          <div id="i1" data-stimeo--sortable-target="item" data-stimeo--sortable-name="Card A"
               data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-axis-value="y">
            <button type="button" aria-label="Reorder Card A"
                    data-stimeo--pointer-drag-target="handle">H</button></div>
          <div id="i2" data-stimeo--sortable-target="item" data-stimeo--sortable-name="Card B"
               data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-axis-value="y">
            <button type="button" aria-label="Reorder Card B"
                    data-stimeo--pointer-drag-target="handle">H</button></div>
          <div id="i3" data-stimeo--sortable-target="item" data-stimeo--sortable-name="Card C"
               data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-axis-value="y">
            <button type="button" aria-label="Reorder Card C"
                    data-stimeo--pointer-drag-target="handle">H</button></div>
          <p id="footer">Drag to reorder</p>
        </div>
      </main>`;

    it("reorders without a list target, keeping the item among the items", async () => {
      // `list` is documented optional, and the reorder is defined against the
      // items themselves: the last slot is after the last item, not after
      // whatever else the container happens to hold.
      await mount(listless);
      press(handle("i1"), " ");
      press(handle("i1"), "ArrowDown");
      press(handle("i1"), "ArrowDown");
      expect(order()).toEqual(["i2", "i3", "i1"]);
      expect(Array.from(root().children).map((child) => child.id)).toEqual([
        "i2",
        "i3",
        "i1",
        "footer",
      ]);
    });

    it("reorders when the items sit in a container that is not a target", async () => {
      // A wrapper the author did not mark as `list` still holds the items, so
      // the move has to land inside it rather than on the controller element.
      await mount(
        fixture
          .replace(' data-stimeo--sortable-target="list"', "")
          .replace(
            'data-controller="stimeo--roving"',
            'data-controller="stimeo--roving" data-stimeo--roving-orientation-value="vertical"',
          ),
      );
      press(handle("i1"), " ");
      press(handle("i1"), "ArrowDown");
      expect(order()).toEqual(["i2", "i1", "i3"]);
      expect(root().getAttribute("data-sortable-dragging")).toBe("true");
    });

    it("survives a grab and cancel on a single-item list", async () => {
      await mount(
        fixture.replace(/<li id="i2"[\s\S]*?<\/li>/, "").replace(/<li id="i3"[\s\S]*?<\/li>/, ""),
      );
      press(handle("i1"), " ");
      press(handle("i1"), "ArrowDown");
      press(handle("i1"), "Escape");
      expect(order()).toEqual(["i1"]);
      expect(root().hasAttribute("data-sortable-dragging")).toBe(false);
    });
  });

  describe("siblings without a layout box", () => {
    it("does not move the item when no visible midpoint was crossed", async () => {
      // A filtered-out row reports an empty rect at the document origin, whose
      // midpoint of 0 sits below every pointer position. Counting it would move
      // the item on the first pointermove, before it crossed anything.
      await mount();
      stubRects({ i1: 0, i2: 30 }, "y", 30);
      stubEmptyRect("i3");
      pointerAt("i1", "pointerdown", "y", 10);
      pointerAt("i1", "pointermove", "y", 25); // still inside its own row
      expect(order()).toEqual(["i1", "i2", "i3"]);
      // The grab is announced; nothing moved, so nothing else is.
      expect(announcements).toEqual(["Grabbed Card A, position 1 of 3"]);
    });

    it("lands on the slot the visible midpoints define", async () => {
      const reorders = await mount();
      stubRects({ i1: 0, i2: 30 }, "y", 30);
      stubEmptyRect("i3");
      pointerAt("i1", "pointerdown", "y", 10);
      pointerAt("i1", "pointermove", "y", 50); // past B's midpoint (45), and only that
      expect(order()).toEqual(["i2", "i1", "i3"]);
      pointerAt("i1", "pointerup", "y", 50);
      expect(reorders).toEqual([{ item: document.querySelector("#i1"), from: 0, to: 1 }]);
    });
  });

  describe("the pickup slot under concurrent edits", () => {
    it("returns the item to the slot it was picked up from after a row is prepended", async () => {
      // A broadcast can prepend a row while a drag is live. A pickup
      // remembered as an integer index no longer points at the same place once
      // the list shifted underneath it.
      await mount();
      press(handle("i3"), " ");
      (document.querySelector("ul") as HTMLElement).insertAdjacentHTML(
        "afterbegin",
        `<li id="i0" data-stimeo--sortable-target="item" data-stimeo--sortable-name="Card Z"
             data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-axis-value="y">
           <button type="button" aria-label="Reorder Card Z"
                   data-stimeo--pointer-drag-target="handle"
                   data-stimeo--roving-target="item">⠿</button></li>`,
      );
      await delay(0);
      press(handle("i3"), "Escape");
      expect(order()).toEqual(["i0", "i1", "i2", "i3"]);
    });

    it("reports no reorder when only the neighbour it was picked up beside disappears", async () => {
      // The item never moved, so nothing must be persisted — the vanished
      // neighbour is not evidence that the reader reordered anything.
      const reorders = await mount();
      press(handle("i1"), " ");
      (document.querySelector("#i2") as HTMLElement).remove();
      await delay(0);
      press(handle("i1"), " ");
      expect(order()).toEqual(["i1", "i3"]);
      expect(reorders).toHaveLength(0);
    });
  });

  describe("nested drag signals", () => {
    it("ignores a pointer-drag nested inside an item", async () => {
      // A card may carry its own draggable control (a knob, a split pane). Its
      // signal bubbles through the item, but it is not the item's own drag.
      const reorders = await mount(
        fixture.replace(
          "<span>Card B</span>",
          `<span>Card B</span>
           <span id="knob-host" data-controller="stimeo--pointer-drag"
                 data-stimeo--pointer-drag-axis-value="y">
             <button type="button" id="knob" aria-label="Knob"
                     data-stimeo--pointer-drag-target="handle">K</button></span>`,
        ),
      );
      press(document.querySelector("#knob") as HTMLElement, " ");
      expect(announcements).toEqual([]);
      press(document.querySelector("#knob") as HTMLElement, "ArrowDown");
      expect(order()).toEqual(["i1", "i2", "i3"]);
      expect(reorders).toHaveLength(0);
      expect(root().hasAttribute("data-sortable-dragging")).toBe(false);
    });
  });

  describe("composition with roving", () => {
    /** The fixture the composition contract calls for: matching orientations. */
    const conforming = fixture.replace(
      'data-controller="stimeo--roving"',
      'data-controller="stimeo--roving" data-stimeo--roving-orientation-value="vertical"',
    );

    it("keeps the tab stop and the grab when an arrow is consumed", async () => {
      // The yield only means anything on a cancelable press against a roving
      // whose orientation matches the sort axis; without both, the guard under
      // test is never reached.
      await mount(conforming);
      const event = press(handle("i1"), " ");
      expect(event.defaultPrevented).toBe(true);
      const arrow = press(handle("i1"), "ArrowDown");
      expect(arrow.defaultPrevented).toBe(true);
      expect(order()).toEqual(["i2", "i1", "i3"]);
      expect(handle("i1").tabIndex).toBe(0);
      expect(handle("i2").tabIndex).toBe(-1);
    });

    it("keeps the grab when Home or End arrives", async () => {
      // Every key the handle owns while grabbed has to be consumed there, or a
      // composition partner moves focus away and the session is stranded with
      // no way back — Escape then lands on a handle that holds no session.
      await mount(conforming);
      press(handle("i1"), " ");
      const end = press(handle("i1"), "End");
      expect(end.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(handle("i1"));
      expect(root().getAttribute("data-sortable-dragging")).toBe("true");

      press(handle("i1"), "Escape");
      expect(root().hasAttribute("data-sortable-dragging")).toBe(false);
    });

    it("leaves the tab stop on the handle that rode the move", async () => {
      // Re-inserting the row reaches roving as a target disconnect and connect,
      // one mutation batch after the move. Focus rides the handle, so the Tab
      // stop has to ride it too — otherwise leaving the group and coming back
      // lands on the first row rather than the one being carried.
      await mount(conforming);
      handle("i1").focus();
      press(handle("i1"), " ");
      press(handle("i1"), "ArrowDown");
      expect(order()).toEqual(["i2", "i1", "i3"]);

      await delay(0);
      expect(document.activeElement).toBe(handle("i1"));
      expect(handle("i1").tabIndex).toBe(0);
      expect(handle("i2").tabIndex).toBe(-1);
      expect(handle("i3").tabIndex).toBe(-1);
    });
  });

  describe("optional markup and the axis defaults", () => {
    it("falls back to the item's own text when no name is authored", async () => {
      // The documented fallback is the item's collapsed text, handle glyph
      // included — an author who wants the card's title alone says so with
      // `data-stimeo--sortable-name`.
      await mount();
      (document.querySelector("#i1") as HTMLElement).removeAttribute("data-stimeo--sortable-name");
      press(handle("i1"), " ");
      expect(announced()).toBe("Grabbed Card A ⠿, position 1 of 3");
    });

    it("ignores a cross-axis arrow when the item locks no axis", async () => {
      // `axis` unset means `both`, which the composition rules call the always
      // safe default: the drag then reports movement on either axis and the
      // sort axis alone decides whether a step happened.
      const reorders = await mount(
        fixture.replaceAll(' data-stimeo--pointer-drag-axis-value="y"', ""),
      );
      press(handle("i2"), " ");
      press(handle("i2"), "ArrowRight");
      expect(order()).toEqual(["i1", "i2", "i3"]);
      expect(announced()).toBe("Grabbed Card B, position 2 of 3"); // no move announced

      press(handle("i2"), "ArrowUp");
      expect(order()).toEqual(["i2", "i1", "i3"]);
      press(handle("i2"), " ");
      expect(reorders).toEqual([{ item: document.querySelector("#i2"), from: 1, to: 0 }]);
    });

    it("does not reverse the arrows of a vertical list under dir=rtl", async () => {
      // Writing direction mirrors the inline axis only; a column reads top to
      // bottom either way, so the physical reading is already the right one.
      await mount();
      (
        document.querySelector("[data-stimeo--sortable-target='list']") as HTMLElement
      ).style.direction = "rtl";
      press(handle("i1"), " ");
      press(handle("i1"), "ArrowDown");
      expect(order()).toEqual(["i2", "i1", "i3"]);
      press(handle("i1"), "ArrowUp");
      expect(order()).toEqual(["i1", "i2", "i3"]);
    });
  });

  describe("session exclusivity, from the other side", () => {
    it("ignores the moves, drops and cancels of the item that was refused", async () => {
      // The refused item's own pointer-drag still grabs and still emits, and
      // that degradation is deliberately silent, so every one of those events
      // has to be matched against the live session before it is acted on.
      const reorders = await mount();
      press(handle("i1"), " "); // A owns the session
      press(handle("i2"), " "); // B grabs its own pointer-drag; sortable refuses
      announcements = [];

      press(handle("i2"), "ArrowDown");
      expect(order()).toEqual(["i1", "i2", "i3"]);
      press(handle("i2"), "Escape"); // B cancels its own grab
      press(handle("i2"), " "); // and grabs and drops again
      press(handle("i2"), " ");
      expect(order()).toEqual(["i1", "i2", "i3"]);
      expect(announcements).toEqual([]);
      expect(root().getAttribute("data-sortable-dragging")).toBe("true"); // A survives

      press(handle("i1"), "ArrowDown");
      press(handle("i1"), " ");
      expect(reorders).toEqual([{ item: document.querySelector("#i1"), from: 0, to: 1 }]);
    });
  });

  describe("more of the session's edges", () => {
    it("ignores a refused item's drop after the owner's row vanished", async () => {
      // Both halves of the exclusivity are live here: B was refused while A
      // held the session, and by the time B lets go the session is gone with
      // A's row — so B's drop belongs to nobody and must report nothing.
      const reorders = await mount();
      press(handle("i1"), " ");
      press(handle("i2"), " "); // refused, but B's own pointer-drag is grabbed
      press(handle("i3"), " "); // and so is C's
      (document.querySelector("#i1") as HTMLElement).remove();
      await delay(0);
      expect(root().hasAttribute("data-sortable-dragging")).toBe(false);

      announcements = [];
      press(handle("i2"), " "); // B drops into a session-less controller
      press(handle("i3"), "Escape"); // C cancels into one
      expect(announcements).toEqual([]);
      expect(order()).toEqual(["i2", "i3"]);
      expect(reorders).toHaveLength(0);

      // The controller is free again, so the next grab is a session of its own.
      press(handle("i2"), " ");
      expect(announced()).toBe("Grabbed Card B, position 1 of 2");
    });

    it("leaves the item where it stands when its whole neighbourhood vanished", async () => {
      // Both neighbours gone *and* the row itself no longer an item: there is
      // no slot the pickup can be read back from, so the element is left alone
      // rather than guessed to the front of what is left.
      await mount(
        fixture.replace(
          "</ul>",
          `<li id="i4" data-stimeo--sortable-target="item" data-stimeo--sortable-name="Card D"
               data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-axis-value="y">
             <button type="button" aria-label="Reorder Card D"
                     data-stimeo--pointer-drag-target="handle"
                     data-stimeo--roving-target="item">⠿</button></li></ul>`,
        ),
      );
      press(handle("i2"), " "); // neighbours are i1 and i3
      press(handle("i2"), "ArrowDown");
      press(handle("i2"), "ArrowDown");
      expect(order()).toEqual(["i1", "i3", "i4", "i2"]);

      (document.querySelector("#i1") as HTMLElement).remove();
      (document.querySelector("#i3") as HTMLElement).remove();
      (document.querySelector("#i2") as HTMLElement).removeAttribute(
        "data-stimeo--sortable-target",
      );
      await delay(0);
      expect(root().hasAttribute("data-sortable-dragging")).toBe(false);
      // Left exactly where the drag had carried it — not guessed to the front.
      expect(Array.from(document.querySelectorAll("li")).map((row) => row.id)).toEqual([
        "i4",
        "i2",
      ]);
    });

    it("leaves the item alone when both of its pickup neighbours are gone", async () => {
      // Nothing is known about where it came from, so a cancel must not guess a
      // slot and a drop must not report a move the reader never made.
      const reorders = await mount();
      press(handle("i2"), " "); // neighbours are i1 and i3
      (document.querySelector("#i1") as HTMLElement).remove();
      (document.querySelector("#i3") as HTMLElement).remove();
      await delay(0);
      // The session survives: the dragged row is still a target.
      expect(root().getAttribute("data-sortable-dragging")).toBe("true");
      press(handle("i2"), "Escape");
      expect(order()).toEqual(["i2"]);
      expect(reorders).toHaveLength(0);
    });

    it("counts only the laid-out siblings that precede it", async () => {
      // A hidden row before the dragged item is skipped on both sides of the
      // comparison: the slot the pointer names and the slot the item already
      // stands in are read in the same laid-out space, so standing still
      // reports nothing.
      await mount();
      stubEmptyRect("i1");
      stubRects({ i2: 0, i3: 30 }, "y", 30);
      pointerAt("i3", "pointerdown", "y", 40);
      pointerAt("i3", "pointermove", "y", 45); // past B's midpoint — where it already is
      expect(order()).toEqual(["i1", "i2", "i3"]);
      announcements = [];

      pointerAt("i3", "pointermove", "y", 50); // still the same slot
      expect(order()).toEqual(["i1", "i2", "i3"]);
      expect(announcements).toEqual([]);

      pointerAt("i3", "pointermove", "y", 10); // back before B's midpoint
      expect(order()).toEqual(["i1", "i3", "i2"]);
    });

    it("inserts before the neighbour standing in the slot, not after the last one", async () => {
      // A move into a middle slot has to land on the sibling that occupies it;
      // reaching for the end instead would collapse every move onto the tail.
      const reorders = await mount();
      press(handle("i3"), " ");
      press(handle("i3"), "ArrowUp");
      expect(order()).toEqual(["i1", "i3", "i2"]);
      press(handle("i3"), " ");
      expect(reorders).toEqual([{ item: document.querySelector("#i3"), from: 2, to: 1 }]);
    });

    it("reads the writing direction from the container when no list target is given", async () => {
      // Without a `list` target the controller element is the container, and it
      // is that element's computed direction that decides which way a row runs.
      const horizontalListless = fixture
        .replace(
          'data-controller="stimeo--sortable"',
          'data-controller="stimeo--sortable" data-stimeo--sortable-orientation-value="horizontal"',
        )
        .replace(' data-stimeo--sortable-target="list"', "")
        .replaceAll(
          'data-stimeo--pointer-drag-axis-value="y"',
          'data-stimeo--pointer-drag-axis-value="x"',
        );
      await mount(horizontalListless);
      root().style.direction = "rtl";
      press(handle("i1"), " ");
      press(handle("i1"), "ArrowLeft"); // leftward on screen = later in DOM order
      expect(order()).toEqual(["i2", "i1", "i3"]);
    });
  });

  describe("rows added after connect", () => {
    it("reorders across a row a Turbo Stream appended, with no rewiring", async () => {
      // The item set is read from the DOM on every event, so a broadcast row
      // joins the sort without the consumer binding anything.
      const reorders = await mount();
      (document.querySelector("ul") as HTMLElement).insertAdjacentHTML(
        "beforeend",
        `<li id="i4" data-stimeo--sortable-target="item" data-stimeo--sortable-name="Card D"
             data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-axis-value="y">
           <button type="button" aria-label="Reorder Card D"
                   data-stimeo--pointer-drag-target="handle"
                   data-stimeo--roving-target="item">⠿</button></li>`,
      );
      await delay(20);

      press(handle("i4"), " ");
      expect(announced()).toBe("Grabbed Card D, position 4 of 4");
      press(handle("i4"), "ArrowUp");
      press(handle("i4"), "ArrowUp");
      expect(order()).toEqual(["i1", "i4", "i2", "i3"]);
      press(handle("i4"), " ");
      expect(reorders).toEqual([{ item: document.querySelector("#i4"), from: 3, to: 1 }]);
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
