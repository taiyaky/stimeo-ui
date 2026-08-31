import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for the opt-in {@link AnchoredController}.
 *
 * `@floating-ui/dom` is mocked (happy-dom cannot model layout), so these assert
 * the controller's *contract* deterministically: it attaches tracking when
 * `active`, maps Values to the engine, mirrors the resolved placement onto
 * `data-anchored-placement` + emits `position`, re-applies on option changes only
 * while tracking, and releases the observer on deactivate/disconnect. Real
 * flip/shift behavior needs a real browser and is out of scope here.
 */

const computePosition = vi.fn();
const autoUpdate = vi.fn();
const offset = vi.fn((value: number) => ({ name: "offset", value }));
const flip = vi.fn((opts: unknown) => ({ name: "flip", opts }));
const shift = vi.fn((opts: unknown) => ({ name: "shift", opts }));

vi.mock("@floating-ui/dom", () => ({ computePosition, autoUpdate, offset, flip, shift }));

// Imported after the mock so the controller's positioning chain binds the mock.
const { AnchoredController } = await import("../src/positioning/anchored_controller");

interface PositionDetail {
  placement: string;
  x: number;
  y: number;
}

describe("AnchoredController", () => {
  let application: Application;
  let cleanup: ReturnType<typeof vi.fn>;

  const mount = async (attrs = "") => {
    document.body.innerHTML = `
      <div id="root" data-controller="stimeo--anchored" ${attrs}>
        <button id="anchor" data-stimeo--anchored-target="anchor">Open</button>
        <div id="floating" data-stimeo--anchored-target="floating" role="tooltip">Details</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--anchored", AnchoredController);
    await tick();
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    cleanup = vi.fn();
    // autoUpdate captures the positioning callback and returns the cleanup spy; it
    // does not auto-run the callback, so tests drive a pass explicitly via runUpdate.
    autoUpdate.mockReturnValue(cleanup);
    computePosition.mockResolvedValue({
      x: 12,
      y: 34,
      placement: "top-start",
      strategy: "absolute",
    });
  });

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  /** Runs the latest autoUpdate callback (one positioning pass) + flushes microtasks. */
  const runUpdate = async () => {
    const call = autoUpdate.mock.calls.at(-1);
    if (!call) throw new Error("autoUpdate was not called");
    (call[2] as () => void)();
    await tick();
  };

  const setValue = async (name: string, value: string) => {
    query("#root").setAttribute(`data-stimeo--anchored-${name}-value`, value);
    await tick();
  };

  it("attaches tracking once on connect when active (the default)", async () => {
    await mount();
    expect(autoUpdate).toHaveBeenCalledTimes(1);
    const [anchor, floating] = autoUpdate.mock.calls[0] as [Element, HTMLElement];
    expect(anchor).toBe(query("#anchor"));
    expect(floating).toBe(query("#floating"));
  });

  it("writes coordinates, mirrors the resolved placement, and emits position per update", async () => {
    await mount();
    const details: PositionDetail[] = [];
    query("#root").addEventListener("stimeo--anchored:position", (event) => {
      details.push((event as CustomEvent<PositionDetail>).detail);
    });

    await runUpdate();

    const floating = query("#floating");
    expect(floating.style.position).toBe("absolute");
    expect(floating.style.left).toBe("12px");
    expect(floating.style.top).toBe("34px");
    expect(floating.getAttribute("data-anchored-placement")).toBe("top-start");
    expect(details).toEqual([{ placement: "top-start", x: 12, y: 34 }]);
  });

  it("maps Values to the positioning engine options", async () => {
    await mount(
      'data-stimeo--anchored-placement-value="right" data-stimeo--anchored-offset-value="8"',
    );
    await runUpdate();
    expect(offset).toHaveBeenCalledWith(8);
    const config = computePosition.mock.calls.at(-1)?.[2] as { placement: string };
    expect(config.placement).toBe("right");
  });

  it("does not attach when active is false", async () => {
    await mount('data-stimeo--anchored-active-value="false"');
    expect(autoUpdate).not.toHaveBeenCalled();
  });

  it("stays inert (no attach, no throw) when the targets are missing", async () => {
    // active defaults to true, but with neither anchor nor floating there is nothing
    // to position — #attach guards on the targets and creates no observer.
    document.body.innerHTML = '<div id="root" data-controller="stimeo--anchored"></div>';
    application = Application.start();
    application.register("stimeo--anchored", AnchoredController);
    await tick();
    expect(autoUpdate).not.toHaveBeenCalled();
  });

  it("honors the fixed positioning strategy", async () => {
    await mount('data-stimeo--anchored-strategy-value="fixed"');
    await runUpdate();
    const config = computePosition.mock.calls.at(-1)?.[2] as { strategy: string };
    expect(config.strategy).toBe("fixed");
    expect(query("#floating").style.position).toBe("fixed");
  });

  it("detaches when active flips to false and re-attaches when it returns", async () => {
    await mount();
    expect(autoUpdate).toHaveBeenCalledTimes(1);

    await setValue("active", "false");
    expect(cleanup).toHaveBeenCalledTimes(1);

    await setValue("active", "true");
    expect(autoUpdate).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(1); // the second attach is still live
  });

  it("re-applies (detach + re-attach) on an option change while tracking", async () => {
    await mount();
    expect(autoUpdate).toHaveBeenCalledTimes(1);

    await setValue("placement", "left");
    expect(cleanup).toHaveBeenCalledTimes(1); // old observer released
    expect(autoUpdate).toHaveBeenCalledTimes(2); // re-attached with new options
  });

  it("ignores option changes while inactive (no spurious tracking)", async () => {
    await mount('data-stimeo--anchored-active-value="false"');
    await setValue("placement", "left");
    expect(autoUpdate).not.toHaveBeenCalled();
  });

  it("releases the observer on disconnect", async () => {
    await mount();
    query("#root").remove();
    await tick();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("re-attaches to a floating target swapped in at runtime", async () => {
    await mount();
    await runUpdate();
    const fresh = document.createElement("div");
    fresh.id = "fresh-floating";
    fresh.setAttribute("data-stimeo--anchored-target", "floating");
    fresh.setAttribute("role", "tooltip");
    query("#floating").replaceWith(fresh);
    await tick();

    // The engine holds the element it was handed, so a swap has to re-attach or
    // it keeps measuring and writing to the node that just left the document.
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(autoUpdate).toHaveBeenCalledTimes(2);
    expect((autoUpdate.mock.calls.at(-1) as [Element, HTMLElement])[1]).toBe(fresh);

    await runUpdate();
    expect(fresh.style.left).toBe("12px");
    expect(fresh.getAttribute("data-anchored-placement")).toBe("top-start");
  });

  it("re-attaches to an anchor swapped in at runtime", async () => {
    await mount();
    const fresh = document.createElement("button");
    fresh.id = "fresh-anchor";
    fresh.setAttribute("data-stimeo--anchored-target", "anchor");
    query("#anchor").replaceWith(fresh);
    await tick();

    expect(autoUpdate).toHaveBeenCalledTimes(2);
    expect((autoUpdate.mock.calls.at(-1) as [Element, HTMLElement])[0]).toBe(fresh);
  });

  it("starts tracking when the targets arrive after connect", async () => {
    document.body.innerHTML = '<div id="root" data-controller="stimeo--anchored"></div>';
    application = Application.start();
    application.register("stimeo--anchored", AnchoredController);
    await tick();
    expect(autoUpdate).not.toHaveBeenCalled();

    const root = query("#root");
    const anchor = document.createElement("button");
    anchor.setAttribute("data-stimeo--anchored-target", "anchor");
    const floating = document.createElement("div");
    floating.setAttribute("data-stimeo--anchored-target", "floating");
    root.append(anchor, floating);
    await tick();

    // A stream that renders the frame first and fills it in later still gets
    // positioned; nothing else would ever start the tracking.
    expect(autoUpdate).toHaveBeenCalledTimes(1);
  });

  it("drops a pass that lands after the floating target left", async () => {
    await mount();
    const floating = query("#floating");
    const call = autoUpdate.mock.calls.at(-1) as unknown[];
    (call[2] as () => void)(); // start a pass; the computation is still pending
    floating.remove();
    await tick();
    await tick();
    // Reaching for a target that has left rejects inside the engine's promise
    // chain — one unhandled rejection per tracked update, which fails this file.
    expect(floating.hasAttribute("data-anchored-placement")).toBe(false);
  });

  it("neither writes nor dispatches once the controller is gone", async () => {
    await mount();
    const root = query("#root");
    const floating = query("#floating");
    const seen: unknown[] = [];
    root.addEventListener("stimeo--anchored:position", (event) => seen.push(event));
    const call = autoUpdate.mock.calls.at(-1) as unknown[];
    (call[2] as () => void)();
    root.remove();
    await tick();
    await tick();

    // The cleanup stops future updates but cannot cancel one already computing,
    // so the landing pass is what has to stand down.
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    expect(floating.hasAttribute("data-anchored-placement")).toBe(false);
  });

  it("drops a pass from an attach that was superseded on the same elements", async () => {
    await mount('data-stimeo--anchored-offset-value="8"');
    let landStale!: (result: unknown) => void;
    computePosition.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          landStale = resolve;
        }),
    );
    const call = autoUpdate.mock.calls[0] as unknown[];
    (call[2] as () => void)(); // a pass is now in flight against the first attach

    await setValue("offset", "0"); // re-attaches against the very same pair

    const seen: unknown[] = [];
    query("#root").addEventListener("stimeo--anchored:position", (event) => seen.push(event));
    landStale({ x: 99, y: 88, placement: "left", strategy: "absolute" });
    await tick();

    // Neither element changed, so only the attach's own identity separates the
    // superseded pass from the live one.
    expect(seen).toEqual([]);
    expect(query("#floating").getAttribute("data-anchored-placement")).toBeNull();
  });

  it("falls back to the default placement when the declaration is not one", async () => {
    await mount('data-stimeo--anchored-placement-value="sideways"');
    await runUpdate();
    const config = computePosition.mock.calls.at(-1)?.[2] as { placement: string };
    // The hook is a published CSS contract carrying a resolved placement, so a
    // value outside the set must not reach it.
    expect(config.placement).toBe("bottom");
  });

  it("falls back to no offset and no padding when they are not finite", async () => {
    await mount(
      'data-stimeo--anchored-offset-value="1e999" data-stimeo--anchored-padding-value="oops"',
    );
    await runUpdate();
    // A non-finite value poisons the computed coordinate, and the browser drops
    // the whole declaration, leaving that axis wherever CSS had it.
    expect(offset).not.toHaveBeenCalled();
    expect(flip).toHaveBeenCalledWith({ padding: 0 });
    expect(shift).toHaveBeenCalledWith({ padding: 0 });
  });

  it("maps flip, shift, and padding onto the engine", async () => {
    await mount('data-stimeo--anchored-flip-value="false" data-stimeo--anchored-padding-value="6"');
    await runUpdate();
    expect(flip).not.toHaveBeenCalled();
    expect(shift).toHaveBeenCalledWith({ padding: 6 });

    vi.clearAllMocks();
    autoUpdate.mockReturnValue(cleanup);
    computePosition.mockResolvedValue({ x: 1, y: 2, placement: "bottom", strategy: "absolute" });
    await setValue("shift", "false");
    await runUpdate();
    expect(shift).not.toHaveBeenCalled();
  });

  it("does not re-attach when a rewritten Value resolves to the same options", async () => {
    await mount();
    expect(autoUpdate).toHaveBeenCalledTimes(1);
    // Writing the default explicitly is a real attribute change, so only the key
    // comparison keeps the burst from stacking attach/detach cycles.
    await setValue("placement", "bottom");
    expect(cleanup).not.toHaveBeenCalled();
    expect(autoUpdate).toHaveBeenCalledTimes(1);
  });

  it("collapses a multi-attribute batch into a single re-attach", async () => {
    await mount();
    const root = query("#root");
    root.setAttribute("data-stimeo--anchored-placement-value", "left");
    root.setAttribute("data-stimeo--anchored-offset-value", "12");
    await tick();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(autoUpdate).toHaveBeenCalledTimes(2);
  });

  it("has no a11y violations", async () => {
    await mount();
    await runUpdate();
    await expectNoA11yViolations(query("#root"));
  });
});
