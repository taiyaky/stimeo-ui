import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataGridController } from "../src/controllers/data_grid_controller";
import { PointerDragController } from "../src/controllers/pointer_drag_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { keyEvent, press, typeKey } from "./helpers/keyboard";
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
    return !press(handle(), k, { bubbles: true, cancelable: true }).defaultPrevented;
  };

  describe("pointer lifecycle", () => {
    it.each(["-1", "NaN", "Infinity"])(
      "uses the default pointer threshold for invalid declaration %s",
      async (raw) => {
        const events = await mount(
          defaultFixture.replace(
            'data-controller="stimeo--pointer-drag"',
            `data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-threshold-value="${raw}"`,
          ),
        );
        pointerDown(100, 100);
        pointerMove(102, 100);
        expect(events.start).toEqual([]);
        expect(root().hasAttribute("data-dragging")).toBe(false);

        pointerMove(103, 100);
        expect(events.start).toEqual([{ x: 103, y: 100, pointerType: "mouse" }]);
        pointerUp();
        expect(events.end).toEqual([{ dx: 3, dy: 0, pointerType: "mouse" }]);
        expect(root().hasAttribute("data-dragging")).toBe(false);
      },
    );

    it("preserves a valid fractional pointer threshold", async () => {
      const events = await mount(
        defaultFixture.replace(
          'data-controller="stimeo--pointer-drag"',
          'data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-threshold-value="0.5"',
        ),
      );
      pointerDown(100, 100);
      pointerMove(100.25, 100);
      expect(events.start).toEqual([]);
      pointerMove(100.5, 100);
      expect(events.start).toEqual([{ x: 100.5, y: 100, pointerType: "mouse" }]);
      pointerUp();
      expect(events.end).toEqual([{ dx: 0.5, dy: 0, pointerType: "mouse" }]);
    });

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

    it("keeps tracking the drag when the handle loses pointer capture", async () => {
      const events = await mount(defaultFixture);
      pointerDown(100, 100);
      pointerMove(110, 100);

      // Capture is delivery, not lifetime: a consumer re-inserting the dragged
      // element releases it, and the document listeners keep the same finger.
      handle().dispatchEvent(
        new PointerEvent("lostpointercapture", { pointerId: 1, bubbles: true }),
      );
      pointerMove(130, 100);
      expect(events.move).toHaveLength(2);
      expect(events.cancel).toHaveLength(0);

      pointerUp();
      expect(events.end).toEqual([{ dx: 30, dy: 0, pointerType: "mouse" }]);
    });

    it("never reports an end from a teardown path", async () => {
      const events = await mount(defaultFixture);
      pointerDown(100, 100);
      pointerMove(110, 100);
      key("Escape");

      pointerDown(100, 100);
      pointerMove(110, 100);
      const instance = controller();
      if (!instance) throw new Error("controller not connected");
      instance.disabledValue = true;
      instance.disabledValueChanged();

      expect(events.cancel).toEqual([{ pointerType: "mouse" }, { pointerType: "mouse" }]);
      expect(events.end).toHaveLength(0);
    });

    it("keeps the drag alive on an Escape that cancels an IME composition", async () => {
      const events = await mount(defaultFixture);
      pointerDown(100, 100);
      pointerMove(110, 100);
      // Widget-local half of the shared layered-Escape contract: a composing
      // press steers the IME conversion and never cancels the session.
      press(handle(), "Escape", { bubbles: true, isComposing: true });
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

    it("arms the drag when the environment refuses pointer capture", async () => {
      const events = await mount(defaultFixture);
      handle().setPointerCapture = vi.fn(() => {
        throw new DOMException("Pointer is no longer active", "NotFoundError");
      });

      pointerDown(100, 100);
      pointerMove(110, 100);
      expect(events.start).toHaveLength(1);
      expect(root().getAttribute("data-dragging")).toBe("true");
    });

    it("keeps the keyboard path reachable when pointer capture is refused", async () => {
      const events = await mount(defaultFixture);
      handle().setPointerCapture = vi.fn(() => {
        throw new DOMException("Pointer is no longer active", "NotFoundError");
      });

      pointerDown(100, 100);
      pointerUp();
      key(" ");
      expect(root().getAttribute("data-grabbed")).toBe("true");
      expect(events.start).toEqual([{ x: 0, y: 0, pointerType: "keyboard" }]);
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

  describe("keyboard focus ownership", () => {
    const focusFixture = `
      <div data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-follow-value="true"
           style="translate: 20px 30px">
        <div id="first-handle" data-stimeo--pointer-drag-target="handle">
          <span id="surface" tabindex="-1">Handle surface</span>
          <input id="field" aria-label="Rename">
        </div>
        <button id="second-handle" data-stimeo--pointer-drag-target="handle">Second handle</button>
      </div>
      <button id="outside">Outside</button>`;
    const outside = () => document.getElementById("outside") as HTMLElement;

    it.each([false, true])(
      "yields Tab (shift=%s) and cancels after actual focus departure",
      async (shiftKey) => {
        const events = await mount(focusFixture);
        press(handle(), " ");
        press(handle(), "ArrowRight");
        expect(root().style.translate).toBe("30px 30px");
        const focusout = vi.fn();
        handle().addEventListener("focusout", focusout);
        expect(press(handle(), "Tab", { shiftKey }).defaultPrevented).toBe(false);
        // happy-dom has no Tab default; focus() supplies the actual departure.
        outside().focus();
        expect(focusout).toHaveBeenCalledOnce();
        expect(events.cancel).toEqual([]);
        await flushMicrotasks();
        expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
        expect(events.end).toEqual([]);
        expect(root().hasAttribute("data-grabbed")).toBe(false);
        expect(handle().hasAttribute("data-grabbed")).toBe(false);
        expect(root().style.translate).toBe("20px 30px");
        expect(document.activeElement).toBe(outside());
        expect(handle().style.touchAction).toBe("none");
        expect(handle().tabIndex).toBe(0);
        press(handle(), " ");
        expect(events.start).toHaveLength(2);
      },
    );

    it("cancels when blur leaves the body focused and relatedTarget is null", async () => {
      const events = await mount(focusFixture);
      press(handle(), " ");
      const departures: FocusEvent[] = [];
      handle().addEventListener("focusout", (event) => departures.push(event as FocusEvent));
      handle().blur();
      expect(document.activeElement).toBe(document.body);
      expect(departures).toHaveLength(1);
      expect(departures[0]?.relatedTarget).toBeNull();
      await flushMicrotasks();
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
      expect(document.activeElement).toBe(document.body);
    });

    it.each(["second-handle", "field"])(
      "cancels after focus moves to %s inside the root",
      async (id) => {
        const events = await mount(focusFixture);
        press(handle(), " ");
        const destination = document.getElementById(id) as HTMLElement;
        destination.focus();
        await flushMicrotasks();
        expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
        expect(document.activeElement).toBe(destination);
        expect(root().hasAttribute("data-grabbed")).toBe(false);
        if (id === "field") {
          expect(press(destination, " ").defaultPrevented).toBe(false);
          expect(press(destination, "ArrowRight").defaultPrevented).toBe(false);
        }
      },
    );

    it("keeps the same handle's non-native surface, then cancels when that surface leaves", async () => {
      const events = await mount(focusFixture);
      press(handle(), " ");
      const surface = document.getElementById("surface") as HTMLElement;
      surface.focus();
      await flushMicrotasks();
      expect(events.cancel).toEqual([]);
      press(surface, "ArrowRight");
      expect(events.move).toHaveLength(1);
      outside().focus();
      await flushMicrotasks();
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
    });

    it.each(["input", "surface"])(
      "resolves a focused open shadow %s within the handle",
      async (kind) => {
        const events = await mount(focusFixture);
        const host = document.createElement("span");
        handle().append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML =
          kind === "input" ? '<input aria-label="Rename" />' : '<span tabindex="0">Surface</span>';
        const child = shadow.firstElementChild as HTMLElement;
        press(handle(), " ");
        press(handle(), "ArrowRight");
        child.focus();
        await flushMicrotasks();
        expect(shadow.activeElement).toBe(child);
        expect(root().hasAttribute("data-grabbed")).toBe(kind !== "input");
        if (kind === "input") {
          expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
          expect(root().style.translate).toBe("20px 30px");
          expect(press(child, "ArrowRight", { composed: true }).defaultPrevented).toBe(false);
          expect(press(child, " ", { composed: true }).defaultPrevented).toBe(false);
          expect(events.start).toHaveLength(1);
          expect(events.move).toHaveLength(1);
        } else {
          expect(events.cancel).toEqual([]);
          // The browser retargets an internal shadow key to its host at the root listener.
          expect(typeKey(host, "ArrowRight").defaultPrevented).toBe(true);
          expect(events.move).toHaveLength(2);
        }
      },
    );

    it.each([false, true])(
      "observes a native focus move within one open shadow root (grab inside: %s)",
      async (grabInside) => {
        const events = await mount(focusFixture);
        const host = document.createElement("span");
        handle().append(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = '<span tabindex="0">Surface</span><input aria-label="Rename" />';
        const surface = shadow.firstElementChild as HTMLElement;
        const input = shadow.lastElementChild as HTMLInputElement;
        const outerFocus = vi.fn();
        root().addEventListener("focusin", outerFocus);
        if (!grabInside) press(handle(), " ");
        surface.focus();
        await flushMicrotasks();
        expect(outerFocus).toHaveBeenCalled();
        if (grabInside) typeKey(host, " ");
        expect(root().getAttribute("data-grabbed")).toBe("true");
        outerFocus.mockClear();
        // Retargeting trims a same-root focus pair before it reaches the host's ancestors.
        host.addEventListener("focusin", (event) => event.stopPropagation());
        host.addEventListener("focusout", (event) => event.stopPropagation());
        input.focus();
        await flushMicrotasks();
        expect(shadow.activeElement).toBe(input);
        expect(outerFocus).not.toHaveBeenCalled();
        expect(root().hasAttribute("data-grabbed")).toBe(false);
        expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
        expect(press(input, "ArrowRight", { composed: true }).defaultPrevented).toBe(false);
        expect(events.move).toEqual([]);
      },
    );

    it("releases shadow focus subscriptions on cancel and reconnects a preserved grab", async () => {
      const events = await mount(focusFixture);
      const host = document.createElement("span");
      handle().append(host);
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = '<span tabindex="0">Surface</span><input aria-label="Rename" />';
      const surface = shadow.firstElementChild as HTMLElement;
      const input = shadow.lastElementChild as HTMLInputElement;
      const subscribe = vi.spyOn(shadow, "addEventListener");
      surface.focus();
      typeKey(host, " ");
      const focusSignal = () => {
        const registration = subscribe.mock.calls
          .slice()
          .reverse()
          .find(([type]) => type === "focusin");
        const signal = (registration?.[2] as AddEventListenerOptions | undefined)?.signal;
        if (!signal) throw new Error("shadow focus subscription missing");
        return signal;
      };
      const initial = focusSignal();
      expect(initial.aborted).toBe(false);
      typeKey(host, "Escape");
      expect(initial.aborted).toBe(true);
      expect(events.cancel).toHaveLength(1);
      typeKey(host, " ");
      const carried = focusSignal();
      expect(carried.aborted).toBe(false);
      const instance = controller();
      instance?.disconnect();
      expect(carried.aborted).toBe(true);
      instance?.connect();
      const reconnected = focusSignal();
      expect(reconnected).not.toBe(carried);
      expect(reconnected.aborted).toBe(false);
      // Only the shadow-local subscription sees a focus pair trimmed at the host.
      host.addEventListener("focusin", (event) => event.stopPropagation());
      host.addEventListener("focusout", (event) => event.stopPropagation());
      input.focus();
      await flushMicrotasks();
      expect(events.cancel).toHaveLength(2);
      expect(root().hasAttribute("data-grabbed")).toBe(false);
      expect(reconnected.aborted).toBe(true);
    });

    it("keeps a grab after synchronous blur and refocus of the same handle", async () => {
      const events = await mount(focusFixture);
      press(handle(), " ");
      handle().blur();
      expect(document.activeElement).toBe(document.body);
      handle().focus();
      await flushMicrotasks();
      expect(events.cancel).toEqual([]);
      expect(root().getAttribute("data-grabbed")).toBe("true");
      press(handle(), "ArrowRight");
      expect(events.move).toHaveLength(1);
    });

    it("keeps a same-handle relatedTarget before the destination receives focus", async () => {
      const events = await mount(focusFixture);
      press(handle(), " ");
      const grabbed = handle();
      const surface = document.getElementById("surface") as HTMLElement;
      // The focusout checkpoint precedes focusin during a browser-driven focus move.
      grabbed.addEventListener("focusout", (event) => event.stopPropagation(), { once: true });
      grabbed.blur();
      expect(document.activeElement).toBe(document.body);
      grabbed.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: surface }));
      await flushMicrotasks();
      expect(events.cancel).toEqual([]);
      expect(root().getAttribute("data-grabbed")).toBe("true");
      surface.focus();
      press(surface, "ArrowRight");
      expect(events.move).toHaveLength(1);
      outside().focus();
      await flushMicrotasks();
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
      expect(document.activeElement).toBe(outside());
    });

    it.each(["open", "closed"] as const)(
      "reads settled focus inside a %s shadow tree where the controller is mounted",
      async (mode) => {
        await mount(`<div id="shadow-host"></div><button id="outside">Outside</button>`);
        disconnectAndStopApplication(application);
        const host = document.getElementById("shadow-host") as HTMLElement;
        const shadow = host.attachShadow({ mode });
        shadow.innerHTML = `<div id="scope">
          <div data-controller="stimeo--pointer-drag">
            <button data-stimeo--pointer-drag-target="handle">Handle</button>
          </div>
        </div>`;
        const scope = shadow.getElementById("scope");
        const element = shadow.querySelector<HTMLElement>("[data-controller]");
        const grabbed = shadow.querySelector<HTMLElement>("button");
        if (!scope || !element || !grabbed) throw new Error("shadow fixture not mounted");
        application = Application.start(scope);
        application.register("stimeo--pointer-drag", PointerDragController);
        await tick();
        const cancellations = vi.fn();
        const moves = vi.fn();
        element.addEventListener("stimeo--pointer-drag:cancel", cancellations);
        element.addEventListener("stimeo--pointer-drag:move", moves);
        press(grabbed, " ");
        grabbed.blur();
        grabbed.focus();
        expect(document.activeElement).toBe(host);
        expect(shadow.activeElement).toBe(grabbed);
        await flushMicrotasks();
        expect(cancellations).not.toHaveBeenCalled();
        expect(element.getAttribute("data-grabbed")).toBe("true");
        press(grabbed, "ArrowRight");
        expect(moves).toHaveBeenCalledOnce();
        outside().focus();
        await flushMicrotasks();
        expect(cancellations).toHaveBeenCalledOnce();
        expect(element.hasAttribute("data-grabbed")).toBe(false);
        expect(document.activeElement).toBe(outside());
      },
    );

    it("does not cancel from an artificial focusout while the handle still holds focus", async () => {
      const events = await mount(focusFixture);
      press(handle(), " ");
      handle().dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: outside() }),
      );
      await flushMicrotasks();
      expect(events.cancel).toEqual([]);
      expect(root().getAttribute("data-grabbed")).toBe("true");
    });

    it("cancels a new grab after an idle descendant focus change in the same turn", async () => {
      const events = await mount(focusFixture);
      const second = document.getElementById("second-handle") as HTMLElement;
      second.focus();
      handle().focus();
      press(handle(), " ");
      press(handle(), "ArrowRight");
      outside().focus();
      expect(document.activeElement).toBe(outside());
      expect(events.cancel).toEqual([]);
      await flushMicrotasks();
      expect(events.start).toHaveLength(1);
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
      expect(events.end).toEqual([]);
      expect(root().hasAttribute("data-grabbed")).toBe(false);
      expect(root().style.translate).toBe("20px 30px");
      expect(document.activeElement).toBe(outside());
    });

    it("keeps a grab across synchronous descendant focus changes that return to its handle", async () => {
      const events = await mount(focusFixture);
      press(handle(), " ");
      const second = document.getElementById("second-handle") as HTMLElement;
      const field = document.getElementById("field") as HTMLElement;
      second.focus();
      field.focus();
      handle().focus();
      await flushMicrotasks();
      expect(events.cancel).toEqual([]);
      expect(root().getAttribute("data-grabbed")).toBe("true");
      expect(document.activeElement).toBe(handle());
      press(handle(), "ArrowRight");
      expect(events.move).toHaveLength(1);
      expect(root().style.translate).toBe("30px 30px");
      outside().focus();
      await flushMicrotasks();
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
      expect(root().style.translate).toBe("20px 30px");
      expect(document.activeElement).toBe(outside());
    });

    it("does not let a completed session's focus probe end a newly created session", async () => {
      const events = await mount(focusFixture);
      press(handle(), " ");
      outside().focus();
      // Unfocused delivery isolates the stale probe from any new focusout.
      typeKey(handle(), "Enter");
      typeKey(handle(), " ");
      await flushMicrotasks();
      expect(events.end).toHaveLength(1);
      expect(events.start).toHaveLength(2);
      expect(events.cancel).toEqual([]);
      expect(root().getAttribute("data-grabbed")).toBe("true");
      handle().focus();
      outside().focus();
      await flushMicrotasks();
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
    });

    it("checks a new session's own departure while an old session's probe is queued", async () => {
      const events = await mount(focusFixture);
      press(handle(), " ");
      outside().focus();
      press(handle(), "Enter");
      press(handle(), " ");
      outside().focus();
      expect(events.cancel).toEqual([]);
      await flushMicrotasks();
      expect(events.start).toHaveLength(2);
      expect(events.end).toHaveLength(1);
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
      expect(root().hasAttribute("data-grabbed")).toBe(false);
      expect(document.activeElement).toBe(outside());
    });

    it.each(["drop", "Escape", "disabled", "disconnect", "removed handle"])(
      "ends once when a queued departure competes with %s",
      async (outcome) => {
        const events = await mount(focusFixture);
        press(handle(), " ");
        outside().focus();
        const instance = controller();
        if (!instance) throw new Error("controller not connected");
        if (outcome === "drop") {
          // End the unfocused old session before its departure probe runs.
          typeKey(handle(), "Enter");
        } else if (outcome === "Escape") {
          // The cancellation is deliberately delivered before the focus probe.
          typeKey(handle(), "Escape");
        } else if (outcome === "disabled") {
          instance.disabledValue = true;
          instance.disabledValueChanged();
        } else if (outcome === "disconnect") {
          instance.disconnect();
        } else {
          const departed = handle();
          departed.remove();
          instance.handleTargetDisconnected(departed);
        }
        await flushMicrotasks();
        expect(events.cancel).toEqual(outcome === "drop" ? [] : [{ pointerType: "keyboard" }]);
        expect(events.end).toHaveLength(outcome === "drop" ? 1 : 0);
        expect(root().hasAttribute("data-grabbed")).toBe(false);
        expect(document.activeElement).toBe(outside());
      },
    );

    it("rechecks a preserved session's focus on reconnect without reviving an old probe", async () => {
      const events = await mount(focusFixture);
      press(handle(), " ");
      outside().focus();
      const instance = controller();
      instance?.disconnect();
      instance?.connect();
      expect(events.cancel).toEqual([]);
      await flushMicrotasks();
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
      expect(document.activeElement).toBe(outside());
    });

    it("discards the old connection's probe before a queued focus restoration on reconnect", async () => {
      const events = await mount(focusFixture);
      press(handle(), " ");
      press(handle(), "ArrowRight");
      const grabbed = handle();
      const instance = controller();
      if (!instance) throw new Error("controller not connected");
      outside().focus();
      instance.disconnect();
      // The carried handle regains focus between the old and reconnected checks.
      queueMicrotask(() => grabbed.focus());
      instance.connect();
      expect(document.activeElement).toBe(outside());
      await flushMicrotasks();
      expect(document.activeElement).toBe(grabbed);
      expect(events.cancel).toEqual([]);
      expect(root().getAttribute("data-grabbed")).toBe("true");
      expect(root().style.translate).toBe("30px 30px");
      press(grabbed, "ArrowRight");
      expect(events.move).toHaveLength(2);
      expect(root().style.translate).toBe("40px 30px");
      press(grabbed, "Enter");
      expect(events.end).toEqual([{ dx: 20, dy: 0, pointerType: "keyboard" }]);
    });

    it("keeps one input listener across repeated connect and releases it on disconnect", async () => {
      const events = await mount(focusFixture);
      const instance = controller();
      if (!instance) throw new Error("controller not connected");
      instance.connect();
      instance.connect();
      press(handle(), " ");
      press(handle(), "ArrowRight");
      expect(events.start).toHaveLength(1);
      expect(events.move).toHaveLength(1);
      instance.disconnect();
      instance.connect();
      await flushMicrotasks();
      expect(events.cancel).toEqual([]);
      press(handle(), "Enter");
      expect(events.end).toHaveLength(1);
      pointerDown(0, 0);
      pointerMove(10, 0);
      expect(events.start).toHaveLength(2);
      pointerUp();
      instance.disconnect();
      press(handle(), " ");
      pointerDown(0, 0);
      pointerMove(20, 0);
      outside().focus();
      await flushMicrotasks();
      expect(events.start).toHaveLength(2);
      expect(events.move).toHaveLength(2);
      expect(events.cancel).toEqual([]);
    });

    it("cancels after the element itself loses focus when no handle target is declared", async () => {
      const events = await mount(`
        <div data-controller="stimeo--pointer-drag">Handle</div>
        <button id="outside">Outside</button>`);
      press(root(), " ");
      outside().focus();
      await flushMicrotasks();
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
      expect(root().hasAttribute("data-grabbed")).toBe(false);
      expect(document.activeElement).toBe(outside());
    });

    it("keeps a queued focus departure silent when the tree detaches", async () => {
      const events = await mount(focusFixture);
      press(handle(), " ");
      press(handle(), "ArrowRight");
      const element = root();
      const grabbed = handle();
      const cancellations = vi.fn();
      element.addEventListener("stimeo--pointer-drag:cancel", cancellations);
      await flushMicrotasks();
      outside().focus();
      element.remove();
      await flushMicrotasks();
      expect(cancellations).not.toHaveBeenCalled();
      expect(events.cancel).toEqual([]);
      expect(events.end).toEqual([]);
      expect(element.hasAttribute("data-grabbed")).toBe(false);
      expect(grabbed.hasAttribute("data-grabbed")).toBe(false);
      expect(element.style.translate).toBe("20px 30px");
    });

    it("clears the departing session before a cancel listener starts another gesture", async () => {
      const events = await mount(focusFixture);
      let restarted = false;
      root().addEventListener("stimeo--pointer-drag:cancel", () => {
        if (restarted) return;
        restarted = true;
        press(handle(), " ");
      });
      press(handle(), " ");
      outside().focus();
      await flushMicrotasks();
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
      expect(events.start).toHaveLength(2);
      expect(root().getAttribute("data-grabbed")).toBe("true");
      press(handle(), "ArrowRight");
      expect(events.move).toHaveLength(1);
    });

    it("keeps pointer capture and document tracking when focus leaves a pointer drag", async () => {
      const events = await mount(focusFixture);
      pointerDown(0, 0);
      pointerMove(10, 0);
      outside().focus();
      await flushMicrotasks();
      expect(events.cancel).toEqual([]);
      expect(handle().hasPointerCapture(1)).toBe(true);
      document.dispatchEvent(new PointerEvent("pointermove", { clientX: 20, pointerId: 1 }));
      expect(events.move).toHaveLength(2);
      pointerUp();
      expect(events.end).toEqual([{ dx: 20, dy: 0, pointerType: "mouse" }]);
      expect(handle().hasPointerCapture(1)).toBe(false);
      expect(document.activeElement).toBe(outside());
    });

    it("yields Ctrl+Home to an ancestor Grid and cancels after its focus move", async () => {
      const events = await mount(`
        <div data-controller="stimeo--data-grid" role="grid" aria-label="Cards">
          <div role="row" data-stimeo--data-grid-target="row">
            <div id="first-cell" role="gridcell" tabindex="0" data-stimeo--data-grid-target="cell"
                 data-action="keydown->stimeo--data-grid#onKeydown">First</div>
          </div>
          <div role="row" data-stimeo--data-grid-target="row">
            <div role="gridcell" tabindex="-1" data-stimeo--data-grid-target="cell"
                 data-action="keydown->stimeo--data-grid#onKeydown">
              <div data-controller="stimeo--pointer-drag">
                <div data-stimeo--pointer-drag-target="handle">Last handle</div>
              </div>
            </div>
          </div>
        </div>`);
      application.register("stimeo--data-grid", DataGridController);
      await tick();
      press(handle(), " ");
      const jump = press(handle(), "Home", { ctrlKey: true });
      expect(jump.defaultPrevented).toBe(true);
      const first = document.getElementById("first-cell");
      expect(document.activeElement).toBe(first);
      expect(events.cancel).toEqual([]);
      await flushMicrotasks();
      expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
      expect(document.activeElement).toBe(first);
      expect(root().hasAttribute("data-grabbed")).toBe(false);
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
      inner.tabIndex = -1;
      handle().append(inner);
      inner.addEventListener("keydown", (event) => event.preventDefault());
      const claimed = keyEvent("ArrowRight", { bubbles: true, cancelable: true });
      const notCanceled = !press(inner, claimed).defaultPrevented;

      expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
      expect(events.move).toHaveLength(0);
    });

    it("leaves a modified arrow to the browser while grabbed", async () => {
      // A chorded arrow belongs to the browser (history navigation and friends):
      // the grab neither consumes it nor accumulates a delta.
      const events = await mount(defaultFixture);
      key(" ");
      expect(events.start).toHaveLength(1);

      const chord = keyEvent("ArrowRight", { bubbles: true, cancelable: true, altKey: true });
      press(handle(), chord);

      expect(chord.defaultPrevented).toBe(false);
      expect(events.move).toHaveLength(0);
      expect(root().getAttribute("data-grabbed")).toBe("true"); // the grab survives

      key("ArrowRight"); // a bare arrow still moves
      expect(events.move).toHaveLength(1);
    });

    it("consumes bare Home and End while grabbed so nothing else can take focus", async () => {
      // Bare jumps preserve the grabbed handle's focus without emitting a move.
      const events = await mount(defaultFixture);
      press(handle(), " ");
      expect(events.start).toHaveLength(1);

      for (const jump of ["Home", "End"]) {
        const event = press(handle(), jump);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(events.move).toHaveLength(0); // consumed, but nothing moves
      expect(handle().getAttribute("data-grabbed")).toBe("true");

      const cancelled = press(handle(), "Escape");
      expect(cancelled.defaultPrevented).toBe(true);
      expect(events.cancel).toHaveLength(1);
    });

    it("leaves Home and End alone when nothing is grabbed", async () => {
      await mount(defaultFixture);
      for (const jump of ["Home", "End"]) {
        expect(press(handle(), jump).defaultPrevented).toBe(false);
      }
    });

    it.each([
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { ctrlKey: true, shiftKey: true },
      { altKey: true, ctrlKey: true, metaKey: true, shiftKey: true },
    ])("yields modified Home and End without ending a focused grab (%j)", async (modifiers) => {
      const events = await mount(defaultFixture);
      press(handle(), " ");
      for (const jump of ["Home", "End"]) {
        expect(press(handle(), jump, modifiers).defaultPrevented).toBe(false);
        await flushMicrotasks();
        expect(document.activeElement).toBe(handle());
        expect(root().getAttribute("data-grabbed")).toBe("true");
      }
      expect(events.move).toEqual([]);
      expect(events.cancel).toEqual([]);
      press(handle(), "ArrowRight");
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

    it.each([
      ["-2", 10],
      ["0", 10],
      ["NaN", 10],
      ["Infinity", 10],
      ["0.5", 0.5],
    ])("uses a valid keyboard distance for keyboardStep %s", async (raw, expected) => {
      const events = await mount(
        defaultFixture.replace(
          'data-controller="stimeo--pointer-drag"',
          `data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-keyboard-step-value="${raw}"`,
        ),
      );
      key(" ");
      key("ArrowRight");
      expect(events.move).toEqual([
        { dx: expected, dy: 0, x: expected, y: 0, pointerType: "keyboard" },
      ]);
      key(" ");
      expect(events.end).toEqual([{ dx: expected, dy: 0, pointerType: "keyboard" }]);
      expect(root().hasAttribute("data-grabbed")).toBe(false);
      expect(document.activeElement).toBe(handle());
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

    it("returns a formerly focused handle after it leaves the target set", async () => {
      await mount(nonFocusableFixture());
      const former = handle();
      former.focus();
      former.removeAttribute("data-stimeo--pointer-drag-target");
      controller()?.handleTargetDisconnected(former);
      expect(former.getAttribute("tabindex")).toBe("0");
      root().setAttribute("tabindex", "-1");
      root().focus();
      controller()?.disconnect();
      expect(former.hasAttribute("tabindex")).toBe(false);
    });

    it("takes over a restored loan record without treating it as authored tabindex", async () => {
      await mount(nonFocusableFixture('tabindex="0" data-stimeo--pointer-drag-tabindex-loan="0"'));
      controller()?.disconnect();
      expect(handle().hasAttribute("tabindex")).toBe(false);
      expect(handle().hasAttribute("data-stimeo--pointer-drag-tabindex-loan")).toBe(false);
    });

    it("protects a focused handle inside an open shadow root", async () => {
      await mount(nonFocusableFixture());
      const host = document.createElement("div");
      root().append(host);
      const shadow = host.attachShadow({ mode: "open" });
      const inner = document.createElement("div");
      shadow.append(inner);
      controller()?.handleTargetConnected(inner);
      inner.focus();
      expect(shadow.activeElement).toBe(inner);
      controller()?.handleTargetDisconnected(inner);
      expect(inner.getAttribute("tabindex")).toBe("0");
      expect(shadow.activeElement).toBe(inner);
      handle().focus();
      controller()?.disconnect();
      expect(inner.hasAttribute("tabindex")).toBe(false);
    });

    it("leaves a natively focusable handle untouched", async () => {
      await mount(defaultFixture);
      expect(handle().hasAttribute("tabindex")).toBe(false);
    });

    it("marks and restores a controller-owned tabindex on disconnect", async () => {
      await mount(nonFocusableFixture());
      expect(handle().getAttribute("tabindex")).toBe("0");
      expect(handle().hasAttribute("data-stimeo--pointer-drag-tabindex-loan")).toBe(true);

      controller()?.disconnect();
      expect(handle().hasAttribute("tabindex")).toBe(false);
      expect(handle().hasAttribute("data-stimeo--pointer-drag-tabindex-loan")).toBe(false);
    });

    it("never removes an authored tabindex on disconnect", async () => {
      await mount(nonFocusableFixture('tabindex="0"'));
      expect(handle().hasAttribute("data-stimeo--pointer-drag-tabindex-loan")).toBe(false);

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
      expect(handle().hasAttribute("data-stimeo--pointer-drag-tabindex-loan")).toBe(true);
    });

    it("leaves a tabindex another owner rewrote (e.g. roving) in place", async () => {
      await mount(nonFocusableFixture());
      expect(handle().hasAttribute("data-stimeo--pointer-drag-tabindex-loan")).toBe(true);
      // A composed roving list rewrites the value while the marker survives.
      handle().setAttribute("tabindex", "-1");

      controller()?.disconnect();
      expect(handle().getAttribute("tabindex")).toBe("-1");
      expect(handle().hasAttribute("data-stimeo--pointer-drag-tabindex-loan")).toBe(false);
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

    it("arms no drag from a pointerdown once disconnected", async () => {
      const events = await mount(defaultFixture);
      controller()?.disconnect();

      expect(pointerDown(100, 100)).toBe(true);
      pointerMove(120, 100);

      expect(events.start).toHaveLength(0);
      expect(root().hasAttribute("data-dragging")).toBe(false);
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
      press(document.querySelector<HTMLElement>("#h1") as HTMLElement, " ", { bubbles: true });
      expect(events.start).toHaveLength(1);
      expect(root().getAttribute("data-grabbed")).toBe("true");

      document.querySelector("#h1")?.remove();
      await delay(20);
      expect(root().hasAttribute("data-grabbed")).toBe(false);

      press(document.querySelector<HTMLElement>("#h2") as HTMLElement, " ", { bubbles: true });
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
    const declareFollow = (on: boolean) =>
      root().setAttribute("data-stimeo--pointer-drag-follow-value", String(on));

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

    it("writes the committed offset on drop over a translate changed mid-gesture", async () => {
      await mount(followFixture);
      pointerDown(100, 100);
      pointerMove(120, 110);
      root().style.removeProperty("translate");
      pointerUp();
      expect(translate()).toBe("20px 10px");

      key(" ");
      key("ArrowRight");
      root().style.removeProperty("translate");
      key(" ");
      expect(translate()).toBe("30px 10px");
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

    /**
     * `follow` belongs to one gesture: it is read when the gesture starts, together with
     * the committed offset the inline `translate` shows at that moment, and holds until
     * the gesture ends. There is no changed callback, so each case writes the attribute
     * and the next read sees it.
     */
    describe("read when a gesture starts", () => {
      it("continues from the element's translate when follow is switched on after connect", async () => {
        await mount(`
          <ul>
            <li data-controller="stimeo--pointer-drag" style="translate: 30px 0px">
              <button type="button" data-stimeo--pointer-drag-target="handle"
                      aria-label="Reorder">⠿</button>
            </li>
          </ul>`);
        declareFollow(true);
        pointerDown(100, 100);
        pointerMove(110, 100);
        expect(translate()).toBe("40px 0px");
        pointerUp();
        expect(translate()).toBe("40px 0px");
      });

      it("takes the base from the inline translate the element shows when a gesture starts", async () => {
        await mount(followFixture);
        pointerDown(0, 0);
        pointerMove(20, 10);
        pointerUp();
        root().style.setProperty("translate", "50px 0px"); // the consumer's own position

        pointerDown(0, 0);
        pointerMove(5, 0);
        expect(translate()).toBe("55px 0px");
        key("Escape");
        expect(translate()).toBe("50px 0px");
      });

      it("keeps following a pointer drag whose follow is switched off mid-gesture", async () => {
        await mount(followFixture);
        pointerDown(100, 100);
        pointerMove(130, 100);
        declareFollow(false);
        pointerMove(140, 100);
        expect(translate()).toBe("40px 0px");
        pointerUp();
        expect(translate()).toBe("40px 0px");

        // The next gesture reads the new declaration and leaves the translate alone.
        pointerDown(0, 0);
        pointerMove(10, 0);
        pointerUp();
        expect(translate()).toBe("40px 0px");
      });

      it("snaps a drag back on cancel although its follow was switched off mid-gesture", async () => {
        await mount(followFixture);
        pointerDown(100, 100);
        pointerMove(130, 100);
        declareFollow(false);
        key("Escape");
        expect(translate()).toBe("");
      });

      it("does not start following mid-gesture when follow is switched on", async () => {
        await mount(defaultFixture);
        pointerDown(100, 100);
        pointerMove(130, 100);
        declareFollow(true);
        pointerMove(140, 100);
        expect(translate()).toBe("");
        pointerUp();
        expect(translate()).toBe("");

        pointerDown(0, 0);
        pointerMove(5, 0);
        expect(translate()).toBe("5px 0px");
      });

      it("keeps a keyboard grab's follow from the moment it grabbed", async () => {
        await mount(followFixture);
        key(" ");
        key("ArrowRight");
        declareFollow(false);
        key("ArrowRight");
        expect(translate()).toBe("20px 0px");
        key(" ");
        expect(translate()).toBe("20px 0px");
      });

      it("leaves the translate alone when an idle element goes away", async () => {
        await mount(followFixture);
        pointerDown(0, 0);
        pointerMove(20, 0);
        pointerUp();
        const li = root();
        li.style.setProperty("translate", "7px 7px");

        li.remove();
        await delay(20);
        expect(li.style.getPropertyValue("translate")).toBe("7px 7px");
      });
    });

    /**
     * `reset()` always ends the gesture in flight, and returns the inline `translate` to
     * the origin only under `follow`: the value the gesture in flight started with, or the
     * current declaration when none is in flight. Every case starts from the same
     * `translate: 7px 9px`, so the translate a case ends with shows which `follow`
     * `reset()` answered to.
     */
    describe("reset() and the follow declaration", () => {
      const resettable = (follow: boolean) => `
        <ul>
          <li data-controller="stimeo--pointer-drag" style="translate: 7px 9px"
              data-stimeo--pointer-drag-follow-value="${follow}"
              data-action="demo:reset->stimeo--pointer-drag#reset">
            <button type="button" data-stimeo--pointer-drag-target="handle"
                    aria-label="Reorder">⠿</button>
          </li>
        </ul>`;
      const requestReset = () => root().dispatchEvent(new CustomEvent("demo:reset"));

      it("cancels a grab and keeps the author's translate when follow is off", async () => {
        const events = await mount(resettable(false));
        key(" ");
        key("ArrowRight");
        expect(root().dataset.grabbed).toBe("true");

        requestReset();
        expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
        expect(root().hasAttribute("data-grabbed")).toBe(false);
        expect(handle().hasAttribute("data-grabbed")).toBe(false);
        expect(translate()).toBe("7px 9px");

        // Idle, there is nothing to cancel, and the translate stays the author's.
        requestReset();
        expect(events.cancel).toHaveLength(1);
        expect(translate()).toBe("7px 9px");
      });

      it("returns to the origin when follow is on, idle or mid-grab", async () => {
        const events = await mount(resettable(true));
        requestReset();
        expect(translate()).toBe("");
        expect(events.cancel).toHaveLength(0);

        root().style.setProperty("translate", "7px 9px");
        key(" ");
        key("ArrowRight");
        expect(translate()).toBe("17px 9px");
        requestReset();
        expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
        expect(root().hasAttribute("data-grabbed")).toBe(false);
        expect(translate()).toBe("");
      });

      it("returns a drag to the origin although its follow was switched off mid-gesture", async () => {
        const events = await mount(resettable(true));
        pointerDown(100, 100);
        pointerMove(110, 100);
        expect(translate()).toBe("17px 9px");
        declareFollow(false);

        requestReset();
        expect(events.cancel).toEqual([{ pointerType: "mouse" }]);
        expect(translate()).toBe("");
      });

      it("keeps the translate of a grab that started without follow", async () => {
        const events = await mount(resettable(false));
        key(" ");
        declareFollow(true);
        key("ArrowRight");

        requestReset();
        expect(events.cancel).toEqual([{ pointerType: "keyboard" }]);
        expect(translate()).toBe("7px 9px");
      });

      it("keeps the translate a follow drag committed once follow is switched off", async () => {
        const events = await mount(resettable(true));
        pointerDown(0, 0);
        pointerMove(20, 0);
        pointerUp();
        expect(translate()).toBe("27px 9px");
        declareFollow(false);

        requestReset();
        expect(events.cancel).toHaveLength(0);
        expect(translate()).toBe("27px 9px");
      });
    });
  });

  it("ignores Space / Enter / arrows raised during an IME composition", async () => {
    // A press that steers a conversion belongs to the composition, not to the drag.
    const events = await mount(defaultFixture);
    const composing = (k: string) =>
      !press(handle(), k, { bubbles: true, cancelable: true, isComposing: true }).defaultPrevented;

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
    expect(h.hasAttribute("data-stimeo--pointer-drag-tabindex-loan")).toBe(true);
    h.focus();

    const li = document.getElementById("src") as HTMLElement;
    (document.querySelector("ul") as HTMLElement).appendChild(li); // in-page move
    h.focus(); // the composer re-focuses synchronously, as sortable does
    await delay(20);
    // The loan must survive the move, or the borrowed tabindex is never returned.
    expect(h.hasAttribute("data-stimeo--pointer-drag-tabindex-loan")).toBe(true);
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
    expect(h.hasAttribute("data-stimeo--pointer-drag-tabindex-loan")).toBe(false);
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
    expect(ex.hasAttribute("data-stimeo--pointer-drag-tabindex-loan")).toBe(false);
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
    const space = keyEvent(" ", { bubbles: true, cancelable: true });
    press(field, space);
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
    // The nonfocusable root probes keys that originate outside every handle.
    typeKey(root(), " ");
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

  // --- Speech-order check -----------------------------------------------------

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
  describe("retained morph session rendering", () => {
    const followMarkup = defaultFixture.replace(
      'data-controller="stimeo--pointer-drag"',
      'data-controller="stimeo--pointer-drag" data-stimeo--pointer-drag-follow-value="true"',
    );
    const morph = async (origin: "own" | "descendant") => {
      (origin === "own" ? root() : handle()).dispatchEvent(
        new Event("turbo:morph-element", { bubbles: true }),
      );
      await flushMicrotasks();
    };

    for (const origin of ["own", "descendant"] as const) {
      it(`clears ${origin} stale drag hooks while idle without starting a session`, async () => {
        const events = await mount(followMarkup);
        key(" ");
        key("ArrowRight");
        key(" ");
        const before = structuredClone(events);
        root().setAttribute("data-dragging", "true");
        root().setAttribute("data-grabbed", "true");
        handle().setAttribute("data-grabbed", "true");
        await morph(origin);
        expect(root().hasAttribute("data-dragging")).toBe(false);
        expect(root().hasAttribute("data-grabbed")).toBe(false);
        expect(handle().hasAttribute("data-grabbed")).toBe(false);
        expect(root().style.translate).toBe("10px 0px");
        expect(events).toEqual(before);
        key(" ");
        expect(root().dataset.grabbed).toBe("true");
        expect(handle().dataset.grabbed).toBe("true");
        key("Escape");
      });

      it(`repairs ${origin} keyboard grab output without replaying or committing the session`, async () => {
        const events = await mount(followMarkup);
        key(" ");
        key("ArrowRight");
        expect(root().dataset.grabbed).toBe("true");
        expect(handle().dataset.grabbed).toBe("true");
        expect(root().style.translate).toBe("10px 0px");
        root().removeAttribute("data-grabbed");
        handle().removeAttribute("data-grabbed");
        root().style.removeProperty("translate");
        await morph(origin);
        expect(root().dataset.grabbed).toBe("true");
        expect(handle().dataset.grabbed).toBe("true");
        expect(root().style.translate).toBe("10px 0px");
        expect(events.start).toHaveLength(1);
        expect(events.move).toHaveLength(1);
        expect(events.end).toHaveLength(0);
        expect(events.cancel).toHaveLength(0);
        key("ArrowRight");
        key(" ");
        expect(root().style.translate).toBe("20px 0px");
        expect(events.end).toEqual([{ dx: 20, dy: 0, pointerType: "keyboard" }]);
        expect(root().hasAttribute("data-grabbed")).toBe(false);
        expect(handle().hasAttribute("data-grabbed")).toBe(false);
      });

      it(`repairs ${origin} pointer output while keeping the original capture and deltas`, async () => {
        const events = await mount(followMarkup);
        const capture = vi.spyOn(handle(), "setPointerCapture");
        pointerDown(100, 100, 71);
        pointerMove(112, 108, 71);
        expect(root().dataset.dragging).toBe("true");
        expect(root().style.translate).toBe("12px 8px");
        const captures = capture.mock.calls.length;
        root().removeAttribute("data-dragging");
        root().style.removeProperty("translate");
        await morph(origin);
        expect(root().dataset.dragging).toBe("true");
        expect(root().style.translate).toBe("12px 8px");
        expect(capture).toHaveBeenCalledTimes(captures);
        expect(events.start).toHaveLength(1);
        expect(events.move).toHaveLength(1);
        expect(events.end).toHaveLength(0);
        expect(events.cancel).toHaveLength(0);
        pointerMove(120, 112, 71);
        pointerUp(71);
        expect(root().style.translate).toBe("20px 12px");
        expect(events.end).toEqual([{ dx: 20, dy: 12, pointerType: "mouse" }]);
        expect(root().hasAttribute("data-dragging")).toBe(false);
        capture.mockRestore();
      });

      it(`repairs ${origin} committed follow output without committing its offset twice`, async () => {
        const events = await mount(followMarkup);
        pointerDown(0, 0);
        pointerMove(20, 10);
        pointerUp();
        expect(root().style.translate).toBe("20px 10px");
        root().style.removeProperty("translate");
        await morph(origin);
        expect(root().style.translate).toBe("20px 10px");
        expect(root().hasAttribute("data-dragging")).toBe(false);
        expect(events.start).toHaveLength(1);
        expect(events.end).toHaveLength(1);
        pointerDown(0, 0);
        pointerMove(5, 0);
        pointerUp();
        expect(root().style.translate).toBe("25px 10px");
        expect(events.end).toHaveLength(2);
      });
    }

    it("adopts a reconnected idle element's translate before later morphs", async () => {
      const events = await mount(followMarkup);
      pointerDown(0, 0);
      pointerMove(20, 10);
      pointerUp();
      root().style.removeProperty("translate");
      await morph("own");
      expect(root().style.translate).toBe("20px 10px");
      const element = root();
      const parent = element.parentElement;
      const instance = controller();
      element.remove();
      await tick();
      element.style.translate = "60px 30px";
      parent?.append(element);
      await tick();
      expect(controller()).toBe(instance);
      const before = structuredClone(events);
      await morph("descendant");
      expect(element.style.translate).toBe("60px 30px");
      expect(events).toEqual(before);
      pointerDown(0, 0);
      pointerMove(5, 0);
      pointerUp();
      expect(element.style.translate).toBe("65px 30px");
    });

    it("keeps authored translate before a follow move and below the pointer threshold", async () => {
      const events = await mount(followMarkup);
      root().style.translate = "25% 0px";
      pointerDown(0, 0);
      pointerMove(1, 0);
      await morph("own");
      expect(root().style.translate).toBe("25% 0px");
      expect(root().hasAttribute("data-dragging")).toBe(false);
      expect(events.start).toHaveLength(0);
      pointerUp();
      expect(events.end).toHaveLength(0);
    });

    it("keeps authored translate when follow is disabled during a grab", async () => {
      await mount(defaultFixture);
      key(" ");
      root().style.translate = "7px 9px";
      root().removeAttribute("data-grabbed");
      await morph("own");
      expect(root().dataset.grabbed).toBe("true");
      expect(root().style.translate).toBe("7px 9px");
      key("Escape");
    });

    it("repairs a drag's output by the follow its gesture started with", async () => {
      await mount(followMarkup);
      pointerDown(100, 100);
      pointerMove(112, 108);
      root().setAttribute("data-stimeo--pointer-drag-follow-value", "false");
      root().style.removeProperty("translate");
      await morph("own");
      expect(root().style.translate).toBe("12px 8px");
      key("Escape");
    });

    it("repairs nothing for a gesture that started without follow", async () => {
      await mount(followMarkup);
      pointerDown(0, 0);
      pointerMove(20, 0);
      pointerUp();
      root().setAttribute("data-stimeo--pointer-drag-follow-value", "false");
      key(" ");
      root().setAttribute("data-stimeo--pointer-drag-follow-value", "true");
      root().style.translate = "7px 9px";
      await morph("own");
      expect(root().style.translate).toBe("7px 9px");
      key("Escape");
    });

    it("repairs an idle element's output by the current follow declaration", async () => {
      await mount(followMarkup);
      pointerDown(0, 0);
      pointerMove(20, 0);
      pointerUp();
      root().setAttribute("data-stimeo--pointer-drag-follow-value", "false");
      root().style.translate = "7px 9px";
      await morph("own");
      expect(root().style.translate).toBe("7px 9px");
    });
  });
});
