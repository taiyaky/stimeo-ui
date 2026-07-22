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

  const pointerDown = (x: number, y: number, pointerId = 1) =>
    handle().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: x, clientY: y, pointerId, bubbles: true }),
    );
  const pointerMove = (x: number, y: number, pointerId = 1) =>
    handle().dispatchEvent(
      new PointerEvent("pointermove", { clientX: x, clientY: y, pointerId, bubbles: true }),
    );
  const pointerUp = (pointerId = 1) =>
    handle().dispatchEvent(new PointerEvent("pointerup", { pointerId, bubbles: true }));
  const key = (k: string) =>
    handle().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

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
      expect(handle().hasAttribute("data-pointer-drag-tabindex")).toBe(false);
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
      // deliberately keeps its session (see the move-survival test).
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
            data-stimeo--pointer-drag-follow-value="true">
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

  it("has no machine-detectable a11y violations", async () => {
    await mount(`<main>${defaultFixture}</main>`);
    await expectNoA11yViolations(document.body);
  });

  // --- Layer ③ speech-order regression ---------------------------------------

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
