import { describe, expect, it, vi } from "vitest";
import { StateRegions } from "../../src/utils/state_regions";
import { flushMicrotasks } from "../helpers/timing";

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
      new StateRegions({ whenTrue: () => all(root, "[data-region]") }, "stimeo--probe");

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

      new StateRegions({ whenTrue: () => all(root, "[data-region]") }, "stimeo--probe").reflect(
        host,
        true,
      );

      expect(all(root, "[data-region]")[0]?.hidden).toBe(true);
    });
  });

  describe("a pair", () => {
    const labels = (root: ParentNode) =>
      new StateRegions(
        {
          whenTrue: () => all(root, "[data-on]"),
          whenFalse: () => all(root, "[data-off]"),
        },
        "stimeo--probe",
      );

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

    it("gives the false half back when the true half is the one that goes", () => {
      const host = mount(`<button><span data-off>open</span><span data-on>close</span></button>`);
      const state = labels(host);
      state.reflect(host, true);
      const off = host.querySelector("[data-off]") as HTMLElement;
      expect(off.hidden).toBe(true);

      (host.querySelector("[data-on]") as HTMLElement).remove();
      state.reflect(host, true);

      expect(off.hidden).toBe(false);
    });

    it("forgets a half once it shows it again, so the author's own hiding stands", () => {
      const host = mount(`<button><span data-off>open</span><span data-on>close</span></button>`);
      const state = labels(host);
      const off = host.querySelector("[data-off]") as HTMLElement;
      state.reflect(host, true);
      state.reflect(host, false);
      expect(off.hidden).toBe(false);

      off.hidden = true;
      (host.querySelector("[data-on]") as HTMLElement).remove();
      state.reflect(host, false);

      expect(off.hidden).toBe(true);
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

  describe("release", () => {
    const labels = (root: ParentNode) =>
      new StateRegions(
        {
          whenTrue: () => all(root, "[data-on]"),
          whenFalse: () => all(root, "[data-off]"),
        },
        "stimeo--probe",
      );
    const pair = `<button><span data-off>open</span><span data-on hidden>close</span></button>`;

    it("hands a pair back as the author wrote it", () => {
      const host = mount(pair);
      const state = labels(host);
      state.reflect(host, true);

      state.release(host);

      expect((host.querySelector("[data-on]") as HTMLElement).hidden).toBe(true);
      expect((host.querySelector("[data-off]") as HTMLElement).hidden).toBe(false);
    });

    it("hands a one-sided region back as the author wrote it", () => {
      const host = mount(`<div><p data-region>shown by the author</p></div>`);
      const state = new StateRegions(
        { whenTrue: () => all(host, "[data-region]") },
        "stimeo--probe",
      );
      state.reflect(host, false);

      state.release(host);

      expect((host.querySelector("[data-region]") as HTMLElement).hidden).toBe(false);
    });

    it("hands a region back with the hidden value the author wrote, until-found included", () => {
      const host = mount(`<div><p data-region hidden="until-found">found on search</p></div>`);
      const region = host.querySelector("[data-region]") as HTMLElement;
      const state = new StateRegions(
        { whenTrue: () => all(host, "[data-region]") },
        "stimeo--probe",
      );
      state.reflect(host, true);
      expect(region.hasAttribute("hidden")).toBe(false);

      state.release(host);

      expect(region.getAttribute("hidden")).toBe("until-found");
    });

    it("keeps a visibility something else wrote after the last reflection", () => {
      const host = mount(pair);
      const state = labels(host);
      state.reflect(host, false);
      const on = host.querySelector("[data-on]") as HTMLElement;
      const off = host.querySelector("[data-off]") as HTMLElement;
      on.hidden = false;
      off.hidden = true;

      state.release(host);

      expect(on.hidden).toBe(false);
      expect(off.hidden).toBe(true);
    });

    it("hands back the regions it wrote even once they are no longer declared", () => {
      const host = mount(pair);
      let declared = true;
      const state = new StateRegions(
        {
          whenTrue: () => (declared ? all(host, "[data-on]") : []),
          whenFalse: () => (declared ? all(host, "[data-off]") : []),
        },
        "stimeo--probe",
      );
      state.reflect(host, true);
      declared = false;

      state.release(host);

      expect((host.querySelector("[data-on]") as HTMLElement).hidden).toBe(true);
      expect((host.querySelector("[data-off]") as HTMLElement).hidden).toBe(false);
    });

    it("hands back a region that is the host itself", () => {
      const root = mount(`<div><p data-region>shown by the author</p></div>`);
      const region = root.querySelector("[data-region]") as HTMLElement;
      const state = new StateRegions(
        { whenTrue: () => all(root, "[data-region]") },
        "stimeo--probe",
      );
      state.reflect(region, false);

      state.release(region);

      expect(region.hidden).toBe(false);
    });

    it("releases only HTML elements, leaving an SVG element that carries a record alone", () => {
      const host = mount(
        `<div><svg data-stimeo--probe-hidden-region="[null,true]"></svg><p data-region>a</p></div>`,
      );
      const svg = host.querySelector("svg") as SVGSVGElement;

      new StateRegions({ whenTrue: () => all(host, "[data-region]") }, "stimeo--probe").release(
        host,
      );

      expect(svg.getAttribute("data-stimeo--probe-hidden-region")).toBe("[null,true]");
    });

    it("leaves a region it never wrote alone", () => {
      const root = mount(`<div>
        <button id="written"><span data-off>a</span><span data-on hidden>b</span></button>
        <button id="untouched"><span data-off hidden>c</span><span data-on hidden>d</span></button>
      </div>`);
      const state = labels(root);
      state.reflect(root.querySelector("#written") as HTMLElement, true);
      const untouched = root.querySelector("#untouched") as HTMLElement;

      state.release(untouched);

      expect(all(untouched, "span").map((el) => el.hidden)).toEqual([true, true]);
    });

    it("leaves the regions of other hosts under this instance's reflection", () => {
      const root = mount(`<div>
        <button id="first"><span data-off>a</span><span data-on hidden>b</span></button>
        <button id="second"><span data-off>c</span><span data-on hidden>d</span></button>
      </div>`);
      const state = labels(root);
      const first = root.querySelector("#first") as HTMLElement;
      const second = root.querySelector("#second") as HTMLElement;
      state.reflect(first, true);
      state.reflect(second, true);

      state.release(first);

      expect(all(first, "span").map((el) => el.hidden)).toEqual([false, true]);
      expect(all(second, "span").map((el) => el.hidden)).toEqual([true, false]);
    });

    it("measures the author's visibility again once a released host is reflected anew", () => {
      const host = mount(pair);
      const state = labels(host);
      const on = host.querySelector("[data-on]") as HTMLElement;
      state.reflect(host, true);
      state.release(host);
      on.hidden = false;

      state.reflect(host, false);
      state.release(host);

      expect(on.hidden).toBe(false);
    });

    it("writes a region only where the release moves it", () => {
      const host = mount(pair);
      const state = labels(host);
      state.reflect(host, false);
      const on = host.querySelector("[data-on]") as HTMLElement;
      const off = host.querySelector("[data-off]") as HTMLElement;
      const writes = [vi.spyOn(on, "setAttribute"), vi.spyOn(off, "removeAttribute")];

      state.release(host);

      for (const write of writes) {
        expect(write).not.toHaveBeenCalled();
        write.mockRestore();
      }
    });
  });

  it("writes a side only where it moves", () => {
    const host = mount(
      `<button><span data-off>open</span><span data-on hidden>close</span></button>`,
    );
    const state = new StateRegions(
      {
        whenTrue: () => all(host, "[data-on]"),
        whenFalse: () => all(host, "[data-off]"),
      },
      "stimeo--probe",
    );
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

  it("costs a watcher of its subtree two attribute mutations on each region a transition moves, and none for a reflection that moves nothing", async () => {
    const host = mount(`<div><span data-on>on</span><span data-off hidden>off</span></div>`);
    const state = new StateRegions(
      { whenTrue: () => all(host, "[data-on]"), whenFalse: () => all(host, "[data-off]") },
      "stimeo--probe",
    );
    state.reflect(host, true);
    const seen: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const side = (record.target as Element).hasAttribute("data-on") ? "on" : "off";
        seen.push(`${side} ${record.attributeName}`);
      }
    });
    observer.observe(host, { attributes: true, subtree: true });
    const moves = async (isTrue: boolean) => {
      seen.length = 0;
      state.reflect(host, isTrue);
      await flushMicrotasks();
      return [...seen];
    };

    expect(await moves(false)).toEqual([
      "on hidden",
      "on data-stimeo--probe-hidden-region",
      "off hidden",
      "off data-stimeo--probe-hidden-region",
    ]);
    expect(await moves(false)).toEqual([]);
    expect(await moves(true)).toHaveLength(4);
    observer.disconnect();
  });
});

/**
 * The record a region keeps of the `hidden` its author wrote, so the connection that
 * adopts a restored clone of the region gives that value back on release.
 */
describe("state regions records", () => {
  const OWNER = "stimeo--probe";
  const RECORD = `data-${OWNER}-hidden-region`;

  /** One region the state shows while it holds, inside its own host. */
  const restoredRegion = (authored: string | null, isTrue: boolean): HTMLElement => {
    document.body.innerHTML = "<div><p data-region>region</p></div>";
    const region = document.querySelector("[data-region]") as HTMLElement;
    if (authored === null) region.removeAttribute("hidden");
    else region.setAttribute("hidden", authored);
    new StateRegions({ whenTrue: () => [region] }, OWNER).reflect(region, isTrue);
    return region.cloneNode(true) as HTMLElement;
  };

  it("gives the author's hidden back from a restored clone", () => {
    for (const [authored, isTrue] of [
      [null, false],
      ["", true],
      ["until-found", true],
    ] as const) {
      const restored = restoredRegion(authored, isTrue);
      document.body.replaceChildren(restored);
      const state = new StateRegions({ whenTrue: () => [restored] }, OWNER);

      state.reflect(restored, isTrue);
      state.release(restored);

      expect(restored.getAttribute("hidden")).toBe(authored);
      expect(restored.hasAttribute(RECORD)).toBe(false);
    }
  });

  it("names the record after the owner, and records the author's hidden with the visibility written last", () => {
    const restored = restoredRegion(null, false);

    expect(restored.getAttribute(RECORD)).toBe("[null,true]");
    expect(RECORD).not.toMatch(/-(value|target|outlet|class|param)$/);
  });

  it("places no record while the region still shows what its author wrote", () => {
    const restored = restoredRegion("", false);

    expect(restored.hasAttribute(RECORD)).toBe(false);
  });

  it("records the author's hidden over a record it could not read, so a later copy still knows it", () => {
    for (const malformed of ["not json", "1", '{"a":1}']) {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      region.setAttribute(RECORD, malformed);
      new StateRegions({ whenTrue: () => [region] }, OWNER).reflect(region, false);
      const restored = region.cloneNode(true) as HTMLElement;
      document.body.replaceChildren(restored);
      const state = new StateRegions({ whenTrue: () => [restored] }, OWNER);

      state.reflect(restored, false);
      state.release(restored);

      expect(restored.hasAttribute("hidden")).toBe(false);
      expect(restored.hasAttribute(RECORD)).toBe(false);
    }
  });

  describe("two instances of one owner on one region", () => {
    /** A region authored in view, hidden by `first` and then shown by `second`. */
    const shared = () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      const first = new StateRegions({ whenTrue: () => [region] }, OWNER);
      const second = new StateRegions({ whenTrue: () => [region] }, OWNER);
      first.reflect(region, false);
      second.reflect(region, true);
      return { region, first, second };
    };

    it("gives the region back the visibility the live instance wrote when the later one releases", () => {
      const { region, first, second } = shared();

      second.release(region);

      expect(region.hidden).toBe(true);
      expect(region.getAttribute(RECORD)).toBe("[null,true]");
      first.release(region);
      expect(region.hidden).toBe(false);
      expect(region.hasAttribute(RECORD)).toBe(false);
    });

    it("keeps the live visibility when the earlier one releases, with no record while it is the author's, and the last one hands back the author's", () => {
      const { region, first, second } = shared();

      first.release(region);

      expect(region.hidden).toBe(false);
      expect(region.hasAttribute(RECORD)).toBe(false);
      second.release(region);
      expect(region.hidden).toBe(false);
      expect(region.hasAttribute(RECORD)).toBe(false);
    });

    it("gives the second of them its own hold on a copy the first took the recorded one of", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      new StateRegions({ whenTrue: () => [region] }, OWNER).reflect(region, false);
      const restored = region.cloneNode(true) as HTMLElement;
      document.body.replaceChildren(restored);
      const first = new StateRegions({ whenTrue: () => [restored] }, OWNER);
      const second = new StateRegions({ whenTrue: () => [restored] }, OWNER);

      first.reflect(restored, false);
      second.reflect(restored, true);
      second.release(restored);

      expect(restored.hidden).toBe(true);
      first.release(restored);
      expect(restored.hasAttribute("hidden")).toBe(false);
    });

    it("hands back a region an earlier instance hid once the later one that hid it too releases last", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      const first = new StateRegions({ whenTrue: () => [region] }, OWNER);
      const second = new StateRegions({ whenTrue: () => [region] }, OWNER);
      first.reflect(region, false);
      second.reflect(region, false);

      first.release(region);
      expect(region.hidden).toBe(true);
      second.release(region);

      expect(region.hidden).toBe(false);
      expect(region.hasAttribute(RECORD)).toBe(false);
    });
  });

  it("releases a region of a restored copy it never wrote, while it shows what was written last", () => {
    for (const [authored, isTrue] of [
      [null, false],
      ["", true],
    ] as const) {
      const restored = restoredRegion(authored, isTrue);
      document.body.replaceChildren(restored);

      new StateRegions({ whenTrue: () => [restored] }, OWNER).release(restored);

      expect(restored.getAttribute("hidden")).toBe(authored);
      expect(restored.hasAttribute(RECORD)).toBe(false);
    }
  });

  it("leaves a region of a restored copy that no longer shows what was written last, and drops the record", () => {
    const restored = restoredRegion(null, false);
    document.body.replaceChildren(restored);
    restored.hidden = false;
    const state = new StateRegions({ whenTrue: () => [restored] }, OWNER);

    state.release(restored);

    expect(restored.hidden).toBe(false);
    expect(restored.hasAttribute(RECORD)).toBe(false);
  });

  it("takes the author's hidden from the record when it reflects the copy, whatever the copy shows", () => {
    const restored = restoredRegion("until-found", true);
    document.body.replaceChildren(restored);
    // The page hid the region after the earlier instance showed it.
    restored.setAttribute("hidden", "");
    const state = new StateRegions({ whenTrue: () => [restored] }, OWNER);

    state.reflect(restored, true);
    state.release(restored);

    expect(restored.getAttribute("hidden")).toBe("until-found");
  });

  it("shows the lone half a restored copy carries hidden from the pair it lost", () => {
    document.body.innerHTML = `<button><span data-off>open</span><span data-on>close</span></button>`;
    const host = document.querySelector("button") as HTMLElement;
    const pair = (root: ParentNode) =>
      new StateRegions(
        {
          whenTrue: () => Array.from(root.querySelectorAll<HTMLElement>("[data-on]")),
          whenFalse: () => Array.from(root.querySelectorAll<HTMLElement>("[data-off]")),
        },
        OWNER,
      );
    pair(host).reflect(host, false);
    (host.querySelector("[data-off]") as HTMLElement).remove();
    const restored = host.cloneNode(true) as HTMLElement;
    document.body.replaceChildren(restored);
    const on = restored.querySelector("[data-on]") as HTMLElement;
    expect(on.hidden).toBe(true);

    pair(restored).reflect(restored, false);

    expect(on.hidden).toBe(false);
  });

  it("keeps the author's hidden it read first, though the page changed the region before its next write", () => {
    document.body.innerHTML = "<div><p data-region>region</p></div>";
    const region = document.querySelector("[data-region]") as HTMLElement;
    const state = new StateRegions({ whenTrue: () => [region] }, OWNER);
    state.reflect(region, true);
    region.hidden = true;

    state.reflect(region, true);
    state.release(region);

    expect(region.hasAttribute("hidden")).toBe(false);
  });

  it("releases nothing from a record it cannot read, and leaves that record", () => {
    for (const malformed of [
      '"x"',
      "[null]",
      "[null, true, 1]",
      "[1, true]",
      "[null, 1]",
      "not json",
    ]) {
      document.body.innerHTML = "<div><p data-region hidden>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      region.setAttribute(RECORD, malformed);

      new StateRegions({ whenTrue: () => [region] }, OWNER).release(region);

      expect(region.getAttribute("hidden")).toBe("");
      expect(region.getAttribute(RECORD)).toBe(malformed);
    }
  });

  it("drops the record on release, also when a consumer has moved the region since", () => {
    document.body.innerHTML = "<div><p data-region>region</p></div>";
    const region = document.querySelector("[data-region]") as HTMLElement;
    const state = new StateRegions({ whenTrue: () => [region] }, OWNER);
    state.reflect(region, false);
    region.hidden = false;

    state.release(region);

    expect(region.hidden).toBe(false);
    expect(region.hasAttribute(RECORD)).toBe(false);
  });

  describe("a write that leaves the region as it is", () => {
    /**
     * A region the instance takes to `hidden` and back, which the page then takes to `hidden`
     * before the instance writes `hidden` again.
     */
    const moved = (authored: string | null, hidden: boolean) => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      if (authored !== null) region.setAttribute("hidden", authored);
      const state = new StateRegions({ whenTrue: () => [region] }, OWNER);
      state.reflect(region, !hidden);
      state.reflect(region, hidden);
      region.hidden = hidden;
      state.reflect(region, !hidden);
      return { region, state };
    };

    it("records the visibility it wrote, so a copy releases the region as the live instance does", () => {
      for (const [authored, hidden] of [
        [null, true],
        ["", false],
      ] as const) {
        const live = moved(authored, hidden);
        live.state.release(live.region);
        expect(live.region.getAttribute("hidden")).toBe(authored);

        const { region } = moved(authored, hidden);
        const restored = region.cloneNode(true) as HTMLElement;
        document.body.replaceChildren(restored);
        new StateRegions({ whenTrue: () => [restored] }, OWNER).release(restored);

        expect(restored.getAttribute("hidden")).toBe(authored);
        expect(restored.hasAttribute(RECORD)).toBe(false);
      }
    });

    it("places no record where it leaves the author's hidden", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      const state = new StateRegions({ whenTrue: () => [region] }, OWNER);
      state.reflect(region, true);

      state.reflect(region, true);

      expect(region.hasAttribute(RECORD)).toBe(false);
    });
  });

  describe("a write that brings the region back to what its author wrote", () => {
    it("removes the record, as the author's hidden is then what the region carries", () => {
      for (const [authored, away] of [
        [null, false],
        ["", true],
      ] as const) {
        document.body.innerHTML = "<div><p data-region>region</p></div>";
        const region = document.querySelector("[data-region]") as HTMLElement;
        if (authored !== null) region.setAttribute("hidden", authored);
        const state = new StateRegions({ whenTrue: () => [region] }, OWNER);

        state.reflect(region, away);
        expect(region.hasAttribute(RECORD)).toBe(true);
        state.reflect(region, !away);

        expect(region.getAttribute("hidden")).toBe(authored);
        expect(region.hasAttribute(RECORD)).toBe(false);
      }
    });

    it("keeps the record of an until-found its write replaced with a plain hidden", () => {
      document.body.innerHTML = '<div><p data-region hidden="until-found">region</p></div>';
      const region = document.querySelector("[data-region]") as HTMLElement;
      const state = new StateRegions({ whenTrue: () => [region] }, OWNER);
      state.reflect(region, true);

      state.reflect(region, false);

      expect(region.getAttribute("hidden")).toBe("");
      expect(region.getAttribute(RECORD)).toBe('["until-found",true]');
      const restored = region.cloneNode(true) as HTMLElement;
      document.body.replaceChildren(restored);
      new StateRegions({ whenTrue: () => [restored] }, OWNER).release(restored);
      expect(restored.getAttribute("hidden")).toBe("until-found");
    });
  });

  it("gives the record of the instance left holding a region back, though the page moved the region", () => {
    document.body.innerHTML = "<div><p data-region>region</p></div>";
    const region = document.querySelector("[data-region]") as HTMLElement;
    const first = new StateRegions({ whenTrue: () => [region] }, OWNER);
    const second = new StateRegions({ whenTrue: () => [region] }, OWNER);
    first.reflect(region, false);
    second.reflect(region, true);
    region.hidden = true;

    second.release(region);

    expect(region.getAttribute(RECORD)).toBe("[null,true]");
    const restored = region.cloneNode(true) as HTMLElement;
    first.release(region);
    expect(region.hasAttribute("hidden")).toBe(false);
    document.body.replaceChildren(restored);
    new StateRegions({ whenTrue: () => [restored] }, OWNER).release(restored);
    expect(restored.hasAttribute("hidden")).toBe(false);
  });

  describe("instances of two owners on one region", () => {
    const outerRecord = "data-stimeo--outer-hidden-region";
    const outerOf = (region: HTMLElement) =>
      new StateRegions({ whenTrue: () => [region] }, "stimeo--outer");
    const innerOf = (region: HTMLElement) =>
      new StateRegions({ whenTrue: () => [region] }, "stimeo--inner");
    /** A region authored in view, hidden by an outer instance and then shown by an inner one. */
    const stacked = () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      const outer = outerOf(region);
      const inner = innerOf(region);
      outer.reflect(region, false);
      inner.reflect(region, true);
      return { region, outer, inner };
    };
    const regionRecords = (region: Element) =>
      region.getAttributeNames().filter((name) => name.endsWith("-hidden-region"));

    it("gives the region what the outer instance wrote last, though it wrote again under the inner one", () => {
      const { region, outer, inner } = stacked();
      outer.reflect(region, true);
      inner.reflect(region, true);

      inner.release(region);
      expect(region.hidden).toBe(false);
      outer.release(region);

      expect(region.hasAttribute("hidden")).toBe(false);
      expect(regionRecords(region)).toEqual([]);
    });

    it("hands back the author's hidden from the inner instance once the outer one released first", () => {
      const { region, outer, inner } = stacked();

      outer.release(region);
      expect(region.hidden).toBe(false);
      inner.release(region);

      expect(region.hasAttribute("hidden")).toBe(false);
      expect(regionRecords(region)).toEqual([]);
    });

    it("gives a restored copy what the outer instance wrote there, where it wrote before the inner one", () => {
      const { region } = stacked();
      const restored = region.cloneNode(true) as HTMLElement;
      document.body.replaceChildren(restored);
      const outer = outerOf(restored);
      const inner = innerOf(restored);

      outer.reflect(restored, true);
      inner.reflect(restored, true);
      inner.release(restored);
      expect(restored.hidden).toBe(false);
      outer.release(restored);

      expect(restored.hasAttribute("hidden")).toBe(false);
      expect(regionRecords(restored)).toEqual([]);
    });

    it("gives a restored copy neither instance wrote back what the outer one wrote, and then the author's hidden", () => {
      const { region } = stacked();
      const restored = region.cloneNode(true) as HTMLElement;
      document.body.replaceChildren(restored);

      innerOf(restored).release(restored);
      expect(restored.hidden).toBe(true);
      outerOf(restored).release(restored);

      expect(restored.hasAttribute("hidden")).toBe(false);
      expect(regionRecords(restored)).toEqual([]);
    });

    it("hands back the author's hidden from a restored copy whose outer instance released first", () => {
      const { region } = stacked();
      const restored = region.cloneNode(true) as HTMLElement;
      document.body.replaceChildren(restored);

      outerOf(restored).release(restored);
      expect(restored.hasAttribute(outerRecord)).toBe(false);
      innerOf(restored).release(restored);

      expect(restored.hasAttribute("hidden")).toBe(false);
      expect(regionRecords(restored)).toEqual([]);
    });

    it("hands back an authored hidden from the inner instance once the outer one released first", () => {
      document.body.innerHTML = "<div><p data-region hidden>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      const outer = outerOf(region);
      const inner = innerOf(region);
      outer.reflect(region, true);
      inner.reflect(region, false);

      outer.release(region);
      inner.release(region);

      expect(region.getAttribute("hidden")).toBe("");
      expect(regionRecords(region)).toEqual([]);
    });

    it("takes a visibility the page wrote over the outer instance as the author's", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      const outer = outerOf(region);
      const inner = innerOf(region);
      outer.reflect(region, false);
      region.hidden = false;

      inner.reflect(region, true);

      expect(region.getAttribute("data-stimeo--inner-hidden-region")).toBe(
        `[null,false,false,"${outerRecord}"]`,
      );
    });

    it("puts on top of a copy the instance written over a visibility the page put there, whichever was constructed first", () => {
      for (const [first, second] of [
        ["stimeo--column-t1", "stimeo--column-b1"],
        ["stimeo--column-b2", "stimeo--column-t2"],
      ] as const) {
        document.body.innerHTML = "<div><p data-region>region</p></div>";
        const region = document.querySelector("[data-region]") as HTMLElement;
        const instance = (owner: string, of: HTMLElement) =>
          new StateRegions({ whenTrue: () => [of] }, owner);
        const lower = first.includes("-b") ? first : second;
        const page = first.includes("-t") ? first : second;
        const upper = `${page}-upper`;
        // Registered in this order, so either column may be read first.
        instance(first, region);
        instance(second, region);
        instance(lower, region).reflect(region, false);
        region.hidden = false;
        instance(page, region).reflect(region, true);
        instance(upper, region).reflect(region, true);
        const restored = region.cloneNode(true) as HTMLElement;
        document.body.replaceChildren(restored);

        instance(upper, restored).release(restored);

        expect(restored.getAttribute(`data-${page}-hidden-region`)).toBe(
          `[null,false,false,"data-${lower}-hidden-region"]`,
        );
        expect(restored.getAttribute(`data-${lower}-hidden-region`)).toBe("[null,true]");
      }
    });

    it("hands back the page's visibility from the instance written over it once the instance it lay on released first", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      new StateRegions({ whenTrue: () => [region] }, "stimeo--lower").reflect(region, false);
      region.hidden = false;
      const outer = outerOf(region);
      const inner = innerOf(region);
      outer.reflect(region, false);
      inner.reflect(region, true);

      outer.release(region);
      inner.release(region);

      expect(region.hasAttribute("hidden")).toBe(false);
    });

    it("hands back the page's visibility from an instance it wrote over a page write, though an instance lies beneath", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      const outer = outerOf(region);
      const inner = innerOf(region);
      outer.reflect(region, false);
      region.hidden = false;
      inner.reflect(region, false);

      inner.release(region);

      expect(region.hasAttribute("hidden")).toBe(false);
    });

    it("reads nothing from a copy it neither holds nor carries a record on when it releases it", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      outerOf(region).reflect(region, false);
      const restored = region.cloneNode(true) as HTMLElement;
      document.body.replaceChildren(restored);
      innerOf(restored).release(restored);
      // A morph then keeps only what the server sent.
      restored.removeAttribute(outerRecord);
      restored.setAttribute("hidden", "until-found");
      const outer = outerOf(restored);

      outer.reflect(restored, true);
      outer.release(restored);

      expect(restored.getAttribute("hidden")).toBe("until-found");
    });

    it("writes over no instance that has released the region", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      const outer = outerOf(region);
      const inner = innerOf(region);
      outer.reflect(region, false);
      outer.release(region);

      inner.reflect(region, true);

      expect(regionRecords(region)).toEqual([]);
    });

    it("lists no instance beneath a region it writes again after releasing it", () => {
      const { region, outer, inner } = stacked();
      inner.release(region);
      outer.release(region);

      inner.reflect(region, true);

      expect(regionRecords(region)).toEqual([]);
    });

    it("changes only its record when it writes beneath the inner instance", async () => {
      const { region, outer } = stacked();
      const seen: string[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) seen.push(record.attributeName ?? "");
      });
      observer.observe(region, { attributes: true });

      outer.reflect(region, true);
      await flushMicrotasks();

      expect(seen).toEqual([outerRecord]);
      expect(region.hidden).toBe(false);
      observer.disconnect();
    });

    it("keeps the region the inner instance hid when the outer one, which hid it too, releases first", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      const outer = outerOf(region);
      const inner = innerOf(region);
      outer.reflect(region, false);
      inner.reflect(region, false);

      outer.release(region);
      expect(region.hidden).toBe(true);
      inner.release(region);

      expect(region.hasAttribute("hidden")).toBe(false);
      expect(regionRecords(region)).toEqual([]);
    });

    it("shows nothing the outer instance writes beneath the inner one until the inner one releases", () => {
      const { region, outer, inner } = stacked();
      outer.reflect(region, true);

      outer.reflect(region, false);
      expect(region.hidden).toBe(false);
      expect(region.getAttribute(outerRecord)).toBe("[null,true]");
      inner.release(region);

      expect(region.hidden).toBe(true);
    });

    it("keeps the inner instance on top of a restored copy the outer one writes first", () => {
      const { region } = stacked();
      const restored = region.cloneNode(true) as HTMLElement;
      document.body.replaceChildren(restored);
      const outer = outerOf(restored);
      const inner = innerOf(restored);

      outer.reflect(restored, false);
      expect(restored.hidden).toBe(false);
      inner.release(restored);
      expect(restored.hidden).toBe(true);
      outer.release(restored);

      expect(restored.hasAttribute("hidden")).toBe(false);
      expect(regionRecords(restored)).toEqual([]);
    });

    it("hands a restored copy back the author's hidden, though the inner instance writes it before the outer one releases it", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      outerOf(region).reflect(region, false);
      const restored = region.cloneNode(true) as HTMLElement;
      document.body.replaceChildren(restored);
      const outer = outerOf(restored);
      const inner = innerOf(restored);

      inner.reflect(restored, true);
      outer.release(restored);
      expect(restored.hidden).toBe(false);
      inner.release(restored);

      expect(restored.hasAttribute("hidden")).toBe(false);
      expect(regionRecords(restored)).toEqual([]);
    });

    it("records an outer instance that shows what the author wrote beneath the inner one, so a copy stacks them as the page did", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      outerOf(region).reflect(region, true);
      expect(region.hasAttribute(outerRecord)).toBe(false);
      innerOf(region).reflect(region, false);
      expect(region.getAttribute(outerRecord)).toBe("[null,false]");
      const restored = region.cloneNode(true) as HTMLElement;
      document.body.replaceChildren(restored);
      const outer = outerOf(restored);
      const inner = innerOf(restored);

      outer.reflect(restored, true);
      expect(restored.hidden).toBe(true);
      inner.release(restored);
      expect(restored.hidden).toBe(false);
      outer.release(restored);

      expect(restored.hasAttribute("hidden")).toBe(false);
      expect(regionRecords(restored)).toEqual([]);
    });
  });

  describe("after the page replaced the visibility of the top instance", () => {
    const of = (owner: string, region: HTMLElement) =>
      new StateRegions({ whenTrue: () => [region] }, owner);
    const regionRecords = (region: Element) =>
      region.getAttributeNames().filter((name) => name.endsWith("-hidden-region"));

    it("shows the next write of an instance beneath the top", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      const lower = of("stimeo--lower", region);
      const upper = of("stimeo--upper", region);
      lower.reflect(region, false);
      upper.reflect(region, true);
      region.hidden = true;

      lower.reflect(region, true);
      expect(region.hidden).toBe(false);
      upper.release(region);
      lower.release(region);

      expect(region.hasAttribute("hidden")).toBe(false);
      expect(regionRecords(region)).toEqual([]);
    });
  });

  describe("a restored copy, decided as the live page", () => {
    const regionRecords = (region: Element) =>
      region.getAttributeNames().filter((name) => name.endsWith("-hidden-region"));

    it("orders two instances, the later one written over a visibility the page put there, as the live page did", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      const make = (target: HTMLElement) =>
        ["stimeo--first", "stimeo--second"].map(
          (owner) => new StateRegions({ whenTrue: () => [target] }, owner),
        );
      const [first, second] = make(region);
      first?.reflect(region, false);
      region.hidden = false;
      second?.reflect(region, false);
      region.hidden = false;
      const restored = region.cloneNode(true) as HTMLElement;
      const [firstAgain, secondAgain] = make(restored);

      for (const [one, other, target] of [
        [first, second, region],
        [firstAgain, secondAgain, restored],
      ] as const) {
        other?.reflect(target, true);
        one?.reflect(target, false);
      }

      expect([region.hidden, restored.hidden]).toEqual([false, false]);
    });

    it("releases on a copy the instance written over a visibility the page put there", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      const make = (target: HTMLElement) =>
        ["stimeo--first", "stimeo--second"].map(
          (owner) => new StateRegions({ whenTrue: () => [target] }, owner),
        );
      const [first, second] = make(region);
      first?.reflect(region, false);
      region.hidden = false;
      second?.reflect(region, false);
      const restored = region.cloneNode(true) as HTMLElement;
      document.body.replaceChildren(restored);
      const [firstAgain, secondAgain] = make(restored);

      secondAgain?.release(restored);
      expect(restored.hidden).toBe(false);
      firstAgain?.release(restored);

      expect(restored.hasAttribute("hidden")).toBe(false);
      expect(regionRecords(restored)).toEqual([]);
    });

    it("gives the author's hidden back and leaves no record once every instance releases, one owner holding beneath and above another", () => {
      document.body.innerHTML = "<div><p data-region>region</p></div>";
      const region = document.querySelector("[data-region]") as HTMLElement;
      const make = (target: HTMLElement) =>
        ["stimeo--a", "stimeo--b", "stimeo--a"].map(
          (owner) => new StateRegions({ whenTrue: () => [target] }, owner),
        );
      const [first, other, second] = make(region);
      first?.reflect(region, false);
      other?.reflect(region, true);
      second?.reflect(region, false);
      const restored = region.cloneNode(true) as HTMLElement;
      document.body.replaceChildren(restored);

      for (const instance of make(restored)) instance.release(restored);

      expect(restored.hasAttribute("hidden")).toBe(false);
      expect(regionRecords(restored)).toEqual([]);
    });
  });
});
