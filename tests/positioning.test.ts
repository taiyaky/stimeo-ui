import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the opt-in `stimeo-ui/positioning` helper.
 *
 * `@floating-ui/dom` is mocked so the wrapper's contract is asserted
 * deterministically (no real layout, which happy-dom cannot model): which
 * middleware are selected from the options, that the computed coordinates land as
 * inline styles, and that `attachPositioning` wires `autoUpdate` and returns its
 * cleanup. Real-layout flip/shift behavior is covered by the real-browser e2e
 * layer, not here.
 */

const computePosition = vi.fn();
const autoUpdate = vi.fn();
const offset = vi.fn((value: number) => ({ name: "offset", value }));
const flip = vi.fn((opts: unknown) => ({ name: "flip", opts }));
const shift = vi.fn((opts: unknown) => ({ name: "shift", opts }));

vi.mock("@floating-ui/dom", () => ({
  computePosition,
  autoUpdate,
  offset,
  flip,
  shift,
}));

// Imported after the mock is registered so the wrapper binds the mocked exports.
const { position, attachPositioning } = await import("../src/positioning/index");

/** Shape of the `computePosition` config our wrapper builds (third argument). */
interface CapturedConfig {
  placement: string;
  strategy: string;
  middleware: { name: string }[];
}

/** Returns the config from the most recent `computePosition` call, throwing if none. */
function lastConfig(): CapturedConfig {
  const call = computePosition.mock.calls.at(-1);
  if (!call) throw new Error("computePosition was not called");
  return call[2] as CapturedConfig;
}

/** Returns the arguments of the most recent `autoUpdate` call, throwing if none. */
function lastAutoUpdateArgs(): [Element, HTMLElement, () => void] {
  const call = autoUpdate.mock.calls.at(-1);
  if (!call) throw new Error("autoUpdate was not called");
  return call as unknown as [Element, HTMLElement, () => void];
}

describe("positioning — position()", () => {
  let anchor: HTMLElement;
  let floating: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<button id="a">anchor</button><div id="f">float</div>';
    anchor = document.getElementById("a") as HTMLElement;
    floating = document.getElementById("f") as HTMLElement;
    computePosition.mockResolvedValue({ x: 12, y: 34, placement: "bottom", strategy: "absolute" });
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("writes the computed coordinates as inline styles and nothing else", async () => {
    await position(anchor, floating);
    expect(floating.style.position).toBe("absolute");
    expect(floating.style.left).toBe("12px");
    expect(floating.style.top).toBe("34px");
    // No decoration leaks in: only positioning properties are touched.
    expect(floating.style.color).toBe("");
    expect(floating.style.border).toBe("");
  });

  it("defaults to bottom placement with flip + shift middleware", async () => {
    await position(anchor, floating);
    const config = lastConfig();
    expect(config.placement).toBe("bottom");
    expect(config.strategy).toBe("absolute");
    const names = config.middleware.map((m: { name: string }) => m.name);
    expect(names).toEqual(["flip", "shift"]);
  });

  it("adds offset middleware first when an offset is given", async () => {
    await position(anchor, floating, { offset: 8, placement: "top-start" });
    const config = lastConfig();
    expect(config.placement).toBe("top-start");
    expect(offset).toHaveBeenCalledWith(8);
    const names = config.middleware.map((m: { name: string }) => m.name);
    expect(names).toEqual(["offset", "flip", "shift"]);
  });

  it("omits flip and shift when disabled", async () => {
    await position(anchor, floating, { flip: false, shift: false });
    const config = lastConfig();
    expect(config.middleware).toEqual([]);
  });

  it("passes padding to flip and shift", async () => {
    await position(anchor, floating, { padding: 10 });
    expect(flip).toHaveBeenCalledWith({ padding: 10 });
    expect(shift).toHaveBeenCalledWith({ padding: 10 });
  });

  it("honors the fixed strategy", async () => {
    await position(anchor, floating, { strategy: "fixed" });
    const config = lastConfig();
    expect(config.strategy).toBe("fixed");
    expect(floating.style.position).toBe("fixed");
  });

  it("returns the resolved coordinates and final (post-flip) placement", async () => {
    // The mock resolves to "bottom" regardless of the requested side, standing in
    // for a flip; the return surfaces that resolved placement to the caller.
    const result = await position(anchor, floating, { placement: "top" });
    expect(result).toEqual({ x: 12, y: 34, placement: "bottom" });
  });
});

describe("positioning — attachPositioning()", () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="a">anchor</button><div id="f">float</div>';
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("registers autoUpdate and returns its cleanup function", () => {
    const cleanup = vi.fn();
    autoUpdate.mockReturnValue(cleanup);
    const anchor = document.getElementById("a") as HTMLElement;
    const floating = document.getElementById("f") as HTMLElement;

    const stop = attachPositioning(anchor, floating, { placement: "right" });
    expect(autoUpdate).toHaveBeenCalledTimes(1);
    const [updatedAnchor, updatedFloating] = lastAutoUpdateArgs();
    expect(updatedAnchor).toBe(anchor);
    expect(updatedFloating).toBe(floating);
    expect(stop).toBe(cleanup);
  });

  it("repositions on each autoUpdate callback", async () => {
    computePosition.mockResolvedValue({ x: 1, y: 2, placement: "right", strategy: "absolute" });
    let scheduled: (() => void) | undefined;
    autoUpdate.mockImplementation((_a, _f, cb: () => void) => {
      scheduled = cb;
      return () => undefined;
    });
    const anchor = document.getElementById("a") as HTMLElement;
    const floating = document.getElementById("f") as HTMLElement;

    attachPositioning(anchor, floating);
    expect(scheduled).toBeTypeOf("function");
    scheduled?.();
    await vi.waitFor(() => expect(computePosition).toHaveBeenCalled());
  });

  it("passes the resolved result to onComputed on each update", async () => {
    computePosition.mockResolvedValue({
      x: 5,
      y: 6,
      placement: "left-start",
      strategy: "absolute",
    });
    let scheduled: (() => void) | undefined;
    autoUpdate.mockImplementation((_a, _f, cb: () => void) => {
      scheduled = cb;
      return () => undefined;
    });
    const anchor = document.getElementById("a") as HTMLElement;
    const floating = document.getElementById("f") as HTMLElement;
    const onComputed = vi.fn();

    attachPositioning(anchor, floating, {}, onComputed);
    scheduled?.();
    await vi.waitFor(() =>
      expect(onComputed).toHaveBeenCalledWith({ x: 5, y: 6, placement: "left-start" }),
    );
  });
});
