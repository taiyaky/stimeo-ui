import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for the opt-in {@link AnchoredController}.
 *
 * `@floating-ui/dom` is mocked (happy-dom cannot model layout), so these assert
 * the controller's *contract* deterministically: it attaches tracking when
 * `active`, maps Values to the engine, mirrors the resolved placement onto
 * `data-anchored-placement` + emits `position`, re-applies on option changes only
 * while tracking, and releases the observer on deactivate/disconnect. Real
 * flip/shift behavior is covered by the real-browser e2e layer.
 */

const computePosition = vi.fn();
const autoUpdate = vi.fn();
const offset = vi.fn((value: number) => ({ name: "offset", value }));
const flip = vi.fn((opts: unknown) => ({ name: "flip", opts }));
const shift = vi.fn((opts: unknown) => ({ name: "shift", opts }));

vi.mock("@floating-ui/dom", () => ({ computePosition, autoUpdate, offset, flip, shift }));

// Imported after the mock so the controller's positioning chain binds the mock.
const { AnchoredController } = await import("../src/positioning/anchored_controller");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    application?.stop();
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

  it("has no a11y violations", async () => {
    await mount();
    await runUpdate();
    await expectNoA11yViolations(query("#root"));
  });
});
