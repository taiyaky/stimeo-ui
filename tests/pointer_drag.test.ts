import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PointerDragController } from "../src/controllers/pointer_drag_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { delay, flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link PointerDragController}: the pointer drag
 * lifecycle (threshold → start/move/end, pointercancel/Escape → cancel), the
 * keyboard alternative (Space/Enter grab & drop, arrow moves, Escape cancel),
 * axis locking, the `data-dragging`/`data-grabbed` hooks, the handle contract
 * (touch-action, focusability), and Turbo teardown/reconnect resilience.
 */

type DragDetail = {
  dx?: number;
  dy?: number;
  x?: number;
  y?: number;
  pointerType: string;
};

describe("PointerDragController", () => {
  let application: Application;

  /** Mounts the fixture, registers the controller, and records its events. */
  const mount = async (html: string): Promise<Record<string, DragDetail[]>> => {
    document.body.innerHTML = html;
    const events: Record<string, DragDetail[]> = { start: [], move: [], end: [], cancel: [] };
    for (const name of Object.keys(events)) {
      document.body.addEventListener(`stimeo--pointer-drag:${name}`, (event) => {
        events[name]?.push((event as CustomEvent<DragDetail>).detail);
      });
    }
    application = Application.start();
    application.register("stimeo--pointer-drag", PointerDragController);
    await delay(20);
    return events;
  };

  const defaultFixture = `
    <ul>
      <li data-controller="stimeo--pointer-drag">
        <span>Card A</span>
        <button type="button" data-stimeo--pointer-drag-target="handle"
                aria-label="Reorder Card A">⠿</button>
      </li>
    </ul>`;

  afterEach(async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    await delay(20);
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--pointer-drag']") as HTMLElement;
  const handle = () =>
    document.querySelector<HTMLElement>("[data-stimeo--pointer-drag-target='handle']") ?? root();
  const controller = () =>
    root()
      ? (application?.getControllerForElementAndIdentifier(
          root(),
          "stimeo--pointer-drag",
        ) as PointerDragController | null)
      : null;

  /** Dispatches a pointerdown and reports whether the controller consumed it. */
  const pointerDown = (x: number, y: number, pointerId = 1) =>
    handle().dispatchEvent(
      new PointerEvent("pointerdown", {
        clientX: x,
        clientY: y,
        pointerId,
        bubbles: true,
        cancelable: true,
      }),
    );
  const pointerMove = (x: number, y: number, pointerId = 1) =>
    handle().dispatchEvent(
      new PointerEvent("pointermove", { clientX: x, clientY: y, pointerId, bubbles: true }),
    );
  const pointerUp = (pointerId = 1) =>
    handle().dispatchEvent(new PointerEvent("pointerup", { pointerId, bubbles: true }));
  /**
   * Focuses the handle, then dispatches a keydown on it and reports whether the
   * controller consumed it. Pressing at an element that never held focus skips
   * every path that reads `document.activeElement` and leaves the result of a
   * focus move unassertable.
   */
  const key = (k: string) => {
    handle().focus();
    return handle().dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
    );
  };

  describe("pointer lifecycle", () => {
    it("does not start until the movement passes the threshold", async () => {
      const events = await mount(defaultFixture);
      pointerDown(100, 100);
      pointerMove(102, 100); // 2px < default threshold 3
      expect(events.start).toHaveLength(0);
      expect(root().hasAttribute("data-dragging")).toBe(false);

      pointerMove(105, 100); // 5px ≥ threshold
      expect(events.start).toEqual([{ x: 105, y: 100, pointerType: "mouse" }]);
      expect(root().getAttribute("data-dragging")).toBe("true");
    });

    it("reports cumulative deltas on move and end, then clears the hook", async () => {
      const events = await mount(defaultFixture);
      pointerDown(100, 100);
      pointerMove(110, 105);
      pointerMove(120, 130);
      expect(events.move).toEqual([
        { dx: 10, dy: 5, x: 110, y: 105, pointerType: "mouse" },
        { dx: 20, dy: 30, x: 120, y: 130, pointerType: "mouse" },
      ]);

      pointerUp();
      expect(events.end).toEqual([{ dx: 20, dy: 30, pointerType: "mouse" }]);
      expect(root().hasAttribute("data-dragging")).toBe(false);
    });

    it("stays silent for a below-threshold press-release (a plain click)", async () => {
      const events = await mount(defaultFixture);
      pointerDown(100, 100);
      pointerUp();
      expect(events.start).toHaveLength(0);
      expect(events.end).toHaveLength(0);
    });

    it("dispatches cancel on pointercancel (OS gesture takeover)", async () => {
      const events = await mount(defaultFixture);
      pointerDown(100, 100);
      pointerMove(110, 100);
      handle().dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }));
      expect(events.cancel).toEqual([{ pointerType: "mouse" }]);
      expect(events.end).toHaveLength(0);
      expect(root().hasAttribute("data-dragging")).toBe(false);
    });

    it("captures the pointer on down and releases it on up", async () => {
      await mount(defaultFixture);
      pointerDown(100, 100);
      expect(handle().hasPointerCapture(1)).toBe(true);
      pointerMove(110, 100);
      pointerUp();
      expect(handle().hasPointerCapture(1)).toBe(false);
    });

    it("ignores a second pointerdown while a drag session is live", async () => {
      const events = await mount(defaultFixture);
      pointerDown(100, 100, 1);
      pointerMove(110, 100, 1);
      expect(events.start).toHaveLength(1);

      // A second pointer (multi-touch / errant tap) must not hijack the session
      // or leave its own capture orphaned on the handle.
      pointerDown(200, 200, 2);
      expect(handle().hasPointerCapture(2)).toBe(false);

      // The original pointer keeps tracking; release still ends cleanly.
      pointerMove(130, 100, 1);
      expect(events.move).toHaveLength(2);
      pointerUp(1);
      expect(events.end).toEqual([{ dx: 30, dy: 0, pointerType: "mouse" }]);
      expect(handle().hasPointerCapture(1)).toBe(false);
    });

    it("cancels an in-flight pointer drag on Escape", async () => {
      const events = await mount(defaultFixture);
      pointerDown(100, 100);
      pointerMove(110, 100);
      key("Escape");
      expect(events.cancel).toEqual([{ pointerType: "mouse" }]);
      expect(root().hasAttribute("data-dragging")).toBe(false);

      pointerMove(150, 100); // listeners are gone; no further move
      expect(events.move).toHaveLength(1);
    });

    it("keeps the drag alive on an Escape that cancels an IME composition", async () => {
      const events = await mount(defaultFixture);
      pointerDown(100, 100);
      pointerMove(110, 100);
      // Widget-local half of the shared layered-Escape contract: a composing
      // press steers the IME conversion and never cancels the session.
      handle().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }),
      );
      expect(events.cancel).toEqual([]);
      expect(root().hasAttribute("data-dragging")).toBe(true);

      key("Escape"); // a real press still cancels
      expect(events.cancel).toEqual([{ pointerType: "mouse" }]);
    });

    it("ignores non-primary buttons and events outside the handle", async () => {
      const events = await mount(defaultFixture);
      handle().dispatchEvent(
        new PointerEvent("pointerdown", { clientX: 0, clientY: 0, button: 2, bubbles: true }),
      );
      root()
        .querySelector("span")
        ?.dispatchEvent(new PointerEvent("pointerdown", { clientX: 0, clientY: 0, bubbles: true }));
      pointerMove(100, 100);
      expect(events.start).toHaveLength(0);
    });
  });

  describe("session exclusivity", () => {
    it("ignores Space while a pointer drag is live (no parallel keyboard grab)", async () => {
      const events = await mount(defaultFixture);
      pointerDown(100, 100);
      pointerMove(110, 100); // started
      key(" "); // pointerdown focused the handle; Space must not double-start
      expect(events.start).toHaveLength(1);
      expect(root().hasAttribute("data-grabbed")).toBe(false);

      pointerUp();
      expect(events.end).toEqual([{ dx: 10, dy: 0, pointerType: "mouse" }]);
    });

    it("ignores a second pointer while a drag is live (multi-touch)", async () => {
      const events = await mount(defaultFixture);
      pointerDown(100, 100, 1);
      pointerMove(110, 100, 1);
      pointerDown(500, 500, 2); // second finger: must not orphan the first session
      pointerMove(120, 100, 1); // first finger still tracked
      expect(events.move).toHaveLength(2);

      pointerUp(1);
      expect(events.end).toEqual([{ dx: 20, dy: 0, pointerType: "mouse" }]);
    });

    it("ignores pointerdown while keyboard-grabbed", async () => {
      const events = await mount(defaultFixture);
      key(" ");
      pointerDown(100, 100);
      pointerMove(150, 100);
      expect(events.start).toHaveLength(1); // only the grab
      expect(events.move).toHaveLength(0); // no pointer session armed
    });
  });

  describe("axis locking", () => {
    const axisFixture = (axis: string) => `
      <ul>
        <li data-controller="stimeo--pointer-drag"
            data-stimeo--pointer-drag-axis-value="${axis}">
          <button type="button" data-stimeo--pointer-drag-target="handle"
                  aria-label="Reorder">⠿</button>
        </li>
      </ul>`;

    it("zeroes the cross-axis delta when axis=x", async () => {
      const events = await mount(axisFixture("x"));
      pointerDown(100, 100);
      pointerMove(110, 180);
      expect(events.move).toEqual([{ dx: 10, dy: 0, x: 110, y: 180, pointerType: "mouse" }]);
    });

    it("does not start from cross-axis movement alone when axis=y", async () => {
      const events = await mount(axisFixture("y"));
      pointerDown(100, 100);
      pointerMove(180, 100); // pure x movement: filtered distance is 0
      expect(events.start).toHaveLength(0);
      pointerMove(180, 110);
      expect(events.start).toHaveLength(1);
      expect(events.move).toEqual([{ dx: 0, dy: 10, x: 180, y: 110, pointerType: "mouse" }]);
    });

    it("consumes but does not emit locked-axis arrow keys while grabbed", async () => {
      const events = await mount(axisFixture("x"));
      key(" ");
      key("ArrowDown"); // locked axis: consumed, no move
      expect(events.move).toHaveLength(0);
      key("ArrowRight");
      expect(events.move).toEqual([{ dx: 10, dy: 0, x: 10, y: 0, pointerType: "keyboard" }]);
    });
  });

  describe("keyboard alternative", () => {
    it("grabs with Space, moves with arrows (cumulative), drops with Space", async () => {
      const events = await mount(defaultFixture);
      key(" ");
      expect(events.start).toEqual([{ x: 0, y: 0, pointerType: "keyboard" }]);
      expect(root().getAttribute("data-grabbed")).toBe("true");
      expect(handle().getAttribute("data-grabbed")).toBe("true");

      key("ArrowRight");
      key("ArrowDown");
      key("ArrowDown");
      expect(events.move).toEqual([
        { dx: 10, dy: 0, x: 10, y: 0, pointerType: "keyboard" },
        { dx: 10, dy: 10, x: 10, y: 10, pointerType: "keyboard" },
        { dx: 10, dy: 20, x: 10, y: 20, pointerType: "keyboard" },
      ]);

      key(" ");
      expect(events.end).toEqual([{ dx: 10, dy: 20, pointerType: "keyboard" }]);
      expect(root().hasAttribute("data-grabbed")).toBe(false);
      expect(handle().hasAttribute("data-grabbed")).toBe(false);
    });

    it("yields a key a descendant widget already consumed", async () => {
      // Other widgets yield to a grabbed drag handle, so the handle owes the
      // same courtesy downward. A nested roving list or segmented field inside
      // the handle consumes its own arrows; the drag must not ALSO step.
      const events = await mount(defaultFixture);
      key(" ");
      expect(events.start).toHaveLength(1);

      const inner = document.createElement("span");
      handle().append(inner);
      inner.addEventListener("keydown", (event) => event.preventDefault());
      const claimed = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      const notCanceled = inner.dispatchEvent(claimed);

      expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
      expect(events.move).toHaveLength(0);
    });

    it("leaves a modified arrow to the browser while grabbed", async () => {
      // A chorded arrow belongs to the browser (history navigation and friends):
      // the grab neither consumes it nor accumulates a delta.
      const events = await mount(defaultFixture);
      key(" ");
      expect(events.start).toHaveLength(1);

      const chord = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
        altKey: true,
      });
      handle().dispatchEvent(chord);

      expect(chord.defaultPrevented).toBe(false);
      expect(events.move).toHaveLength(0);
      expect(root().getAttribute("data-grabbed")).toBe("true"); // the grab survives

      key("ArrowRight"); // a bare arrow still moves
      expect(events.move).toHaveLength(1);
    });

    it("grabs and drops with Enter too", async () => {
      const events = await mount(defaultFixture);
      key("Enter");
      expect(events.start).toHaveLength(1);
      key("Enter");
      expect(events.end).toEqual([{ dx: 0, dy: 0, pointerType: "keyboard" }]);
    });

    it("cancels the grab with Escape and clears the hooks", async () => {
      const events = await mount(defaultFixture);
      key(" ");
      key("ArrowRight");
      key("Escape");
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
      expect(events.end).toHaveLength(0);
      expect(root().hasAttribute("data-grabbed")).toBe(false);

      key("ArrowRight"); // no session anymore
      expect(events.move).toHaveLength(1);
    });

    it("scales synthetic moves by keyboardStep", async () => {
      const events = await mount(`
        <ul>
          <li data-controller="stimeo--pointer-drag"
              data-stimeo--pointer-drag-keyboard-step-value="24">
            <button type="button" data-stimeo--pointer-drag-target="handle"
                    aria-label="Reorder">⠿</button>
          </li>
        </ul>`);
      key(" ");
      key("ArrowLeft");
      expect(events.move).toEqual([{ dx: -24, dy: 0, x: -24, y: 0, pointerType: "keyboard" }]);
    });
  });

  describe("disabled", () => {
    it("ignores both pointer and keyboard interactions", async () => {
      const events = await mount(`
        <ul>
          <li data-controller="stimeo--pointer-drag"
              data-stimeo--pointer-drag-disabled-value="true">
            <button type="button" data-stimeo--pointer-drag-target="handle"
                    aria-label="Reorder">⠿</button>
          </li>
        </ul>`);
      pointerDown(100, 100);
      pointerMove(150, 100);
      key(" ");
      expect(events.start).toHaveLength(0);
    });
  });

  describe("handle contract", () => {
    it("derives touch-action from axis and marks it as controller-owned", async () => {
      await mount(`
        <ul>
          <li data-controller="stimeo--pointer-drag"
              data-stimeo--pointer-drag-axis-value="y">
            <button type="button" data-stimeo--pointer-drag-target="handle"
                    aria-label="Reorder">⠿</button>
          </li>
        </ul>`);
      expect(handle().style.touchAction).toBe("pan-x");
      expect(handle().hasAttribute("data-pointer-drag-touch-action")).toBe(true);
    });

    it("never clobbers an authored touch-action", async () => {
      await mount(`
        <ul>
          <li data-controller="stimeo--pointer-drag">
            <button type="button" style="touch-action: manipulation;"
                    data-stimeo--pointer-drag-target="handle" aria-label="Reorder">⠿</button>
          </li>
        </ul>`);
      expect(handle().style.touchAction).toBe("manipulation");
      expect(handle().hasAttribute("data-pointer-drag-touch-action")).toBe(false);
    });

    /** A handle with no native focusability (the tabindex-contract fixture). */
    const nonFocusableFixture = (handleAttrs = "") => `
      <div>
        <div data-controller="stimeo--pointer-drag" aria-label="Drag surface" role="group">
          <div data-stimeo--pointer-drag-target="handle" role="button" ${handleAttrs}
               aria-label="Drag">⠿</div>
        </div>
      </div>`;

    it("establishes tabindex only on a non-focusable handle", async () => {
      await mount(nonFocusableFixture());
      expect(handle().getAttribute("tabindex")).toBe("0");
    });

    it("leaves a natively focusable handle untouched", async () => {
      await mount(defaultFixture);
      expect(handle().hasAttribute("tabindex")).toBe(false);
    });

    it("marks and restores a controller-owned tabindex on disconnect", async () => {
      await mount(nonFocusableFixture());
      expect(handle().getAttribute("tabindex")).toBe("0");
      expect(handle().hasAttribute("data-pointer-drag-tabindex")).toBe(true);

      controller()?.disconnect();
      expect(handle().hasAttribute("tabindex")).toBe(false);
      expect(handle().hasAttribute("data-pointer-drag-tabindex")).toBe(false);
    });

    it("never removes an authored tabindex on disconnect", async () => {
      await mount(nonFocusableFixture('tabindex="0"'));
      expect(handle().hasAttribute("data-pointer-drag-tabindex")).toBe(false);

      controller()?.disconnect();
      expect(handle().getAttribute("tabindex")).toBe("0");
    });

    it("keeps the tabindex of a focused handle at teardown (no blur to body)", async () => {
      await mount(nonFocusableFixture());
      handle().focus();
      expect(document.activeElement).toBe(handle());

      controller()?.disconnect();
      // Stripping tabindex off the focused element would blur it — the user's
      // place outranks reclaiming the controller-owned tab stop.
      expect(handle().getAttribute("tabindex")).toBe("0");
      expect(document.activeElement).toBe(handle());
      // The loan stays recorded: the value is still ours and only the focus kept
      // us from returning it, so a later teardown can still give it back.
      expect(handle().hasAttribute("data-pointer-drag-tabindex")).toBe(true);
    });

    it("leaves a tabindex another owner rewrote (e.g. roving) in place", async () => {
      await mount(nonFocusableFixture());
      expect(handle().hasAttribute("data-pointer-drag-tabindex")).toBe(true);
      // A composed roving list rewrites the value while the marker survives.
      handle().setAttribute("tabindex", "-1");

      controller()?.disconnect();
      expect(handle().getAttribute("tabindex")).toBe("-1");
      expect(handle().hasAttribute("data-pointer-drag-tabindex")).toBe(false);
    });

    it("uses the element itself as the handle when no target is given", async () => {
      const events = await mount(`
        <ul>
          <li data-controller="stimeo--pointer-drag" role="button" aria-label="Card A"></li>
        </ul>`);
      expect(root().getAttribute("tabindex")).toBe("0");
      pointerDown(100, 100);
      pointerMove(110, 100);
      expect(events.start).toHaveLength(1);
    });
  });

  describe("Turbo resilience", () => {
    it("stops tracking and restores the handle on teardown mid-drag (element removed)", async () => {
      const events = await mount(defaultFixture);
      pointerDown(100, 100);
      pointerMove(110, 100);
      expect(events.move).toHaveLength(1);
      expect(handle().hasPointerCapture(1)).toBe(true);

      // Turbo teardown detaches the element before disconnect() runs; an
      // element still in the DOM at disconnect time is an in-page MOVE and
      // deliberately keeps its session.
      const instance = controller();
      const li = root();
      const parent = li.parentElement as HTMLElement;
      li.remove();
      instance?.disconnect();
      parent.appendChild(li);
      expect(root().hasAttribute("data-dragging")).toBe(false);
      // A mid-drag teardown must not orphan the captured pointer on the handle.
      expect(handle().hasPointerCapture(1)).toBe(false);
      expect(handle().style.touchAction).toBe("");
      expect(handle().hasAttribute("data-pointer-drag-touch-action")).toBe(false);

      pointerMove(200, 100);
      key(" ");
      expect(events.move).toHaveLength(1); // teardown is silent and final
      expect(events.start).toHaveLength(1);
      expect(events.cancel).toHaveLength(0);
    });

    it("keeps a keyboard grab alive across an in-page move (disconnect/reconnect)", async () => {
      // A consumer (sortable) re-inserts the element mid-grab; Stimulus then
      // runs disconnect()+connect() on the SAME instance. The grab survives.
      const events = await mount(defaultFixture);
      key(" ");
      expect(events.start).toHaveLength(1);

      const instance = controller();
      instance?.disconnect(); // element still connected = move, not removal
      instance?.connect();
      expect(root().getAttribute("data-grabbed")).toBe("true"); // hook kept

      key("ArrowRight");
      expect(events.move).toHaveLength(1); // session still live
      expect(events.cancel).toHaveLength(0); // and the move never ended it
      key(" ");
      expect(events.end).toHaveLength(1);
    });

    it("tears down a pointer session when disconnect() is NOT followed by a reconnect", async () => {
      // A detach that keeps the element AND its identifier token — an
      // observed-root exit, simulated here by a direct disconnect() — is the
      // ambiguous case the DetachGate probe covers: no connect() follows, so
      // the deferred teardown must fire, release the document tracking
      // listeners, and END the session in `cancel` — the tree (and consumers
      // on it) is still alive. (Token removal is the synchronous fast path —
      // see the same-tick test below.)
      const events = await mount(defaultFixture);
      const abortSpy = vi.spyOn(AbortController.prototype, "abort");
      pointerDown(100, 100);
      pointerMove(110, 100);
      expect(events.move).toHaveLength(1);

      controller()?.disconnect(); // element still connected, no reconnect
      expect(events.cancel).toHaveLength(0); // not yet: an in-page move may follow
      // One microtask is the whole probe window: a reconnect lands within the
      // same mutation batch, so the very next checkpoint must have decided.
      await flushMicrotasks();
      expect(events.cancel).toEqual([{ pointerType: "mouse" }]); // consumers can recover
      expect(abortSpy).toHaveBeenCalled(); // document listeners actually released
      expect(root().hasAttribute("data-dragging")).toBe(false);
      expect(handle().hasAttribute("data-pointer-drag-touch-action")).toBe(false);
      abortSpy.mockRestore();

      document.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 200, clientY: 100, pointerId: 1 }),
      );
      expect(events.move).toHaveLength(1); // and the session stays dead
    });

    it("cancels a keyboard grab when disconnect() is NOT followed by a reconnect", async () => {
      const events = await mount(defaultFixture);
      key(" ");
      expect(events.start).toHaveLength(1);

      controller()?.disconnect(); // element and token kept, no reconnect
      await flushMicrotasks(); // the deferred teardown's microtask
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
      expect(root().hasAttribute("data-grabbed")).toBe(false);
      expect(handle().hasAttribute("data-grabbed")).toBe(false);

      key("ArrowRight");
      key(" ");
      expect(events.move).toHaveLength(0); // session is dead
      expect(events.end).toHaveLength(0);
      expect(events.cancel).toHaveLength(1); // and cancel fired exactly once
    });

    it("ends the session in the same tick when the identifier token is already gone", async () => {
      // A real Turbo morph strips `data-controller` BEFORE Stimulus fires
      // disconnect(): the DetachGate token fast path needs no probe window, so
      // consumers see `cancel` synchronously with the disconnect itself.
      const events = await mount(defaultFixture);
      key(" ");
      expect(events.start).toHaveLength(1);

      const instance = controller();
      root().setAttribute("data-controller", "");
      instance?.disconnect();
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]); // no microtask needed
      await tick(); // Stimulus's own observer-driven disconnect follows the change
      expect(events.cancel).toHaveLength(1); // and the teardown stays single-shot
    });

    it("keeps the teardown silent when the element is re-removed before the microtask", async () => {
      // disconnect() defers (still connected), then the element leaves the DOM
      // and disconnect() runs again in the same task: the immediate teardown
      // must disarm the queued microtask — exactly one teardown, zero cancels
      // (the tree is dead by the time it settles).
      const events = await mount(defaultFixture);
      key(" ");
      expect(events.start).toHaveLength(1);

      const instance = controller();
      const li = root();
      instance?.disconnect(); // element still connected: teardown deferred
      li.remove();
      instance?.disconnect(); // detached now: immediate, silent teardown
      await flushMicrotasks(); // the orphaned microtask must be disarmed
      expect(events.cancel).toHaveLength(0);
      expect(li.hasAttribute("data-grabbed")).toBe(false);
    });

    it("ends the pointer session when its handle is removed mid-drag (no lockout)", async () => {
      const events = await mount(`
        <ul>
          <li data-controller="stimeo--pointer-drag">
            <button type="button" id="h1" aria-label="Reorder A"
                    data-stimeo--pointer-drag-target="handle">⠿</button>
            <button type="button" id="h2" aria-label="Reorder B"
                    data-stimeo--pointer-drag-target="handle">⠿</button>
          </li>
        </ul>`);
      const down = (id: string, pointerId: number) =>
        document
          .querySelector(`#${id}`)
          ?.dispatchEvent(
            new PointerEvent("pointerdown", { clientX: 0, clientY: 0, pointerId, bubbles: true }),
          );
      const move = (id: string, x: number, pointerId: number) =>
        document
          .querySelector(`#${id}`)
          ?.dispatchEvent(
            new PointerEvent("pointermove", { clientX: x, clientY: 0, pointerId, bubbles: true }),
          );

      down("h1", 1);
      move("h1", 10, 1);
      expect(events.start).toHaveLength(1);
      expect(root().getAttribute("data-dragging")).toBe("true");

      // The session's handle leaves the DOM mid-drag: its pointerup can never
      // arrive, so the session must end — not leak and block future drags.
      document.querySelector("#h1")?.remove();
      await delay(20);
      expect(root().hasAttribute("data-dragging")).toBe(false);

      down("h2", 2);
      move("h2", 10, 2);
      expect(events.start).toHaveLength(2); // a fresh drag is possible — no lockout
    });

    it("clears the keyboard grab when its handle is removed mid-grab", async () => {
      const events = await mount(`
        <ul>
          <li data-controller="stimeo--pointer-drag">
            <button type="button" id="h1" aria-label="Reorder A"
                    data-stimeo--pointer-drag-target="handle">⠿</button>
            <button type="button" id="h2" aria-label="Reorder B"
                    data-stimeo--pointer-drag-target="handle">⠿</button>
          </li>
        </ul>`);
      document
        .querySelector("#h1")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      expect(events.start).toHaveLength(1);
      expect(root().getAttribute("data-grabbed")).toBe("true");

      document.querySelector("#h1")?.remove();
      await delay(20);
      expect(root().hasAttribute("data-grabbed")).toBe(false);

      document
        .querySelector("#h2")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      expect(events.start).toHaveLength(2); // a fresh grab is possible — no lockout
    });

    it("clears stale drag hooks a cache restore may have snapshotted", async () => {
      await mount(`
        <ul>
          <li data-controller="stimeo--pointer-drag" data-dragging="true" data-grabbed="true">
            <button type="button" data-stimeo--pointer-drag-target="handle"
                    aria-label="Reorder">⠿</button>
          </li>
        </ul>`);
      expect(root().hasAttribute("data-dragging")).toBe(false);
      expect(root().hasAttribute("data-grabbed")).toBe(false);
    });

    it("cancels the active session when disabled mid-grab", async () => {
      const events = await mount(defaultFixture);
      key(" ");
      expect(events.start).toHaveLength(1);
      const instance = controller();
      if (!instance) throw new Error("controller not connected");
      instance.disabledValue = true;
      instance.disabledValueChanged();
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
      expect(root().hasAttribute("data-grabbed")).toBe(false);
    });
  });

  describe("follow mode", () => {
    const followFixture = `
      <ul>
        <li data-controller="stimeo--pointer-drag"
            data-stimeo--pointer-drag-follow-value="true"
            data-action="demo:reset->stimeo--pointer-drag#reset">
          <span>Card A</span>
          <button type="button" data-stimeo--pointer-drag-target="handle"
                  aria-label="Reorder Card A">⠿</button>
        </li>
      </ul>`;
    const translate = () => root().style.getPropertyValue("translate");

    it("moves the element with the drag and accumulates committed offsets", async () => {
      await mount(followFixture);
      pointerDown(100, 100);
      pointerMove(110, 105);
      expect(translate()).toBe("10px 5px");
      pointerUp();
      expect(translate()).toBe("10px 5px");

      // The next drag's deltas add onto the committed base.
      pointerDown(200, 200);
      pointerMove(205, 210);
      expect(translate()).toBe("15px 15px");
      pointerUp();
      expect(translate()).toBe("15px 15px");
    });

    it("snaps back to the committed position on Escape", async () => {
      await mount(followFixture);
      pointerDown(100, 100);
      pointerMove(110, 110);
      pointerUp();
      expect(translate()).toBe("10px 10px");

      pointerDown(200, 200, 2);
      pointerMove(230, 230, 2);
      expect(translate()).toBe("40px 40px");
      key("Escape");
      expect(translate()).toBe("10px 10px");
    });

    it("follows keyboard moves, commits on drop, and restores on cancel", async () => {
      await mount(followFixture);
      key(" ");
      key("ArrowRight");
      key("ArrowDown");
      expect(translate()).toBe("10px 10px");
      key(" "); // drop commits
      expect(translate()).toBe("10px 10px");

      key(" ");
      key("ArrowLeft");
      expect(translate()).toBe("0px 10px");
      key("Escape");
      expect(translate()).toBe("10px 10px");
    });

    it("returns to the origin when reset() runs, and drags accumulate from there", async () => {
      await mount(followFixture);
      pointerDown(100, 100);
      pointerMove(140, 120);
      pointerUp();
      expect(translate()).toBe("40px 20px");

      root().dispatchEvent(new CustomEvent("demo:reset")); // wired by data-action
      expect(translate()).toBe(""); // the property is removed at the origin

      // The committed base went with it: the next drag starts from zero rather
      // than adding onto the offset reset() just cleared.
      pointerDown(200, 200, 2);
      pointerMove(205, 210, 2);
      expect(translate()).toBe("5px 10px");
      pointerUp(2);
      expect(translate()).toBe("5px 10px");
    });

    it("cancels an in-flight pointer drag when reset() runs", async () => {
      const events = await mount(followFixture);
      pointerDown(100, 100);
      pointerMove(140, 120);
      expect(translate()).toBe("40px 20px");

      root().dispatchEvent(new CustomEvent("demo:reset"));
      // The live session ends the way every other cancel path ends it, carrying
      // the pointer type — a consumer tracking sessions must not be left hanging.
      expect(events.cancel).toEqual([{ pointerType: "mouse" }]);
      expect(translate()).toBe("");
      // The session is over: further pointer movement must not resurrect it.
      pointerMove(180, 160);
      expect(translate()).toBe("");
    });

    it("cancels a keyboard grab when reset() runs, and stays silent when idle", async () => {
      const events = await mount(followFixture);
      key(" ");
      key("ArrowRight");
      expect(root().getAttribute("data-grabbed")).toBe("true");

      root().dispatchEvent(new CustomEvent("demo:reset"));
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
      expect(root().hasAttribute("data-grabbed")).toBe(false);
      expect(translate()).toBe("");

      // Resetting with nothing in flight cancels nothing: there is no session to
      // report the end of.
      root().dispatchEvent(new CustomEvent("demo:reset"));
      expect(events.cancel).toHaveLength(1);
    });

    it("keeps a below-threshold press out of the cancel report when reset() runs", async () => {
      const events = await mount(followFixture);
      pointerDown(100, 100);
      pointerMove(101, 100); // under the 3px threshold: no drag started yet
      expect(events.start).toHaveLength(0);

      root().dispatchEvent(new CustomEvent("demo:reset"));
      // Nothing was ever announced as started, so nothing is announced cancelled.
      expect(events.cancel).toHaveLength(0);
      expect(translate()).toBe("");
    });

    it("keeps the locked axis untouched", async () => {
      await mount(`
        <ul>
          <li data-controller="stimeo--pointer-drag"
              data-stimeo--pointer-drag-follow-value="true"
              data-stimeo--pointer-drag-axis-value="y">
            <button type="button" data-stimeo--pointer-drag-target="handle"
                    aria-label="Reorder">⠿</button>
          </li>
        </ul>`);
      pointerDown(100, 100);
      pointerMove(150, 120);
      expect(translate()).toBe("0px 20px");
    });

    it("resumes accumulating from a previously committed inline offset", async () => {
      // A Turbo cache restore re-serves the inline translate a past session
      // committed; connect() re-reads it as the base instead of jumping to 0.
      await mount(`
        <ul>
          <li data-controller="stimeo--pointer-drag" style="translate: 7px 9px"
              data-stimeo--pointer-drag-follow-value="true">
            <button type="button" data-stimeo--pointer-drag-target="handle"
                    aria-label="Reorder">⠿</button>
          </li>
        </ul>`);
      pointerDown(100, 100);
      pointerMove(110, 100);
      expect(translate()).toBe("17px 9px");
    });

    it("leaves an authored transform untouched (follow owns translate only)", async () => {
      await mount(`
        <ul>
          <li data-controller="stimeo--pointer-drag" style="transform: scale(1.5)"
              data-stimeo--pointer-drag-follow-value="true">
            <button type="button" data-stimeo--pointer-drag-target="handle"
                    aria-label="Reorder">⠿</button>
          </li>
        </ul>`);
      pointerDown(100, 100);
      pointerMove(110, 105);
      expect(root().style.transform).toBe("scale(1.5)");
      expect(translate()).toBe("10px 5px");
    });

    it("snaps back when disabled mid-drag (the cancel contract)", async () => {
      await mount(followFixture);
      pointerDown(100, 100);
      pointerMove(130, 100);
      expect(translate()).toBe("30px 0px");
      const instance = controller();
      if (!instance) throw new Error("controller not connected");
      instance.disabledValue = true;
      instance.disabledValueChanged();
      expect(translate()).toBe("");
    });

    it("does not touch styles without the opt-in", async () => {
      await mount(defaultFixture);
      pointerDown(100, 100);
      pointerMove(110, 105);
      pointerUp();
      expect(root().getAttribute("style")).toBeNull();
    });
  });

  it("ignores Space / Enter / arrows raised during an IME composition", async () => {
    // A press that steers a conversion belongs to the composition, not to the drag.
    const events = await mount(defaultFixture);
    const composing = (k: string) =>
      handle().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: k,
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );

    composing(" ");
    composing("Enter");
    expect(events.start).toHaveLength(0);

    key(" "); // a real grab, so the arrow branch is reachable
    expect(events.start).toHaveLength(1);
    composing("ArrowRight");
    expect(events.move).toHaveLength(0);
  });

  it("cancels a keyboard grab when the handle leaves the element", async () => {
    const events = await mount(defaultFixture);
    key(" ");
    expect(events.start).toHaveLength(1);

    handle().remove();
    await delay(20);
    expect(events.cancel).toHaveLength(1);
    expect(root().hasAttribute("data-grabbed")).toBe(false);
  });

  it("cancels a pointer drag when the handle leaves the element", async () => {
    const events = await mount(defaultFixture);
    pointerDown(0, 0);
    pointerMove(30, 30);
    expect(events.start).toHaveLength(1);

    handle().remove();
    await delay(20);
    expect(events.cancel).toEqual([{ pointerType: "mouse" }]);
    expect(root().hasAttribute("data-dragging")).toBe(false);
  });

  it("keeps the tabindex loan across an in-page move of a focused handle", async () => {
    await mount(`
      <ul>
        <li id="src" data-controller="stimeo--pointer-drag">
          <span id="h" data-stimeo--pointer-drag-target="handle">handle</span>
        </li>
        <li id="dst"></li>
      </ul>`);
    const h = document.getElementById("h") as HTMLElement;
    expect(h.getAttribute("tabindex")).toBe("0");
    expect(h.hasAttribute("data-pointer-drag-tabindex")).toBe(true);
    h.focus();

    const li = document.getElementById("src") as HTMLElement;
    (document.querySelector("ul") as HTMLElement).appendChild(li); // in-page move
    h.focus(); // the composer re-focuses synchronously, as sortable does
    await delay(20);
    // The loan must survive the move, or the borrowed tabindex is never returned.
    expect(h.hasAttribute("data-pointer-drag-tabindex")).toBe(true);
  });

  it("returns an in-flight follow offset before a dead-tree teardown", async () => {
    await mount(`
      <ul>
        <li data-controller="stimeo--pointer-drag"
            data-stimeo--pointer-drag-follow-value="true">
          <button type="button" data-stimeo--pointer-drag-target="handle"
                  aria-label="Reorder">⠿</button>
        </li>
      </ul>`);
    pointerDown(0, 0);
    pointerMove(50, 0);
    const li = root();
    expect(li.style.getPropertyValue("translate")).toBe("50px 0px");

    li.remove(); // the tree dies mid-drag
    await delay(20);
    // Nothing was committed, so the element must not carry the in-flight offset
    // into a later reuse (connect() would read it back as a committed base).
    expect(li.style.getPropertyValue("translate")).toBe("");
  });

  it("hands the handle contract over when the handle set changes at runtime", async () => {
    await mount(`<ul><li data-controller="stimeo--pointer-drag">Card A</li></ul>`);
    const li = root();
    expect(li.getAttribute("tabindex")).toBe("0");
    expect(li.style.touchAction).toBe("none");

    const added = document.createElement("button");
    added.type = "button";
    added.setAttribute("data-stimeo--pointer-drag-target", "handle");
    li.appendChild(added);
    await delay(20);
    // The element is no longer the handle: it gives the contract back.
    expect(li.hasAttribute("tabindex")).toBe(false);
    expect(li.style.touchAction).toBe("");

    added.remove();
    await delay(20);
    // And takes it back when it becomes the handle again.
    expect(li.getAttribute("tabindex")).toBe("0");
    expect(li.style.touchAction).toBe("none");
  });

  it("returns the handle contract when the identifier token is removed", async () => {
    // A morph strips `data-controller` before the teardown runs, and the targets
    // stop resolving with it — so the handles are unreachable from `#handles()`
    // by the time anything sweeps them.
    await mount(`
      <ul>
        <li data-controller="stimeo--pointer-drag">
          <span data-stimeo--pointer-drag-target="handle" role="button"
                aria-label="Reorder">⠿</span>
        </li>
      </ul>`);
    const h = handle();
    expect(h.getAttribute("tabindex")).toBe("0");
    expect(h.style.touchAction).toBe("none");

    root().removeAttribute("data-controller");
    await delay(20);
    expect(h.hasAttribute("tabindex")).toBe(false);
    expect(h.hasAttribute("data-pointer-drag-tabindex")).toBe(false);
    expect(h.style.touchAction).toBe("");
    expect(h.hasAttribute("data-pointer-drag-touch-action")).toBe(false);
  });

  it("returns the handle contract when an element stops being a handle", async () => {
    // The element stays put and the controller lives on, so nothing else will
    // ever sweep it: the loan has to come back here or never.
    await mount(`
      <ul>
        <li data-controller="stimeo--pointer-drag">
          <span id="ex" data-stimeo--pointer-drag-target="handle" role="button"
                aria-label="Reorder">⠿</span>
        </li>
      </ul>`);
    const ex = document.getElementById("ex") as HTMLElement;
    expect(ex.getAttribute("tabindex")).toBe("0");

    ex.removeAttribute("data-stimeo--pointer-drag-target");
    await delay(20);
    expect(ex.hasAttribute("tabindex")).toBe(false);
    expect(ex.hasAttribute("data-pointer-drag-tabindex")).toBe(false);
    expect(ex.style.touchAction).toBe("");
    expect(ex.hasAttribute("data-pointer-drag-touch-action")).toBe(false);
  });

  it("keeps a consumer's touch-action across an in-page move mid-session", async () => {
    const events = await mount(defaultFixture);
    const h = handle();
    key(" ");
    expect(events.start).toHaveLength(1);
    h.style.touchAction = "manipulation"; // the consumer takes the property over

    const li = root();
    (document.querySelector("ul") as HTMLElement).appendChild(li); // in-page move
    h.focus(); // the composer re-focuses synchronously, as sortable does
    await delay(20);
    expect(li.getAttribute("data-grabbed")).toBe("true"); // the session survived
    expect(h.style.touchAction).toBe("manipulation");
  });

  it("keeps a consumer's touch-action across a move when the element is the handle", async () => {
    // Without a handle target the reconnect re-derives from `connect()` itself,
    // and the axis default is replayed ahead of it with no previous value.
    const events = await mount(`<ul><li data-controller="stimeo--pointer-drag">Card A</li></ul>`);
    const li = root();
    key(" ");
    expect(events.start).toHaveLength(1);
    li.style.touchAction = "manipulation";

    (document.querySelector("ul") as HTMLElement).appendChild(li);
    li.focus();
    await delay(20);
    expect(li.getAttribute("data-grabbed")).toBe("true");
    expect(li.style.touchAction).toBe("manipulation");
  });

  it("leaves an authored touch-action alone when the axis changes at runtime", async () => {
    // `none` is also what the default axis lends, so only the ownership marker
    // separates an authored value from a borrowed one here.
    await mount(`
      <ul>
        <li data-controller="stimeo--pointer-drag">
          <button type="button" style="touch-action: none;"
                  data-stimeo--pointer-drag-target="handle" aria-label="Reorder">⠿</button>
        </li>
      </ul>`);
    const h = handle();
    expect(h.hasAttribute("data-pointer-drag-touch-action")).toBe(false);

    root().setAttribute("data-stimeo--pointer-drag-axis-value", "x");
    await delay(20);
    expect(h.style.touchAction).toBe("none");
  });

  it("re-derives nothing from the axis default a reconnect replays", async () => {
    // The replayed default carries no previous axis, so it cannot tell a value
    // this controller lent from one the consumer wrote — even a value the
    // controller could have lent under some other axis.
    const events = await mount(`
      <ul>
        <li data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-axis-value="y">
          Card A
        </li>
      </ul>`);
    const li = root();
    expect(li.style.touchAction).toBe("pan-x");
    key(" ");
    expect(events.start).toHaveLength(1);
    li.style.touchAction = "none"; // the consumer takes the property over

    (document.querySelector("ul") as HTMLElement).appendChild(li); // in-page move
    li.focus();
    await delay(20);
    expect(li.getAttribute("data-grabbed")).toBe("true"); // the session survived
    expect(li.style.touchAction).toBe("none");
  });

  it("never takes back a touch-action the consumer rewrote after marking", async () => {
    await mount(defaultFixture);
    const h = handle();
    expect(h.style.touchAction).toBe("none");
    h.style.touchAction = "manipulation"; // the consumer takes the property over

    root().setAttribute("data-stimeo--pointer-drag-axis-value", "x");
    await delay(20);
    expect(h.style.touchAction).toBe("manipulation");

    root().remove(); // teardown
    await delay(20);
    expect(h.style.touchAction).toBe("manipulation");
  });

  it("leaves Space and the arrows to a native control inside the handle", async () => {
    const events = await mount(`
      <ul>
        <li data-controller="stimeo--pointer-drag">
          <div data-stimeo--pointer-drag-target="handle">
            <input id="field" type="text" aria-label="Rename" />
          </div>
        </li>
      </ul>`);
    const field = document.getElementById("field") as HTMLElement;
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    field.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    expect(events.start).toHaveLength(0);
  });

  it("consumes the presses it acts on and restores the focus it suppressed", async () => {
    // The suppressed default of pointerdown would have focused the handle; the
    // keyboard path (Escape, grab, arrows) only stays reachable if it is restored.
    await mount(defaultFixture);
    expect(pointerDown(0, 0)).toBe(false);
    expect(document.activeElement).toBe(handle());
    expect(key("Escape")).toBe(true); // below the threshold there is nothing to cancel
    pointerMove(30, 30);
    expect(key("Escape")).toBe(false); // and now it cancels the live drag

    expect(key(" ")).toBe(false); // grab
    expect(key("ArrowRight")).toBe(false); // an allowed-axis move
    expect(key("Enter")).toBe(false); // drop
  });

  it("consumes a locked-axis arrow without emitting a move", async () => {
    // The consumption is the point: an unconsumed arrow scrolls the page mid-grab.
    const events = await mount(`
      <ul>
        <li data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-axis-value="x">
          <button type="button" data-stimeo--pointer-drag-target="handle"
                  aria-label="Reorder">⠿</button>
        </li>
      </ul>`);
    key(" ");
    expect(key("ArrowDown")).toBe(false);
    expect(events.move).toHaveLength(0);
  });

  it("reports the pointer type a drag was started with", async () => {
    const events = await mount(defaultFixture);
    handle().dispatchEvent(
      new PointerEvent("pointerdown", {
        clientX: 0,
        clientY: 0,
        pointerId: 1,
        pointerType: "touch",
        bubbles: true,
        cancelable: true,
      }),
    );
    pointerMove(30, 30);
    expect(events.start?.[0]?.pointerType).toBe("touch");
    expect(events.move?.[0]?.pointerType).toBe("touch");
  });

  it("ignores pointer events belonging to another pointer", async () => {
    const events = await mount(defaultFixture);
    pointerDown(0, 0, 1);
    pointerMove(50, 50, 2); // a second finger's move is not this session's
    expect(events.start).toHaveLength(0);
    pointerMove(50, 50, 1);
    expect(events.start).toHaveLength(1);

    pointerUp(2); // nor is its release
    expect(events.end).toHaveLength(0);
    handle().dispatchEvent(new PointerEvent("pointercancel", { pointerId: 2, bubbles: true }));
    expect(events.cancel).toHaveLength(0);
    pointerUp(1);
    expect(events.end).toHaveLength(1);
  });

  it("ignores keys raised outside every handle", async () => {
    const events = await mount(defaultFixture);
    root().dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
    );
    expect(events.start).toHaveLength(0);
  });

  it("leaves a non-arrow key alone while grabbed", async () => {
    const events = await mount(defaultFixture);
    key(" ");
    expect(key("a")).toBe(true); // not ours: no preventDefault, no move
    expect(events.move).toHaveLength(0);
  });

  it("cancels a pointer drag with its own pointer type when disabled mid-drag", async () => {
    const events = await mount(defaultFixture);
    pointerDown(0, 0);
    pointerMove(30, 30);
    root().setAttribute("data-stimeo--pointer-drag-disabled-value", "true");
    await delay(20);
    expect(events.cancel).toEqual([{ pointerType: "mouse" }]);
  });

  it("derives pan-y from axis=x and gives it back on teardown", async () => {
    await mount(`
      <ul>
        <li data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-axis-value="x">
          <button type="button" data-stimeo--pointer-drag-target="handle"
                  aria-label="Reorder">⠿</button>
        </li>
      </ul>`);
    const h = handle();
    expect(h.style.touchAction).toBe("pan-y");
    root().remove();
    await delay(20);
    expect(h.style.touchAction).toBe("");
  });

  it("never touches an authored translate without the follow opt-in", async () => {
    await mount(defaultFixture);
    root().style.setProperty("translate", "7px 7px"); // the consumer's own offset
    pointerDown(0, 0);
    pointerMove(40, 0);
    expect(root().style.getPropertyValue("translate")).toBe("7px 7px");
    const li = root();
    li.remove();
    await delay(20);
    expect(li.style.getPropertyValue("translate")).toBe("7px 7px");
  });

  it("leaves the element bare when the controller goes but the handle stays", async () => {
    // The target callbacks also fire during teardown, with the handle still
    // inside: taking the handle contract back there would bake a nameless tab
    // stop onto the container on every morph.
    await mount(defaultFixture);
    const li = root();
    li.removeAttribute("data-controller");
    await delay(20);
    expect(li.hasAttribute("tabindex")).toBe(false);
    expect(li.style.touchAction).toBe("");
  });

  it("keeps a live grab when disabled is re-declared as false", async () => {
    const events = await mount(defaultFixture);
    key(" ");
    expect(events.start).toHaveLength(1);
    root().setAttribute("data-stimeo--pointer-drag-disabled-value", "false");
    await delay(20);
    expect(root().getAttribute("data-grabbed")).toBe("true");
    key(" ");
    expect(events.end).toHaveLength(1);
  });

  it("stays silent when a handle leaves with no session in flight", async () => {
    const events = await mount(defaultFixture);
    handle().remove();
    await delay(20);
    expect(events.cancel).toHaveLength(0);
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount(`<main>${defaultFixture}</main>`);
    await expectNoA11yViolations(document.body);
  });

  // --- Speech-order regression ------------------------------------------------

  it("keeps the announcement stable across a keyboard grab (data hooks only)", async () => {
    await mount(defaultFixture);
    const container = root().parentElement as HTMLElement;
    const before = await captureSpeech({ container, steps: 3 });
    // Freeze the whole ordered array: the handle stays a plainly named button.
    expect(before).toEqual([
      "list",
      "listitem, level 1, position 1, set size 1",
      "Card A",
      "button, Reorder Card A",
    ]);
    // Grabbing only flips data-* hooks — it must not alter the announcement
    // (the *meaning* of the drag is announced by the consumer via announcer).
    key(" ");
    await tick();
    const after = await captureSpeech({ container, steps: 3 });
    expect(after).toEqual(before);
  });
});
