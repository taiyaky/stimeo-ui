import { afterEach, describe, expect, it, vi } from "vitest";
import { HoverRecheck } from "../../src/utils/hover_recheck";

/** Verifies single-use hover readings and cancellation across synchronous callback reentry. */
describe("HoverRecheck", () => {
  const waits: HoverRecheck[] = [];

  afterEach(() => {
    for (const wait of waits) wait.dispose();
    waits.length = 0;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  const create = (onRelease: (element: Element) => void = () => {}, source = document) => {
    const release = vi.fn(onRelease);
    const wait = new HoverRecheck(source, release);
    waits.push(wait);
    return { wait, release };
  };

  /** Models hovered and non-hovered branches without native hit testing. */
  const element = (hovered = false) => {
    const node = document.createElement("div");
    const matches = vi.spyOn(node, "matches").mockReturnValue(hovered);
    document.body.append(node);
    return { node, matches };
  };

  const move = (source = document) =>
    source.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));

  it("waits for a pointer movement and reads each distinct element once", () => {
    const { wait, release } = create();
    const a = element();
    const b = element();
    wait.wait(a.node);
    wait.wait(a.node);
    wait.wait(b.node);
    expect(a.matches).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    move();
    expect(a.matches).toHaveBeenCalledExactlyOnceWith(":hover");
    expect(b.matches).toHaveBeenCalledExactlyOnceWith(":hover");
    expect(release.mock.calls).toEqual([[a.node], [b.node]]);
    move();
    expect(a.matches).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("consumes a hovered element without releasing it or reading it again", () => {
    const { wait, release } = create();
    const a = element(true);
    wait.wait(a.node);
    move();
    a.matches.mockReturnValue(false);
    move();
    expect(a.matches).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    wait.wait(a.node);
    move();
    expect(release).toHaveBeenCalledExactlyOnceWith(a.node);
  });

  it("cancels one element while keeping other elements waiting", () => {
    const { wait, release } = create();
    const a = element();
    const b = element();
    wait.wait(a.node);
    wait.wait(b.node);
    wait.cancel(a.node);
    move();
    expect(a.matches).not.toHaveBeenCalled();
    expect(release.mock.calls).toEqual([[b.node]]);
  });

  it("registers capture and passive with a signal, and aborts the last cancelled wait", () => {
    const add = vi.spyOn(document, "addEventListener");
    const { wait } = create();
    const a = element();
    wait.wait(a.node);
    const registration = add.mock.calls.find(([type]) => type === "pointermove");
    expect(registration).toBeDefined();
    const options = registration?.[2];
    if (!options || typeof options !== "object" || !options.signal) {
      throw new Error("A signal-owned pointer listener is required");
    }
    expect(options.capture).toBe(true);
    expect(options.passive).toBe(true);
    expect(options.signal.aborted).toBe(false);
    wait.cancel(a.node);
    expect(options.signal.aborted).toBe(true);
  });

  it("aborts the listener before invoking a release callback", () => {
    const add = vi.spyOn(document, "addEventListener");
    const released = vi.fn(() => {
      const options = add.mock.calls.find(([type]) => type === "pointermove")?.[2];
      if (!options || typeof options !== "object") throw new Error("Missing listener options");
      expect(options.signal?.aborted).toBe(true);
    });
    const { wait } = create(released);
    wait.wait(element().node);
    move();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("disposes without releasing and can wait again on a new connection", () => {
    const { wait, release } = create();
    const a = element();
    wait.dispose();
    wait.wait(a.node);
    wait.dispose();
    wait.dispose();
    move();
    expect(a.matches).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    wait.wait(a.node);
    move();
    expect(release).toHaveBeenCalledExactlyOnceWith(a.node);
  });

  it("cancels an unprocessed entry during another entry's callback", () => {
    const a = element();
    const b = element();
    const { wait, release } = create(vi.fn(() => wait.cancel(b.node)));
    wait.wait(a.node);
    wait.wait(b.node);
    move();
    expect(release).toHaveBeenCalledExactlyOnceWith(a.node);
    expect(b.matches).not.toHaveBeenCalled();
  });

  it("disposes an unprocessed batch during a callback", () => {
    const a = element();
    const b = element();
    const { wait, release } = create(vi.fn(() => wait.dispose()));
    wait.wait(a.node);
    wait.wait(b.node);
    move();
    expect(release).toHaveBeenCalledExactlyOnceWith(a.node);
    expect(b.matches).not.toHaveBeenCalled();
  });

  it("keeps a callback's new wait for the next pointer movement", () => {
    const a = element();
    const b = element();
    const { wait, release } = create(
      vi.fn((node: Element) => {
        if (node === a.node) wait.wait(b.node);
      }),
    );
    wait.wait(a.node);
    wait.wait(b.node);
    move();
    expect(release.mock.calls).toEqual([[a.node]]);
    expect(b.matches).not.toHaveBeenCalled();
    move();
    expect(release.mock.calls).toEqual([[a.node], [b.node]]);
  });

  it("retains a new wait after a callback disposes the old batch", () => {
    const a = element();
    const b = element();
    const { wait, release } = create(
      vi.fn((node: Element) => {
        if (node === a.node) {
          wait.dispose();
          wait.wait(b.node);
        }
      }),
    );
    wait.wait(a.node);
    wait.wait(b.node);
    move();
    expect(release.mock.calls).toEqual([[a.node]]);
    move();
    expect(release.mock.calls).toEqual([[a.node], [b.node]]);
  });

  it("listens on the supplied document and isolates instances", () => {
    const other = document.implementation.createHTMLDocument("Other");
    const first = create();
    const second = create(vi.fn(), other);
    first.wait.wait(element().node);
    const foreign = other.createElement("div");
    vi.spyOn(foreign, "matches").mockReturnValue(false);
    second.wait.wait(foreign);
    move();
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(second.release).not.toHaveBeenCalled();
    move(other);
    expect(second.release).toHaveBeenCalledExactlyOnceWith(foreign);
  });
});
