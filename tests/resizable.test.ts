import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableController } from "../src/controllers/resizable_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents, type StateEventCapture } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

describe("ResizableController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div id="resizable" data-controller="stimeo--resizable"
           data-stimeo--resizable-min-value="20"
           data-stimeo--resizable-max-value="80"
           data-stimeo--resizable-value-value="50">
        <div id="pane-1" data-stimeo--resizable-target="primary">Primary</div>
        <div role="separator" id="splitter" tabindex="0" aria-orientation="vertical"
             aria-controls="pane-1" aria-label="Resize"
             data-stimeo--resizable-target="separator"
             data-action="pointerdown->stimeo--resizable#onPointerDown
                          keydown->stimeo--resizable#onKeydown"></div>
        <div data-stimeo--resizable-target="secondary">Secondary</div>
      </div>
    `;

    application = Application.start();
    application.register("stimeo--resizable", ResizableController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  describe("F6 pane cycling", () => {
    const root = () => document.getElementById("resizable") as HTMLElement;
    const primary = () => document.getElementById("pane-1") as HTMLElement;
    const secondary = () =>
      document.querySelector("[data-stimeo--resizable-target='secondary']") as HTMLElement;
    const f6 = (from: HTMLElement, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key: "F6",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      from.dispatchEvent(event);
      return event;
    };

    it("enters at the first pane and wraps through the panes", () => {
      const splitter = document.getElementById("splitter") as HTMLElement;
      splitter.focus();

      // Focus outside both panes enters the cycle at the first one.
      expect(f6(splitter).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(primary());

      f6(primary());
      expect(document.activeElement).toBe(secondary());

      f6(secondary());
      expect(document.activeElement).toBe(primary());
    });

    it("lends the pane a tabindex and takes it back on disconnect", () => {
      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--resizable",
      ) as ResizableController;
      // Panes are consumer containers, so the loan is what makes them focusable.
      expect(primary().hasAttribute("tabindex")).toBe(false);

      f6(document.getElementById("splitter") as HTMLElement);
      expect(primary().getAttribute("tabindex")).toBe("-1");

      controller.disconnect();
      expect(primary().hasAttribute("tabindex")).toBe(false);
    });

    it("yields a key a descendant widget already consumed", () => {
      const splitter = document.getElementById("splitter") as HTMLElement;
      splitter.focus();
      const event = new KeyboardEvent("keydown", { key: "F6", bubbles: true, cancelable: true });
      event.preventDefault();
      splitter.dispatchEvent(event);

      expect(document.activeElement).toBe(splitter);
    });

    it("leaves a chorded F6 to the browser", () => {
      const splitter = document.getElementById("splitter") as HTMLElement;
      splitter.focus();

      const event = f6(splitter, { ctrlKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(splitter);
    });
  });

  it("initializes ARIA properties and CSS custom properties", () => {
    const root = document.getElementById("resizable") as HTMLElement;
    const splitter = document.getElementById("splitter") as HTMLElement;

    expect(root.style.getPropertyValue("--stimeo--resizable-fraction")).toBe("0.5");
    expect(splitter.getAttribute("aria-valuenow")).toBe("50");
    expect(splitter.getAttribute("aria-valuemin")).toBe("20");
    expect(splitter.getAttribute("aria-valuemax")).toBe("80");
  });

  // Machine-detectable a11y.
  it("has no machine-detectable a11y violations", async () => {
    const root = document.getElementById("resizable") as HTMLElement;
    await expectNoA11yViolations(root);
  });

  // Speech-order regression. The separator announces its state (`role="separator"`
  // + aria-valuenow), so capturing the phrase before and after a keyboard step
  // pins role, accessible name, bounds, and the announced value; a lost role/name
  // or a stale value surfaces as a diff.
  it("announces the separator role, name, bounds, and value before and after a step", async () => {
    const splitter = document.getElementById("splitter") as HTMLElement;

    const before = await captureSpeech({ container: splitter, steps: 0 });
    expect(before).toEqual([
      "separator, Resize, orientated vertically, max value 80, min value 20, 50",
    ]);

    splitter.focus();
    splitter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tick();

    const after = await captureSpeech({ container: splitter, steps: 0 });
    expect(after).toEqual([
      "separator, Resize, orientated vertically, max value 80, min value 20, 51",
    ]);
  });

  it("clamping on initialization works properly", async () => {
    // Set value value out of bounds
    document.body.innerHTML = `
      <div id="resizable" data-controller="stimeo--resizable"
           data-stimeo--resizable-min-value="20"
           data-stimeo--resizable-max-value="80"
           data-stimeo--resizable-value-value="95">
        <div id="pane-1" data-stimeo--resizable-target="primary">Primary</div>
        <div role="separator" id="splitter" tabindex="0" aria-orientation="vertical"
             aria-controls="pane-1"
             data-stimeo--resizable-target="separator"
             data-action="pointerdown->stimeo--resizable#onPointerDown"></div>
      </div>
    `;
    disconnectAndStopApplication(application);
    application = Application.start();
    application.register("stimeo--resizable", ResizableController);
    await tick();

    const root = document.getElementById("resizable") as HTMLElement;
    const splitter = document.getElementById("splitter") as HTMLElement;

    // Should clamp value 95 to max 80
    expect(root.style.getPropertyValue("--stimeo--resizable-fraction")).toBe("0.8");
    expect(splitter.getAttribute("aria-valuenow")).toBe("80");
  });

  it("leaves a modified arrow to the browser", async () => {
    const root = document.getElementById("resizable") as HTMLElement;
    const splitter = document.getElementById("splitter") as HTMLElement;

    const changeHandler = vi.fn();
    root.addEventListener("stimeo--resizable:change", changeHandler);

    splitter.focus();

    // A chorded arrow is the browser's (history back/forward and the like), so
    // the splitter neither consumes the key nor moves its value.
    const chord = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    splitter.dispatchEvent(chord);
    await tick();

    expect(chord.defaultPrevented).toBe(false);
    expect(splitter.getAttribute("aria-valuenow")).toBe("50");
    expect(root.style.getPropertyValue("--stimeo--resizable-fraction")).toBe("0.5");
    expect(changeHandler).not.toHaveBeenCalled();
  });

  it("keyboard navigation adjusts size and fires change event", async () => {
    const root = document.getElementById("resizable") as HTMLElement;
    const splitter = document.getElementById("splitter") as HTMLElement;

    const changeHandler = vi.fn();
    root.addEventListener("stimeo--resizable:change", changeHandler);

    splitter.focus();

    // ArrowRight increases the vertical pane size
    const right = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true });
    splitter.dispatchEvent(right);
    await tick();

    expect(root.style.getPropertyValue("--stimeo--resizable-fraction")).toBe("0.51"); // step is 1%
    expect(splitter.getAttribute("aria-valuenow")).toBe("51");
    expect(changeHandler).toHaveBeenCalledOnce();
    expect(changeHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: 51, fraction: 0.51 });

    // ArrowLeft decreases size
    const left = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true });
    splitter.dispatchEvent(left);
    await tick();

    expect(splitter.getAttribute("aria-valuenow")).toBe("50");

    // End jumps to max limits (80)
    const end = new KeyboardEvent("keydown", { key: "End", bubbles: true });
    splitter.dispatchEvent(end);
    await tick();
    expect(splitter.getAttribute("aria-valuenow")).toBe("80");

    // Home jumps to min limits (20)
    const home = new KeyboardEvent("keydown", { key: "Home", bubbles: true });
    splitter.dispatchEvent(home);
    await tick();
    expect(splitter.getAttribute("aria-valuenow")).toBe("20");
  });

  it("keyboard navigation works for horizontal orientation (vertical split)", async () => {
    const splitter = document.getElementById("splitter") as HTMLElement;
    splitter.setAttribute("aria-orientation", "horizontal");
    // Initial value is 50.
    splitter.focus();
    // ArrowDown increases the horizontal pane size
    const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true });
    splitter.dispatchEvent(down);
    await tick();
    expect(splitter.getAttribute("aria-valuenow")).toBe("51");
    // ArrowUp decreases size
    const up = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true });
    splitter.dispatchEvent(up);
    await tick();
    expect(splitter.getAttribute("aria-valuenow")).toBe("50");
  });

  it("toggle action collapses and restores sizes dynamically", async () => {
    const root = document.getElementById("resizable") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--resizable",
    ) as ResizableController;

    expect(controller.valueValue).toBe(50);

    // Call toggle() (simulates Enter or double click). Should collapse to min (20).
    controller.toggle();
    await tick();
    expect(controller.valueValue).toBe(20);

    // Toggle again. Should restore to previously held value (50).
    controller.toggle();
    await tick();
    expect(controller.valueValue).toBe(50);
  });

  it("pointerdrag simulates dragging accurately using setPointerCapture", async () => {
    const root = document.getElementById("resizable") as HTMLElement;
    const splitter = document.getElementById("splitter") as HTMLElement;

    const changeHandler = vi.fn();
    root.addEventListener("stimeo--resizable:change", changeHandler);

    // Mock parent client rect size: left=0, width=500px.
    // That means coordinate clientX = 250px is 50%, clientX = 350px is 70% etc.
    root.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 500,
        height: 100,
      }) as DOMRect;

    // Spy on Pointer Capture APIs
    const captureSpy = vi.spyOn(splitter, "setPointerCapture");
    const releaseSpy = vi.spyOn(splitter, "releasePointerCapture");

    // 1. pointerdown (starts drag)
    const pointerdown = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      pointerId: 42,
    });
    splitter.dispatchEvent(pointerdown);
    await tick();

    expect(captureSpy).toHaveBeenCalledWith(42);
    expect(root.getAttribute("data-dragging")).toBe("true");

    // 2. pointermove (drag to clientX = 350px -> 350/500 = 70% fraction)
    const pointermove = new PointerEvent("pointermove", {
      bubbles: true,
      clientX: 350,
      pointerId: 42,
    });
    splitter.dispatchEvent(pointermove);
    await tick();

    expect(root.style.getPropertyValue("--stimeo--resizable-fraction")).toBe("0.7");
    expect(splitter.getAttribute("aria-valuenow")).toBe("70");

    // 3. pointerup (ends drag)
    const pointerup = new PointerEvent("pointerup", {
      bubbles: true,
      pointerId: 42,
    });
    splitter.dispatchEvent(pointerup);
    await tick();

    expect(releaseSpy).toHaveBeenCalledWith(42);
    expect(root.getAttribute("data-dragging")).toBeNull();
    expect(changeHandler).toHaveBeenCalledOnce();
    expect(changeHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: 70, fraction: 0.7 });
  });

  it("focuses the separator on pointerdown so arrow keys work after a click", async () => {
    const splitter = document.getElementById("splitter") as HTMLElement;

    // preventDefault in onPointerDown suppresses implicit focus, so the controller
    // must focus the separator explicitly; otherwise click-then-arrow silently fails.
    const pointerdown = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      pointerId: 7,
    });
    splitter.dispatchEvent(pointerdown);
    await tick();

    expect(document.activeElement).toBe(splitter);
  });

  it("removes drag listeners on disconnect so a later pointermove is ignored", async () => {
    const root = document.getElementById("resizable") as HTMLElement;
    const splitter = document.getElementById("splitter") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--resizable",
    ) as ResizableController;

    root.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 100 }) as DOMRect;

    splitter.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 9 }),
    );
    await tick();

    // Tearing the controller down mid-drag must abort the drag listeners.
    controller.disconnect();

    splitter.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: 350, pointerId: 9 }),
    );
    await tick();

    // Fraction stays at the initial 0.5; the stale move did not adjust it.
    expect(root.style.getPropertyValue("--stimeo--resizable-fraction")).toBe("0.5");
  });

  // --- Drag hook lifecycle -----------------------------------------------------

  const remount = async (html: string) => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--resizable", ResizableController);
    await tick();
  };

  const markup = (rootAttrs: string, sepAttrs = 'aria-orientation="vertical"') => `
    <div id="resizable" data-controller="stimeo--resizable" ${rootAttrs}>
      <div id="pane-1" data-stimeo--resizable-target="primary">Primary</div>
      <div role="separator" id="splitter" tabindex="0" ${sepAttrs}
           aria-controls="pane-1" aria-label="Resize"
           data-stimeo--resizable-target="separator"
           data-action="pointerdown->stimeo--resizable#onPointerDown
                        keydown->stimeo--resizable#onKeydown"></div>
      <div data-stimeo--resizable-target="secondary">Secondary</div>
    </div>`;
  const RANGE =
    'data-stimeo--resizable-min-value="20" data-stimeo--resizable-max-value="80" data-stimeo--resizable-value-value="50"';

  const controllerFor = () =>
    application.getControllerForElementAndIdentifier(
      document.getElementById("resizable") as HTMLElement,
      "stimeo--resizable",
    ) as ResizableController;
  const rootEl = () => document.getElementById("resizable") as HTMLElement;
  const splitterEl = () => document.getElementById("splitter") as HTMLElement;
  const fraction = () => rootEl().style.getPropertyValue("--stimeo--resizable-fraction");
  const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
    return event;
  };
  const startDrag = (id = 1) =>
    splitterEl().dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: id }),
    );

  it("clears a drag hook a cache restore may have snapshotted", async () => {
    // A drag cannot outlive a navigation, so the attribute is stale on arrival.
    await remount(markup(`${RANGE} data-dragging="true"`));
    expect(rootEl().hasAttribute("data-dragging")).toBe(false);
  });

  it("takes the drag hook back when torn down mid-drag", async () => {
    startDrag();
    await tick();
    expect(rootEl().getAttribute("data-dragging")).toBe("true");

    controllerFor().disconnect();
    expect(rootEl().hasAttribute("data-dragging")).toBe(false);
  });

  it("ends the drag even when the separator is removed mid-drag", async () => {
    const splitter = splitterEl();
    startDrag(3);
    await tick();
    splitter.remove();
    await tick();

    expect(() =>
      splitter.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 3 })),
    ).not.toThrow();
    expect(rootEl().hasAttribute("data-dragging")).toBe(false);
  });

  it("ends the drag on pointercancel", async () => {
    startDrag(4);
    await tick();
    splitterEl().dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 4 }));
    await tick();
    expect(rootEl().hasAttribute("data-dragging")).toBe(false);
  });

  // --- Collapse and restore ----------------------------------------------------

  it("restores the position it collapsed from, whatever that position was", async () => {
    // The pattern restores a previous position; a position in the lower half of
    // the range is still a position.
    const controller = controllerFor();
    controller.valueValue = 30;
    await tick();

    controller.toggle();
    expect(controller.valueValue).toBe(20);

    controller.toggle();
    expect(controller.valueValue).toBe(30);
  });

  it("opens fully when it has no collapsed-from position to restore", async () => {
    await remount(
      markup(
        'data-stimeo--resizable-min-value="20" data-stimeo--resizable-max-value="80" data-stimeo--resizable-value-value="20"',
      ),
    );
    const controller = controllerFor();
    controller.toggle();
    expect(controller.valueValue).toBe(80);
  });

  it("forgets the collapsed-from position once it has been restored", async () => {
    const controller = controllerFor();
    controller.toggle();
    controller.toggle();
    expect(controller.valueValue).toBe(50);

    controller.toggle();
    controller.toggle();
    expect(controller.valueValue).toBe(50);
  });

  // --- Declarations that cannot be read ----------------------------------------

  it("falls back to the Value default when a bound cannot be read", async () => {
    await remount(
      markup(
        'data-stimeo--resizable-min-value="abc" data-stimeo--resizable-max-value="80" data-stimeo--resizable-value-value="50"',
      ),
    );
    expect(fraction()).toBe("0.5");
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("50");
    expect(splitterEl().getAttribute("aria-valuemin")).toBe("0");
    expect(splitterEl().getAttribute("aria-valuemax")).toBe("80");
  });

  it("falls back when the position itself cannot be read, leaving the declaration as written", async () => {
    await remount(
      markup(
        'data-stimeo--resizable-min-value="20" data-stimeo--resizable-max-value="80" data-stimeo--resizable-value-value="abc"',
      ),
    );
    expect(fraction()).toBe("0.5");
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("50");
    expect(rootEl().getAttribute("data-stimeo--resizable-value-value")).toBe("abc");
  });

  it("collapses a maximum below the minimum onto that minimum", async () => {
    await remount(
      markup(
        'data-stimeo--resizable-min-value="80" data-stimeo--resizable-max-value="20" data-stimeo--resizable-value-value="50"',
      ),
    );
    // An inverted range cannot be announced; both ends report the minimum.
    expect(splitterEl().getAttribute("aria-valuemin")).toBe("80");
    expect(splitterEl().getAttribute("aria-valuemax")).toBe("80");
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("80");
    expect(fraction()).toBe("0.8");
  });

  it("falls back to a single-percent step when the declared one is not positive", async () => {
    await remount(`${markup(`${RANGE} data-stimeo--resizable-step-value="0"`)}`);
    splitterEl().focus();
    press(splitterEl(), "ArrowRight");
    await tick();
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("51");
  });

  it("falls back to the Value default when the maximum cannot be read", async () => {
    await remount(
      markup(
        'data-stimeo--resizable-min-value="20" data-stimeo--resizable-max-value="abc" data-stimeo--resizable-value-value="90"',
      ),
    );
    expect(splitterEl().getAttribute("aria-valuemax")).toBe("100");
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("90");
  });

  it("honours a declared step", async () => {
    await remount(markup(`${RANGE} data-stimeo--resizable-step-value="5"`));
    splitterEl().focus();
    press(splitterEl(), "ArrowRight");
    await tick();
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("55");
  });

  it("reads the pointer along the axis a horizontal divider moves on", async () => {
    await remount(markup(RANGE, 'aria-orientation="horizontal" aria-label="Resize"'));
    rootEl().getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 500, height: 200 }) as DOMRect;
    startDrag(8);
    await tick();
    // clientY is what a horizontal divider follows; clientX must not reach it.
    splitterEl().dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: 500, clientY: 60, pointerId: 8 }),
    );
    await tick();
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("30");
    expect(fraction()).toBe("0.3");
  });

  it("keeps the published fraction finite when the container has no extent", async () => {
    rootEl().getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 }) as DOMRect;
    startDrag(5);
    await tick();
    splitterEl().dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: 0, pointerId: 5 }),
    );
    await tick();
    expect(fraction()).toBe("0.2");
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("20");
  });

  // --- Runtime input changes ---------------------------------------------------

  it("follows a range swapped in at runtime", async () => {
    const events = captureStateEvents("stimeo--resizable", ["change", "reconcile"]);
    rootEl().setAttribute("data-stimeo--resizable-max-value", "40");
    rootEl().setAttribute("data-stimeo--resizable-min-value", "10");
    await tick();
    await tick();

    expect(splitterEl().getAttribute("aria-valuemin")).toBe("10");
    expect(splitterEl().getAttribute("aria-valuemax")).toBe("40");
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("40");
    expect(fraction()).toBe("0.4");
    // The clamp is published, not written back, and reported once for the batch.
    expect(rootEl().getAttribute("data-stimeo--resizable-value-value")).toBe("50");
    expect(events.seen.map(({ name, detail }) => ({ name, detail }))).toEqual([
      { name: "reconcile", detail: { value: 40, fraction: 0.4 } },
    ]);
    events.stop();
  });

  it("follows a position swapped in at runtime", async () => {
    const events = captureStateEvents("stimeo--resizable", ["change", "reconcile"]);
    // The range inputs have their own coverage; this one moves `value` alone so a
    // silent `valueValueChanged` cannot hide behind a sibling that repaints anyway.
    rootEl().setAttribute("data-stimeo--resizable-value-value", "70");
    await tick();
    await tick();

    expect(splitterEl().getAttribute("aria-valuenow")).toBe("70");
    expect(fraction()).toBe("0.7");
    expect(splitterEl().getAttribute("aria-valuemin")).toBe("20");
    expect(splitterEl().getAttribute("aria-valuemax")).toBe("80");
    expect(events.seen.map(({ name, detail }) => ({ name, detail }))).toEqual([
      { name: "reconcile", detail: { value: 70, fraction: 0.7 } },
    ]);
    events.stop();
  });

  it("paints once for a batch that swaps several inputs", async () => {
    const events = captureStateEvents("stimeo--resizable", ["change", "reconcile"]);
    const root = rootEl();
    let writes = 0;
    const setProperty = root.style.setProperty.bind(root.style);
    root.style.setProperty = ((name: string, value: string) => {
      if (name === "--stimeo--resizable-fraction") writes += 1;
      return setProperty(name, value);
    }) as typeof root.style.setProperty;

    // A morph swaps a batch of attributes; the position is left alone so the
    // count measures the range inputs rather than the one that already painted.
    root.setAttribute("data-stimeo--resizable-min-value", "10");
    root.setAttribute("data-stimeo--resizable-max-value", "90");
    await tick();
    await tick();

    // One paint for the whole batch, and every input in it took effect.
    expect(writes).toBe(1);
    expect(splitterEl().getAttribute("aria-valuemin")).toBe("10");
    expect(splitterEl().getAttribute("aria-valuemax")).toBe("90");
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("50");
    // A wider range leaves the position where it was, so nothing is reported.
    expect(events.seen).toEqual([]);
    events.stop();
  });

  it("re-publishes range and position onto a separator swapped in after connect", async () => {
    const controller = controllerFor();
    controller.valueValue = 70;
    await tick();

    const fresh = document.createElement("div");
    fresh.id = "splitter";
    fresh.setAttribute("role", "separator");
    fresh.setAttribute("tabindex", "0");
    fresh.setAttribute("aria-orientation", "vertical");
    fresh.setAttribute("aria-label", "Resize");
    // The server's resting markup carries the position it rendered with.
    fresh.setAttribute("aria-valuenow", "50");
    fresh.setAttribute("data-stimeo--resizable-target", "separator");
    splitterEl().replaceWith(fresh);
    await tick();
    await tick();

    expect(splitterEl().getAttribute("aria-valuenow")).toBe("70");
    expect(splitterEl().getAttribute("aria-valuemin")).toBe("20");
    expect(splitterEl().getAttribute("aria-valuemax")).toBe("80");
  });

  // --- Pane cycling and the guards around it -----------------------------------

  it("leaves an F6 that belongs to an IME composition alone", async () => {
    // Japanese input methods bind F6 to a conversion; taking it would abandon
    // the composition the user is still editing.
    const primary = document.getElementById("pane-1") as HTMLElement;
    splitterEl().focus();
    const event = press(splitterEl(), "F6", { isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(splitterEl());
    expect(primary.hasAttribute("tabindex")).toBe(false);
  });

  it("ignores a key other than F6 on the root", async () => {
    splitterEl().focus();
    press(rootEl(), "F7");
    expect(document.activeElement).toBe(splitterEl());
  });

  it("does nothing on F6 when the panes are not there", async () => {
    await remount(`
      <div id="resizable" data-controller="stimeo--resizable" ${RANGE}>
        <div role="separator" id="splitter" tabindex="0" aria-orientation="vertical"
             aria-label="Resize" data-stimeo--resizable-target="separator"
             data-action="keydown->stimeo--resizable#onKeydown"></div>
      </div>`);
    splitterEl().focus();
    const event = press(splitterEl(), "F6");
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(splitterEl());
  });

  it("stops cycling panes once the controller is torn down", async () => {
    const primary = document.getElementById("pane-1") as HTMLElement;
    controllerFor().disconnect();
    press(splitterEl(), "F6");
    expect(document.activeElement).not.toBe(primary);
  });

  // --- Orientation -------------------------------------------------------------

  it("treats a separator that declares no orientation as horizontal", async () => {
    // ARIA gives `separator` a horizontal default, and the announced axis has to
    // be the one the arrow keys answer on.
    await remount(markup(RANGE, 'aria-label="Resize"'));
    splitterEl().focus();

    const right = press(splitterEl(), "ArrowRight");
    await tick();
    expect(right.defaultPrevented).toBe(false);
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("50");

    const down = press(splitterEl(), "ArrowDown");
    await tick();
    expect(down.defaultPrevented).toBe(true);
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("51");
  });

  it("leaves the off-axis arrows to the browser", async () => {
    const changeHandler = vi.fn();
    rootEl().addEventListener("stimeo--resizable:change", changeHandler);
    splitterEl().focus();

    // The fixture is a vertical divider, so Up/Down name an axis it does not move.
    const up = press(splitterEl(), "ArrowUp");
    const down = press(splitterEl(), "ArrowDown");
    await tick();

    expect(up.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(false);
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("50");
    expect(changeHandler).not.toHaveBeenCalled();
  });

  // --- Guards around a missing separator ---------------------------------------

  it("ignores a pointerdown from a button other than the primary one", async () => {
    splitterEl().dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 2, pointerId: 6 }),
    );
    await tick();
    expect(rootEl().hasAttribute("data-dragging")).toBe(false);
  });

  it("ignores a keydown once the element has stopped being the separator", async () => {
    // A morph can rewrite the target attribute while leaving the action bound,
    // so the handler still runs with no separator to read or publish to.
    const splitter = splitterEl();
    splitter.removeAttribute("data-stimeo--resizable-target");
    await tick();

    // Keys the horizontal reading would otherwise act on, so the guard is the
    // only thing standing between them and a published position.
    expect(() => press(splitter, "Home")).not.toThrow();
    expect(() => press(splitter, "ArrowDown")).not.toThrow();
    expect(fraction()).toBe("0.5");
  });

  it("ignores a pointermove once the separator is gone", async () => {
    const splitter = splitterEl();
    rootEl().getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 500, height: 100 }) as DOMRect;
    startDrag(7);
    await tick();
    splitter.remove();
    await tick();
    expect(() =>
      splitter.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 350, pointerId: 7 }),
      ),
    ).not.toThrow();
    expect(fraction()).toBe("0.5");
  });

  it("takes the declared defaults when no Values are written", async () => {
    await remount(markup(""));
    expect(splitterEl().getAttribute("aria-valuemin")).toBe("0");
    expect(splitterEl().getAttribute("aria-valuemax")).toBe("100");
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("50");
    expect(fraction()).toBe("0.5");
  });

  it("keeps an out-of-range declaration on initialization and publishes the clamped position", async () => {
    const events = captureStateEvents("stimeo--resizable", ["change", "reconcile"]);
    document.body.innerHTML = `
      <div id="resizable" data-controller="stimeo--resizable"
           data-stimeo--resizable-min-value="20"
           data-stimeo--resizable-max-value="80"
           data-stimeo--resizable-value-value="95">
        <div id="pane-1" data-stimeo--resizable-target="primary">Primary</div>
        <div role="separator" id="splitter" tabindex="0" aria-orientation="vertical"
             aria-controls="pane-1"
             data-stimeo--resizable-target="separator"
             data-action="pointerdown->stimeo--resizable#onPointerDown"></div>
      </div>
    `;
    disconnectAndStopApplication(application);
    application = Application.start();
    application.register("stimeo--resizable", ResizableController);
    await tick();

    const root = document.getElementById("resizable") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--resizable",
    ) as ResizableController;

    // The declaration is the page's input; ARIA and CSS publish the clamped 80.
    expect(controller.valueValue).toBe(95);
    expect(root.getAttribute("data-stimeo--resizable-value-value")).toBe("95");
    expect(splitterEl().getAttribute("aria-valuenow")).toBe("80");
    expect(fraction()).toBe("0.8");
    expect(events.seen).toEqual([]);
    events.stop();
  });

  // --- Page-driven reconciliation ----------------------------------------------

  describe("page-driven reconciliation", () => {
    let events: StateEventCapture;

    const reports = () => events.seen.map(({ name, detail }) => ({ name, detail }));
    const declared = () => rootEl().getAttribute("data-stimeo--resizable-value-value");
    /** Writes a Value the way a morph does and delivers its callback directly. */
    const declare = async (name: "min" | "max" | "value", value: string) => {
      rootEl().setAttribute(`data-stimeo--resizable-${name}-value`, value);
      controllerFor()[`${name}ValueChanged`]();
      await flushMicrotasks();
    };
    const OUT_OF_RANGE =
      'data-stimeo--resizable-min-value="20" data-stimeo--resizable-max-value="80" data-stimeo--resizable-value-value="95"';

    beforeEach(() => {
      events = captureStateEvents("stimeo--resizable", ["change", "reconcile"]);
    });

    afterEach(() => {
      events.stop();
    });

    it("reports a position a lowered maximum clamps, leaving the declaration as written", async () => {
      await remount(
        markup(
          'data-stimeo--resizable-min-value="0" data-stimeo--resizable-max-value="100" data-stimeo--resizable-value-value="70"',
        ),
      );

      await declare("max", "60");

      expect(declared()).toBe("70");
      expect(splitterEl().getAttribute("aria-valuenow")).toBe("60");
      expect(fraction()).toBe("0.6");
      expect(reports()).toEqual([{ name: "reconcile", detail: { value: 60, fraction: 0.6 } }]);
    });

    it("reports a move once, so a later pass that finds the same position stays silent", async () => {
      await declare("value", "70");
      controllerFor().valueValueChanged();
      await flushMicrotasks();

      expect(reports()).toEqual([{ name: "reconcile", detail: { value: 70, fraction: 0.7 } }]);
    });

    it("takes a new baseline silently when it connects again after the declaration moved", async () => {
      const controller = controllerFor();
      controller.disconnect();
      rootEl().setAttribute("data-stimeo--resizable-value-value", "70");
      controller.connect();
      controller.valueValueChanged();
      await flushMicrotasks();

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("70");
      expect(reports()).toEqual([]);
    });

    it("reports one reconcile for a batch that moves the position", async () => {
      rootEl().setAttribute("data-stimeo--resizable-min-value", "30");
      rootEl().setAttribute("data-stimeo--resizable-max-value", "60");
      rootEl().setAttribute("data-stimeo--resizable-value-value", "90");
      controllerFor().minValueChanged();
      controllerFor().maxValueChanged();
      controllerFor().valueValueChanged();
      await flushMicrotasks();

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("60");
      expect(reports()).toEqual([{ name: "reconcile", detail: { value: 60, fraction: 0.6 } }]);
    });

    it("reports a key the user pressed as change only, and the pass its Value write starts stays silent", async () => {
      splitterEl().focus();
      press(splitterEl(), "ArrowRight");
      controllerFor().valueValueChanged();
      await flushMicrotasks();

      expect(declared()).toBe("51");
      expect(reports()).toEqual([{ name: "change", detail: { value: 51, fraction: 0.51 } }]);
    });

    it("reports a drag as change at its end only, and the passes its moves start stay silent", async () => {
      rootEl().getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 500, height: 100 }) as DOMRect;
      startDrag(21);
      splitterEl().dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 300, pointerId: 21 }),
      );
      controllerFor().valueValueChanged();
      await flushMicrotasks();
      expect(reports()).toEqual([]);

      splitterEl().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 21 }));
      controllerFor().valueValueChanged();
      await flushMicrotasks();

      expect(declared()).toBe("60");
      expect(reports()).toEqual([{ name: "change", detail: { value: 60, fraction: 0.6 } }]);
    });

    it("reports a page move back to where it was before the last reconcile", async () => {
      await declare("value", "70");
      await declare("value", "50");

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("50");
      expect(reports()).toEqual([
        { name: "reconcile", detail: { value: 70, fraction: 0.7 } },
        { name: "reconcile", detail: { value: 50, fraction: 0.5 } },
      ]);
    });

    it("steps from the published position when the declaration is out of range", async () => {
      await remount(markup(OUT_OF_RANGE));
      splitterEl().focus();

      press(splitterEl(), "ArrowLeft");

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("79");
      expect(declared()).toBe("79");
      expect(reports()).toEqual([{ name: "change", detail: { value: 79, fraction: 0.79 } }]);
    });

    it("collapses from and restores to the published position of an out-of-range declaration", async () => {
      await remount(markup(OUT_OF_RANGE));
      const controller = controllerFor();

      controller.toggle();
      expect(splitterEl().getAttribute("aria-valuenow")).toBe("20");
      controller.toggle();

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("80");
      expect(declared()).toBe("80");
      expect(reports()).toEqual([
        { name: "change", detail: { value: 20, fraction: 0.2 } },
        { name: "change", detail: { value: 80, fraction: 0.8 } },
      ]);
    });

    it("restores a collapsed-from position beyond a lowered maximum to that maximum", async () => {
      const controller = controllerFor();
      controller.valueValue = 70;
      await tick();
      controller.toggle();
      await declare("max", "60");
      events.clear();

      controller.toggle();

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("60");
      expect(declared()).toBe("60");
      expect(reports()).toEqual([{ name: "change", detail: { value: 60, fraction: 0.6 } }]);
    });

    it("reports a move a reconcile subscriber makes on the next pass, from the new baseline", async () => {
      let redirected = false;
      rootEl().addEventListener("stimeo--resizable:reconcile", () => {
        if (redirected) return;
        redirected = true;
        rootEl().setAttribute("data-stimeo--resizable-value-value", "30");
        controllerFor().valueValueChanged();
      });

      await declare("value", "70");
      await tick();

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("30");
      expect(reports()).toEqual([
        { name: "reconcile", detail: { value: 70, fraction: 0.7 } },
        { name: "reconcile", detail: { value: 30, fraction: 0.3 } },
      ]);
    });

    it("keeps the baseline in step when a change subscriber moves again synchronously", async () => {
      let again = true;
      // Registered after the capture, so the capture records each report before
      // this subscriber answers it.
      const moveAgain = (): void => {
        if (!again) return;
        again = false;
        press(splitterEl(), "ArrowRight");
      };
      document.addEventListener("stimeo--resizable:change", moveAgain);
      splitterEl().focus();

      press(splitterEl(), "ArrowRight");
      controllerFor().valueValueChanged();
      await flushMicrotasks();
      document.removeEventListener("stimeo--resizable:change", moveAgain);

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("52");
      expect(reports()).toEqual([
        { name: "change", detail: { value: 51, fraction: 0.51 } },
        { name: "change", detail: { value: 52, fraction: 0.52 } },
      ]);
    });

    it("drops a pass queued before disconnect", async () => {
      rootEl().setAttribute("data-stimeo--resizable-value-value", "70");
      controllerFor().valueValueChanged();
      controllerFor().disconnect();
      await flushMicrotasks();

      expect(reports()).toEqual([]);
    });

    it("restores the published position a toggle collapsed from after the page widens the range", async () => {
      await remount(markup(OUT_OF_RANGE));
      const controller = controllerFor();

      controller.toggle();
      // Widening the range would publish the declared 95; the pane collapsed from 80.
      await declare("max", "100");
      controller.toggle();

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("80");
      expect(reports()).toEqual([
        { name: "change", detail: { value: 20, fraction: 0.2 } },
        { name: "change", detail: { value: 80, fraction: 0.8 } },
      ]);
    });

    it("keeps a key pressed inside a reconcile listener a change, and measures the next key from it", async () => {
      let spent = false;
      // Registered after the capture, so the recording keeps dispatch order.
      const pressOnce = (): void => {
        if (spent) return;
        spent = true;
        press(splitterEl(), "ArrowRight");
      };
      document.addEventListener("stimeo--resizable:reconcile", pressOnce);
      splitterEl().focus();

      await declare("value", "70");
      controllerFor().valueValueChanged();
      await flushMicrotasks();
      document.removeEventListener("stimeo--resizable:reconcile", pressOnce);
      // The key inside the listener was the last report, so a key back to the
      // page's 70 is a move of its own.
      press(splitterEl(), "ArrowLeft");
      controllerFor().valueValueChanged();
      await flushMicrotasks();

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("70");
      expect(reports()).toEqual([
        { name: "reconcile", detail: { value: 70, fraction: 0.7 } },
        { name: "change", detail: { value: 71, fraction: 0.71 } },
        { name: "change", detail: { value: 70, fraction: 0.7 } },
      ]);
    });
  });

  // --- Change only for a move --------------------------------------------------

  describe("change only for a move", () => {
    let events: StateEventCapture;

    const reports = () => events.seen.map(({ name, detail }) => ({ name, detail }));
    const stubRect = () => {
      rootEl().getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 500, height: 100 }) as DOMRect;
    };
    /** Moves the pointer to `clientX` on the 500px-wide container: 5px per percent. */
    const moveTo = (clientX: number, pointerId: number) =>
      splitterEl().dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX, pointerId }),
      );
    const release = (pointerId: number) =>
      splitterEl().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId }));

    beforeEach(() => {
      events = captureStateEvents("stimeo--resizable", ["change", "reconcile"]);
    });

    afterEach(() => {
      events.stop();
    });

    it("reports nothing for a key at an edge, after reporting the key that reached it", () => {
      splitterEl().focus();

      press(splitterEl(), "End");
      press(splitterEl(), "End");
      press(splitterEl(), "ArrowRight");
      press(splitterEl(), "Home");
      press(splitterEl(), "Home");
      press(splitterEl(), "ArrowLeft");

      expect(reports()).toEqual([
        { name: "change", detail: { value: 80, fraction: 0.8 } },
        { name: "change", detail: { value: 20, fraction: 0.2 } },
      ]);
    });

    it("reports nothing for a key at the edge the page moved the position to", async () => {
      rootEl().setAttribute("data-stimeo--resizable-value-value", "80");
      controllerFor().valueValueChanged();
      await flushMicrotasks();
      events.clear();
      splitterEl().focus();

      press(splitterEl(), "End");

      expect(reports()).toEqual([]);
    });

    it("reports nothing for a press released without moving", () => {
      stubRect();

      startDrag(31);
      release(31);

      expect(reports()).toEqual([]);
    });

    it("reports nothing for a drag released where it started", () => {
      stubRect();

      startDrag(32);
      moveTo(300, 32);
      moveTo(250, 32);
      release(32);

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("50");
      expect(reports()).toEqual([]);
    });

    it("reports a drag that moved exactly once, when it ends", () => {
      stubRect();

      startDrag(33);
      moveTo(300, 33);
      moveTo(350, 33);
      expect(reports()).toEqual([]);
      release(33);

      expect(reports()).toEqual([{ name: "change", detail: { value: 70, fraction: 0.7 } }]);
    });

    it("reports nothing for a toggle that cannot move the position", async () => {
      await remount(
        markup(
          'data-stimeo--resizable-min-value="50" data-stimeo--resizable-max-value="50" data-stimeo--resizable-value-value="50"',
        ),
      );

      controllerFor().toggle();
      controllerFor().toggle();

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("50");
      expect(reports()).toEqual([]);
    });

    it("reports only the reconcile for a drag the page clamped and that is released in place", async () => {
      stubRect();
      startDrag(34);
      moveTo(350, 34);

      rootEl().setAttribute("data-stimeo--resizable-max-value", "60");
      controllerFor().maxValueChanged();
      await flushMicrotasks();
      release(34);

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("60");
      expect(reports()).toEqual([{ name: "reconcile", detail: { value: 60, fraction: 0.6 } }]);
    });

    it("reports nothing when the page puts a drag back where it started and it is released in place", async () => {
      stubRect();
      startDrag(35);
      moveTo(350, 35);

      // The drag has only painted 70; 50 is still the position last confirmed.
      rootEl().setAttribute("data-stimeo--resizable-value-value", "50");
      controllerFor().valueValueChanged();
      await flushMicrotasks();
      release(35);

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("50");
      expect(reports()).toEqual([]);
    });

    it("reports the published position when a drag ends on a declaration the page wrote out of range", async () => {
      stubRect();
      startDrag(36);
      moveTo(300, 36);

      // The release lands before the Value callback, so the report reads the
      // clamped position from the declaration itself, and the repaint that
      // follows finds that position already reported.
      rootEl().setAttribute("data-stimeo--resizable-value-value", "95");
      release(36);
      controllerFor().valueValueChanged();
      await flushMicrotasks();

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("80");
      expect(reports()).toEqual([{ name: "change", detail: { value: 80, fraction: 0.8 } }]);
    });

    it("reports a later page move to the position a drag painted, after the page put that drag back", async () => {
      stubRect();
      startDrag(37);
      moveTo(350, 37);
      rootEl().setAttribute("data-stimeo--resizable-value-value", "50");
      controllerFor().valueValueChanged();
      await flushMicrotasks();
      release(37);
      expect(reports()).toEqual([]);

      // The page's move back to 50 is what the separator now shows, so a page
      // move to 70 is a move again, even though the drag had painted 70 before.
      rootEl().setAttribute("data-stimeo--resizable-value-value", "70");
      controllerFor().valueValueChanged();
      await flushMicrotasks();

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("70");
      expect(reports()).toEqual([{ name: "reconcile", detail: { value: 70, fraction: 0.7 } }]);
    });

    it.each([
      ["a script writes the value just before the key", false],
      ["a keydown listener ahead of the separator writes the value", true],
    ] as const)(
      "reports a page write folded into a key once, as that key's change, when %s",
      async (_case, ahead) => {
        const write = (): void => {
          rootEl().setAttribute("data-stimeo--resizable-value-value", "80");
        };
        const writeAhead = (event: Event): void => {
          if ((event as KeyboardEvent).key === "End") write();
        };
        if (ahead) document.addEventListener("keydown", writeAhead, true);
        else write();
        splitterEl().focus();

        press(splitterEl(), "End");
        document.removeEventListener("keydown", writeAhead, true);
        controllerFor().valueValueChanged();
        await flushMicrotasks();

        expect(splitterEl().getAttribute("aria-valuenow")).toBe("80");
        expect(reports()).toEqual([{ name: "change", detail: { value: 80, fraction: 0.8 } }]);
      },
    );

    it("reports nothing when a page write and a key in one task end on the position last confirmed", async () => {
      splitterEl().focus();

      rootEl().setAttribute("data-stimeo--resizable-value-value", "51");
      press(splitterEl(), "ArrowLeft");
      controllerFor().valueValueChanged();
      await flushMicrotasks();

      expect(splitterEl().getAttribute("aria-valuenow")).toBe("50");
      expect(reports()).toEqual([]);
    });
  });
});
