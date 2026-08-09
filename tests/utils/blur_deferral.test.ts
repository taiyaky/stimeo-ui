import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlurDeferral } from "../../src/utils/blur_deferral";

/**
 * Unit tests for {@link BlurDeferral}: the registry that holds a destructive
 * update back while an element has focus. It owns listener attachment, teardown,
 * and the release callback — never what the deferred update is.
 */
describe("BlurDeferral", () => {
  let buttons: HTMLButtonElement[];

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="a">A</button>
      <button id="b">B</button>
      <button id="c">C</button>`;
    buttons = Array.from(document.querySelectorAll("button"));
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  const at = (index: number): HTMLButtonElement => buttons[index] as HTMLButtonElement;
  const blur = (element: HTMLElement) => element.dispatchEvent(new FocusEvent("blur"));

  it("starts empty", () => {
    const deferral = new BlurDeferral(vi.fn());
    expect(deferral.size).toBe(0);
    expect(deferral.elements).toEqual([]);
    expect(deferral.has(at(0))).toBe(false);
  });

  it("reports a deferred element as pending", () => {
    const deferral = new BlurDeferral(vi.fn());
    deferral.defer(at(0));

    expect(deferral.size).toBe(1);
    expect(deferral.has(at(0))).toBe(true);
    expect(deferral.has(at(1))).toBe(false);
    expect(deferral.elements).toEqual([at(0)]);
  });

  it("completes the deferral on blur, detaching before the callback runs", () => {
    const onRelease = vi.fn();
    const deferral = new BlurDeferral(onRelease);
    deferral.defer(at(0));

    blur(at(0));

    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledWith(at(0));
    expect(deferral.size).toBe(0);
  });

  it("passes the blurred element so one registry can serve many", () => {
    const seen: HTMLElement[] = [];
    const deferral = new BlurDeferral((element) => seen.push(element));
    deferral.defer(at(0));
    deferral.defer(at(1));

    blur(at(1));
    expect(seen).toEqual([at(1)]);
    expect(deferral.elements).toEqual([at(0)]);

    blur(at(0));
    expect(seen).toEqual([at(1), at(0)]);
  });

  it("is idempotent: deferring a pending element does not stack listeners", () => {
    const onRelease = vi.fn();
    const deferral = new BlurDeferral(onRelease);
    deferral.defer(at(0));
    deferral.defer(at(0));

    expect(deferral.size).toBe(1);
    blur(at(0));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("release() cancels a deferral without completing it", () => {
    const onRelease = vi.fn();
    const deferral = new BlurDeferral(onRelease);
    deferral.defer(at(0));

    deferral.release(at(0));
    expect(deferral.size).toBe(0);

    // The listener is really gone: a later blur must not resurrect the update.
    blur(at(0));
    expect(onRelease).not.toHaveBeenCalled();
  });

  it("release() no-ops for an element that was never deferred", () => {
    const onRelease = vi.fn();
    const deferral = new BlurDeferral(onRelease);
    deferral.defer(at(0));

    expect(() => deferral.release(at(1))).not.toThrow();
    expect(deferral.elements).toEqual([at(0)]);
  });

  it("releaseAll() cancels every deferral without completing any", () => {
    const onRelease = vi.fn();
    const deferral = new BlurDeferral(onRelease);
    deferral.defer(at(0));
    deferral.defer(at(1));

    deferral.releaseAll();

    expect(deferral.size).toBe(0);
    blur(at(0));
    blur(at(1));
    expect(onRelease).not.toHaveBeenCalled();
  });

  it("releaseAll() clears the registry whatever its size", () => {
    const deferral = new BlurDeferral(vi.fn());
    for (const button of buttons) deferral.defer(button);

    deferral.releaseAll();

    expect(deferral.size).toBe(0);
  });

  it("deferOnly() leaves exactly one pending element", () => {
    const onRelease = vi.fn();
    const deferral = new BlurDeferral(onRelease);
    deferral.defer(at(0));
    deferral.defer(at(1));

    deferral.deferOnly(at(2));

    expect(deferral.elements).toEqual([at(2)]);
    blur(at(0));
    blur(at(1));
    expect(onRelease).not.toHaveBeenCalled();
  });

  it("deferOnly() keeps the existing listener when the element is already pending", () => {
    const onRelease = vi.fn();
    const deferral = new BlurDeferral(onRelease);
    deferral.defer(at(0));

    deferral.deferOnly(at(0));

    expect(deferral.size).toBe(1);
    blur(at(0));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("lets the release callback re-defer the same element", () => {
    // The entry is detached before the callback, so a controller that decides the
    // update is still not safe can simply defer again.
    const deferral: BlurDeferral = new BlurDeferral((element) => {
      if (deferral.size === 0) deferral.defer(element);
    });
    deferral.defer(at(0));

    blur(at(0));
    expect(deferral.elements).toEqual([at(0)]);
  });

  it("elements is a snapshot, not the live key set", () => {
    const deferral = new BlurDeferral(vi.fn());
    deferral.defer(at(0));

    const snapshot = deferral.elements;
    deferral.releaseAll();

    expect(snapshot).toEqual([at(0)]);
    expect(deferral.elements).toEqual([]);
  });

  it("narrows the element type it hands back", () => {
    const seen: HTMLButtonElement[] = [];
    const deferral = new BlurDeferral<HTMLButtonElement>((button) => {
      // `button.disabled` only type-checks because the registry is generic.
      if (!button.disabled) seen.push(button);
    });
    deferral.defer(at(0));

    blur(at(0));
    expect(seen).toEqual([at(0)]);
  });
});
