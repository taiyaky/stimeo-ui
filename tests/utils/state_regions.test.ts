import { describe, expect, it, vi } from "vitest";
import { StateRegions } from "../../src/utils/state_regions";

/**
 * Behavioral tests for {@link StateRegions}: that a declared region follows the state
 * it belongs to, that a pair moves only where both halves are present inside the same
 * host, that hosts are independent of one another, and that an unchanged side is left
 * alone rather than written again.
 */
describe("state regions", () => {
  const mount = (html: string): HTMLElement => {
    document.body.innerHTML = html;
    return document.body.firstElementChild as HTMLElement;
  };
  const all = (root: ParentNode, selector: string): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(selector));

  describe("one side", () => {
    const regions = (root: ParentNode) =>
      new StateRegions({ whenTrue: () => all(root, "[data-region]") });

    it("shows every region while the state holds and hides them when it lifts", () => {
      const host = mount(`<div><p data-region hidden>a</p><p data-region hidden>b</p></div>`);
      const state = regions(host);

      state.reflect(host, true);
      expect(all(host, "[data-region]").map((el) => el.hidden)).toEqual([false, false]);

      state.reflect(host, false);
      expect(all(host, "[data-region]").map((el) => el.hidden)).toEqual([true, true]);
    });

    it("overrides the visibility the author wrote", () => {
      const host = mount(`<div><p data-region>shown by the author</p></div>`);

      regions(host).reflect(host, false);

      expect(all(host, "[data-region]")[0]?.hidden).toBe(true);
    });

    it("leaves a region that sits outside the host alone", () => {
      const root = mount(`<div><section id="host"></section><p data-region hidden>a</p></div>`);
      const host = root.querySelector("#host") as HTMLElement;

      new StateRegions({ whenTrue: () => all(root, "[data-region]") }).reflect(host, true);

      expect(all(root, "[data-region]")[0]?.hidden).toBe(true);
    });
  });

  describe("a pair", () => {
    const labels = (root: ParentNode) =>
      new StateRegions({
        whenTrue: () => all(root, "[data-on]"),
        whenFalse: () => all(root, "[data-off]"),
      });

    it("shows the half that belongs to the state and hides the other", () => {
      const host = mount(`<button><span data-off>open</span><span data-on>close</span></button>`);
      const state = labels(host);

      state.reflect(host, true);
      expect([
        (host.querySelector("[data-on]") as HTMLElement).hidden,
        (host.querySelector("[data-off]") as HTMLElement).hidden,
      ]).toEqual([false, true]);

      state.reflect(host, false);
      expect([
        (host.querySelector("[data-on]") as HTMLElement).hidden,
        (host.querySelector("[data-off]") as HTMLElement).hidden,
      ]).toEqual([true, false]);
    });

    it.each([
      ["only the true half", `<button><span data-on>close</span></button>`],
      ["only the false half", `<button><span data-off>open</span></button>`],
    ])("leaves a lone %s as the author wrote it", (_case, html) => {
      const host = mount(html);

      labels(host).reflect(host, true);

      expect((host.firstElementChild as HTMLElement).hidden).toBe(false);
    });

    it("keeps a lone half the author hid out of view", () => {
      const host = mount(`<button><span data-on hidden>close</span></button>`);

      labels(host).reflect(host, true);

      expect((host.firstElementChild as HTMLElement).hidden).toBe(true);
    });

    it("gives the half it hid back when the pair loses its other side", () => {
      // A pair narrows to one half while the widget runs. The survivor was taken out
      // of view only to make room for the half that is gone, so leaving it there is
      // a control with no label at all.
      const host = mount(`<button><span data-off>open</span><span data-on>close</span></button>`);
      const state = labels(host);
      state.reflect(host, false);
      const on = host.querySelector("[data-on]") as HTMLElement;
      expect(on.hidden).toBe(true);

      (host.querySelector("[data-off]") as HTMLElement).remove();
      state.reflect(host, false);

      expect(on.hidden).toBe(false);
    });

    it("pairs each half with the host it sits in, not with the ones beside it", () => {
      const root = mount(`<div>
        <button id="first"><span data-off>a-open</span><span data-on>a-close</span></button>
        <button id="second"><span data-off>b-open</span><span data-on>b-close</span></button>
      </div>`);
      const state = labels(root);
      const first = root.querySelector("#first") as HTMLElement;
      const second = root.querySelector("#second") as HTMLElement;

      state.reflect(first, true);
      state.reflect(second, false);

      expect((first.querySelector("[data-on]") as HTMLElement).hidden).toBe(false);
      expect((second.querySelector("[data-on]") as HTMLElement).hidden).toBe(true);
      expect((second.querySelector("[data-off]") as HTMLElement).hidden).toBe(false);
    });

    it("refuses a host whose halves are split across two hosts", () => {
      const root = mount(`<div>
        <button id="first"><span data-off>open</span></button>
        <button id="second"><span data-on>close</span></button>
      </div>`);
      const state = labels(root);
      const first = root.querySelector("#first") as HTMLElement;

      state.reflect(first, true);

      expect((first.querySelector("[data-off]") as HTMLElement).hidden).toBe(false);
    });
  });

  it("writes a side only where it moves", () => {
    const host = mount(
      `<button><span data-off>open</span><span data-on hidden>close</span></button>`,
    );
    const state = new StateRegions({
      whenTrue: () => all(host, "[data-on]"),
      whenFalse: () => all(host, "[data-off]"),
    });
    const on = host.querySelector("[data-on]") as HTMLElement;
    const off = host.querySelector("[data-off]") as HTMLElement;

    state.reflect(host, true);
    // Counted after the transition: a second reflection of the same state must not
    // write again, or a consumer watching its own subtree re-enters on every pass.
    const shows = vi.spyOn(on, "removeAttribute");
    const hides = vi.spyOn(off, "setAttribute");
    state.reflect(host, true);
    state.reflect(host, true);

    expect(shows).not.toHaveBeenCalled();
    expect(hides).not.toHaveBeenCalled();
    shows.mockRestore();
    hides.mockRestore();
  });
});
