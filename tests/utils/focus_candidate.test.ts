import { beforeEach, describe, expect, it } from "vitest";
import {
  canTakeFocus,
  closestInFlatTree,
  deepActiveElement,
  firstTabStop,
  flatTreeChildren,
  flatTreeContains,
  flatTreeParent,
  hasTabStop,
  isTabStop,
  sequentialTabStops,
  tabStopsWithin,
} from "../../src/utils/focus_candidate";

/**
 * Tests for {@link canTakeFocus}.
 *
 * The `fieldset` cases carry the most detail because HTML's rule is not
 * "anything inside a disabled fieldset": the contents of the **first direct-child
 * `<legend>`** stay enabled, and the exemption is per fieldset, so a control
 * legal in one legend can still be disabled by an outer one.
 *
 * `aria-disabled` gets its own case for the opposite reason — it must **not**
 * disqualify, because the roving contract keeps such items reachable and
 * the platform still focuses them.
 */
describe("canTakeFocus", () => {
  const el = (selector: string) => document.querySelector<HTMLElement>(selector) as HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("accepts a plain focusable control", () => {
    document.body.innerHTML = '<button id="a">A</button>';
    expect(canTakeFocus(el("#a"))).toBe(true);
  });

  it("accepts a non-form element, which has no disabled property", () => {
    // Landmarks and rows are legitimate rescue destinations once they carry a
    // borrowed tabindex; nothing about them refuses focus.
    document.body.innerHTML = '<div id="a" tabindex="-1"></div>';
    expect(canTakeFocus(el("#a"))).toBe(true);
  });

  describe("hidden", () => {
    it("rejects a hidden element", () => {
      document.body.innerHTML = '<button id="a" hidden>A</button>';
      expect(canTakeFocus(el("#a"))).toBe(false);
    });

    it("rejects an element inside a hidden ancestor", () => {
      // The common shape: the rescue destination is fine, the wrapper is what
      // just got hidden.
      document.body.innerHTML = '<div hidden><button id="a">A</button></div>';
      expect(canTakeFocus(el("#a"))).toBe(false);
    });

    it("rejects a type=hidden input without the hidden attribute", () => {
      document.body.innerHTML = '<input id="a" type="hidden">';
      expect(canTakeFocus(el("#a"))).toBe(false);
    });
  });

  describe("disabled", () => {
    it("rejects a natively disabled control", () => {
      document.body.innerHTML = '<button id="a" disabled>A</button>';
      expect(canTakeFocus(el("#a"))).toBe(false);
    });

    it("accepts an aria-disabled control", () => {
      // Not disqualifying: `aria-disabled` marks a control that must stay
      // discoverable, and the platform still focuses it.
      document.body.innerHTML = '<button id="a" aria-disabled="true">A</button>';
      expect(canTakeFocus(el("#a"))).toBe(true);
    });
  });

  describe("fieldset inheritance", () => {
    it("rejects a control inside a disabled fieldset", () => {
      document.body.innerHTML = '<fieldset disabled><button id="a">A</button></fieldset>';
      expect(canTakeFocus(el("#a"))).toBe(false);
    });

    it("accepts a control in the first direct-child legend", () => {
      // HTML exempts exactly that legend — the control really is operable.
      document.body.innerHTML =
        '<fieldset disabled><legend><button id="a">A</button></legend></fieldset>';
      expect(canTakeFocus(el("#a"))).toBe(true);
    });

    it("rejects a control in a second legend", () => {
      document.body.innerHTML =
        "<fieldset disabled><legend>First</legend>" +
        '<legend><button id="a">A</button></legend></fieldset>';
      expect(canTakeFocus(el("#a"))).toBe(false);
    });

    it("rejects a legend-exempt control that an outer fieldset still disables", () => {
      // The exemption is per fieldset: being legal in the inner legend says
      // nothing about the outer one.
      document.body.innerHTML =
        '<fieldset disabled><fieldset disabled><legend><button id="a">A</button></legend>' +
        "</fieldset></fieldset>";
      expect(canTakeFocus(el("#a"))).toBe(false);
    });

    it("accepts a control whose fieldset is not disabled", () => {
      document.body.innerHTML = '<fieldset><button id="a">A</button></fieldset>';
      expect(canTakeFocus(el("#a"))).toBe(true);
    });
  });

  /**
   * `hidden` and `inert` reach an element along the flat tree: through the shadow host of
   * the root it sits in, and through the slot it is assigned to.
   */
  describe("open shadow roots", () => {
    /** Gives the element matching `selector` an open shadow root holding `html`. */
    const shadowOf = (selector: string, html: string): ShadowRoot => {
      const shadow = el(selector).attachShadow({ mode: "open" });
      shadow.innerHTML = html;
      return shadow;
    };

    it("accepts an element whose shadow host and the host's ancestors are shown", () => {
      document.body.innerHTML = '<div id="host"></div>';
      const shadow = shadowOf("#host", '<button id="inner">Inner</button>');
      expect(canTakeFocus(shadow.querySelector("#inner") as HTMLElement)).toBe(true);
    });

    it("rejects an element whose shadow host is hidden", () => {
      document.body.innerHTML = '<div id="host" hidden></div>';
      const shadow = shadowOf("#host", '<button id="inner">Inner</button>');
      expect(canTakeFocus(shadow.querySelector("#inner") as HTMLElement)).toBe(false);
    });

    it("rejects an element whose shadow host sits inside an inert element", () => {
      document.body.innerHTML = '<div inert><div id="host"></div></div>';
      const shadow = shadowOf("#host", '<button id="inner">Inner</button>');
      expect(canTakeFocus(shadow.querySelector("#inner") as HTMLElement)).toBe(false);
    });

    it("rejects an element the engine assigns to no slot, and what it holds, and takes one assigned to a slot", () => {
      document.body.innerHTML =
        '<div id="host"><button id="unslotted">Unslotted</button>' +
        '<span id="wrap"><button id="deep">Deep</button></span>' +
        '<button id="slotted" slot="named">Slotted</button></div>';
      const shadow = shadowOf("#host", '<slot name="named"></slot>');
      // happy-dom does not implement `assignedSlot`; these are what the engine reports.
      for (const id of ["#unslotted", "#wrap"]) {
        Object.defineProperty(el(id), "assignedSlot", { value: null, configurable: true });
      }
      Object.defineProperty(el("#slotted"), "assignedSlot", {
        value: shadow.querySelector("slot"),
        configurable: true,
      });
      expect(canTakeFocus(el("#unslotted"))).toBe(false);
      expect(canTakeFocus(el("#deep"))).toBe(false);
      expect(canTakeFocus(el("#slotted"))).toBe(true);
    });

    it("rejects a slotted element whose slot sits in a hidden part of the shadow tree", () => {
      document.body.innerHTML = '<div id="host"><button id="slotted">Slotted</button></div>';
      const shadow = shadowOf("#host", "<div hidden><slot></slot></div>");
      const slotted = el("#slotted");
      // happy-dom does not implement `assignedSlot`; this is the slot the engine reports.
      Object.defineProperty(slotted, "assignedSlot", {
        value: shadow.querySelector("slot"),
        configurable: true,
      });
      expect(canTakeFocus(slotted)).toBe(false);
    });
  });
});

describe("sequential Tab stops", () => {
  const candidate = (html: string): HTMLElement => {
    document.body.innerHTML = html;
    const element = document.querySelector<HTMLElement>("#candidate");
    if (!element) throw new Error("Expected #candidate");
    return element;
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ["link", '<a id="candidate" href="#target">Link</a>'],
    ["image-map area", '<map><area id="candidate" href="#target"></map>'],
    ["button", '<button id="candidate">Save</button>'],
    ["text input", '<input id="candidate">'],
    ["select", '<select id="candidate"><option>One</option></select>'],
    ["textarea", '<textarea id="candidate"></textarea>'],
    ["first summary", '<details><summary id="candidate">Details</summary></details>'],
    ["iframe", '<iframe id="candidate" title="Preview"></iframe>'],
    ["audio controls", '<audio id="candidate" controls style="display:block"></audio>'],
    ["video controls", '<video id="candidate" controls></video>'],
    ["authored tabindex", '<div id="candidate" tabindex="0"></div>'],
    ["bare contenteditable", '<div id="candidate" contenteditable></div>'],
    ["editable true", '<div id="candidate" contenteditable="TRUE"></div>'],
    ["plaintext editor", '<div id="candidate" contenteditable="plaintext-only"></div>'],
    ["aria-disabled button", '<button id="candidate" aria-disabled="true">Save</button>'],
  ])("accepts a %s", (_name, html) => {
    expect(isTabStop(candidate(html))).toBe(true);
  });

  it.each([
    ["hidden input", '<input id="candidate" type="hidden">'],
    ["disabled button", '<button id="candidate" disabled>Save</button>'],
    [
      "fieldset-disabled button",
      '<fieldset disabled><button id="candidate">Save</button></fieldset>',
    ],
    [
      "second summary",
      '<details><summary>First</summary><summary id="candidate">Second</summary></details>',
    ],
    ["orphan summary", '<summary id="candidate">Orphan</summary>'],
    ["negative tabindex", '<button id="candidate" tabindex="-1">Save</button>'],
    ["explicitly non-editable element", '<div id="candidate" contenteditable="false"></div>'],
    ["invalid editable value", '<div id="candidate" contenteditable="invalid"></div>'],
    ["hidden subtree", '<div hidden><button id="candidate">Save</button></div>'],
    ["inert subtree", '<div inert><button id="candidate">Save</button></div>'],
    ["CSS-hidden button", '<button id="candidate" style="display:none">Save</button>'],
  ])("rejects a %s", (_name, html) => {
    expect(isTabStop(candidate(html))).toBe(false);
  });

  it("keeps the disabled-fieldset first-legend exception", () => {
    expect(
      isTabStop(
        candidate(
          '<fieldset disabled><legend><button id="candidate">Save</button></legend></fieldset>',
        ),
      ),
    ).toBe(true);
  });

  it("falls back safely when checkVisibility is unavailable", () => {
    const element = candidate('<button id="candidate">Save</button>');
    Object.defineProperty(element, "checkVisibility", { configurable: true, value: undefined });

    expect(isTabStop(element)).toBe(true);
  });

  it("collects only usable descendants in DOM order", () => {
    document.body.innerHTML = `
      <div id="root">
        <button id="first">First</button>
        <input type="hidden">
        <a id="second" href="#target">Second</a>
      </div>
    `;
    const root = document.getElementById("root");
    if (!root) throw new Error("Expected #root");

    expect(tabStopsWithin(root).map((element) => element.id)).toEqual(["first", "second"]);
    expect(firstTabStop(root)?.id).toBe("first");
    expect(hasTabStop(root)).toBe(true);
  });

  it("reports an empty subtree", () => {
    const root = document.createElement("div");

    expect(tabStopsWithin(root)).toEqual([]);
    expect(firstTabStop(root)).toBeNull();
    expect(hasTabStop(root)).toBe(false);
  });
});

/**
 * Tests for {@link sequentialTabStops}: the stops a sequential move visits, in turn,
 * from a starting element — HTML's sequential navigation order within the root, with
 * the engine's radio-group rule, open shadow roots in flat-tree order, and links in
 * editable content left out.
 */
describe("sequentialTabStops", () => {
  const root = (html: string): HTMLElement => {
    document.body.innerHTML = `<button id="outside">Outside</button><div id="root">${html}</div>`;
    return document.getElementById("root") as HTMLElement;
  };
  const ids = (elements: Element[]): string[] => elements.map((element) => element.id);
  const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
  const radio = (name: string, id: string, extra = "") =>
    `<input type="radio" name="${name}" id="${id}" ${extra}>`;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("lists the stops from the first when no start is given", () => {
    const r = root(
      '<button id="z1">Z1</button><button id="p2" tabindex="2">P2</button>' +
        '<button id="z2">Z2</button><button id="p1" tabindex="+1">P1</button>',
    );

    expect(ids(sequentialTabStops(r))).toEqual(["p1", "p2", "z1", "z2"]);
    expect(ids(sequentialTabStops(r, null, true))).toEqual(["z2", "z1", "p2", "p1"]);
  });

  it("starts after the start and wraps, leaving the start out", () => {
    const r = root('<button id="a">A</button><button id="b">B</button><button id="c">C</button>');

    expect(ids(sequentialTabStops(r, el("b")))).toEqual(["c", "a"]);
    expect(ids(sequentialTabStops(r, el("b"), true))).toEqual(["a", "c"]);
    expect(ids(sequentialTabStops(r, el("a"), true))).toEqual(["c", "b"]);
    expect(ids(sequentialTabStops(r, el("c")))).toEqual(["a", "b"]);
  });

  it("follows the sequential order, not the tree order, from a stop", () => {
    const r = root('<button id="z1">Z1</button><button id="p1" tabindex="1">P1</button>');

    expect(ids(sequentialTabStops(r, el("z1"), true))).toEqual(["p1"]);
    expect(ids(sequentialTabStops(r, el("p1")))).toEqual(["z1"]);
  });

  it("treats a start outside the root as nothing, and the root itself as the start of its tree", () => {
    const r = root('<button id="z1">Z1</button><button id="p1" tabindex="1">P1</button>');

    expect(ids(sequentialTabStops(r, el("outside")))).toEqual(["p1", "z1"]);
    expect(ids(sequentialTabStops(r, el("outside"), true))).toEqual(["z1", "p1"]);
    expect(ids(sequentialTabStops(r, r))).toEqual(["z1", "p1"]);
    expect(ids(sequentialTabStops(r, r, true))).toEqual(["z1", "p1"]);
  });

  it("starts from an element outside the order at its neighbours in tree order", () => {
    const r = root(
      '<button id="a">A</button><div id="h" tabindex="-1">H</div>' +
        '<button id="b">B</button><button id="p" tabindex="1">P</button>',
    );

    expect(ids(sequentialTabStops(r, el("h")))).toEqual(["b", "p", "a"]);
    expect(ids(sequentialTabStops(r, el("h"), true))).toEqual(["a", "p", "b"]);
  });

  it("stops on a checked radio even from inside its group, and on an unchecked group's first radio from outside it", () => {
    const r = root(
      `<button id="a">A</button>${radio("g", "g1")}${radio("g", "g2", "checked")}` +
        `${radio("g", "g3")}<button id="b">B</button>` +
        `${radio("u", "u1")}${radio("u", "u2")}<button id="c">C</button>`,
    );

    expect(ids(sequentialTabStops(r))).toEqual(["a", "g2", "b", "u1", "c"]);
    expect(ids(sequentialTabStops(r, el("g1")))).toEqual(["g2", "b", "u1", "c", "a"]);
    expect(ids(sequentialTabStops(r, el("u2"), true))).toEqual(["b", "g2", "a", "c"]);
  });

  it("counts only the radios inside the root as a group", () => {
    document.body.innerHTML = `${radio("g", "out", "checked")}<div id="root">${radio("g", "in-1")}${radio("g", "in-2")}</div>`;

    expect(ids(sequentialTabStops(el("root")))).toEqual(["in-1"]);
    expect(ids(sequentialTabStops(el("root"), el("out")))).toEqual(["in-1"]);
  });

  it("leaves out links in editable content that have no tabindex", () => {
    const r = root(
      '<div id="host" contenteditable><a id="link" href="#x">x</a>' +
        '<span contenteditable="false"><a id="island" href="#y">y</a></span></div>' +
        '<a id="plain" href="#z">z</a>',
    );

    expect(ids(sequentialTabStops(r))).toEqual(["host", "island", "plain"]);
  });

  it("orders an open shadow root after its host, with slotted content where the slot is", () => {
    const r = root('<div id="host"><button id="slotted">L</button></div><button id="z">Z</button>');
    el("host").attachShadow({ mode: "open" }).innerHTML =
      '<button id="s1">S1</button><slot></slot><button id="s2">S2</button>';

    expect(ids(sequentialTabStops(r))).toEqual(["s1", "slotted", "s2", "z"]);
  });

  it("walks the root's own open shadow root", () => {
    const r = root('<button id="light">Light</button>');
    r.attachShadow({ mode: "open" }).innerHTML = '<button id="shadow">Shadow</button>';

    expect(ids(sequentialTabStops(r))).toEqual(["shadow"]);
  });

  it("moves backward from an element outside the order to the nearest stop before it", () => {
    const r = root(
      '<button id="a">A</button><button id="b">B</button>' +
        '<div id="h" tabindex="-1">H</div><button id="c">C</button>',
    );

    expect(ids(sequentialTabStops(r, el("h"), true))).toEqual(["b", "a", "c"]);
  });

  it("counts radios of the same name in another tree as another group", () => {
    const r = root(`${radio("grp", "light1")}${radio("grp", "light2")}<div id="host"></div>`);
    el("host").attachShadow({ mode: "open" }).innerHTML =
      '<input type="radio" name="grp" id="inner1" checked>' +
      '<input type="radio" name="grp" id="inner2">';

    expect(ids(sequentialTabStops(r))).toEqual(["light1", "inner1"]);
  });

  describe("stops the order adds to the shared Tab stops", () => {
    const XLINK = "http://www.w3.org/1999/xlink";

    it("stops on an SVG link with href or xlink:href, and not on one without", () => {
      const r = root(`
        <svg><a id="svg-href" href="#x"><text>href</text></a></svg>
        <svg><a id="svg-xlink"><text>xlink</text></a></svg>
        <svg><a id="svg-none"><text>none</text></a></svg>
        <svg><a id="svg-negative" href="#x" tabindex="-1"><text>negative</text></a></svg>`);
      el("svg-xlink").setAttributeNS(XLINK, "xlink:href", "#x");

      expect(ids(sequentialTabStops(r))).toEqual(["svg-href", "svg-xlink"]);
      expect(isTabStop(el("svg-href"))).toBe(false);
      expect(tabStopsWithin(r).map((element) => element.id)).toEqual([]);
    });

    it("leaves out an SVG link that is part of editable content", () => {
      const r = root(`
        <div id="editor" contenteditable="true">
          <svg><a id="svg-editable" href="#x"><text>editable</text></a></svg>
          <span contenteditable="false"><svg><a id="svg-island" href="#x"><text>island</text></a></svg></span>
        </div>`);

      expect(ids(sequentialTabStops(r))).toEqual(["editor", "svg-island"]);
    });

    it("leaves out an SVG link that cannot take focus or is not rendered", () => {
      const r = root(`
        <div inert><svg><a id="svg-inert" href="#x"><text>inert</text></a></svg></div>
        <svg style="display:none"><a id="svg-hidden" href="#x"><text>hidden</text></a></svg>
        <button id="after">After</button>`);

      expect(ids(sequentialTabStops(r))).toEqual(["after"]);
    });

    it("stops on an image-map area only while an image that uses its map is rendered", () => {
      const r = root(`
        <map name="shown"><area id="area-shown" href="#a" alt="shown"><area id="area-bare" alt="bare"><area id="area-tabbable" tabindex="0" alt="tabbable"></map>
        <img usemap="#shown" alt="shown">
        <map name="hidden"><area id="area-hidden" href="#b" alt="hidden"></map>
        <img usemap="#hidden" alt="hidden" style="display:none">
        <map name="unused"><area id="area-unused" href="#c" alt="unused"></map>
        <map id="by-id"><area id="area-by-id" href="#d" alt="by id"></map>
        <img usemap="#by-id" alt="by id">
        <map><area id="area-nameless" href="#e" alt="nameless"></map>
        <map name="negative"><area id="area-negative" href="#f" tabindex="-1" alt="negative"></map>
        <img usemap="#negative" alt="negative">
        <area id="area-mapless" href="#g" alt="mapless">`);

      expect(ids(sequentialTabStops(r))).toEqual(["area-shown", "area-tabbable", "area-by-id"]);
    });

    it("leaves out the added stops that are out of the order, cannot take focus, or are editing content", () => {
      const r = root(`
        <svg>
          <a id="svg-negative" href="#s" tabindex="-1"><text>negative</text></a>
          <use id="svg-use" href="#s"></use>
          <image id="svg-image" href="image.png"></image>
        </svg>
        <div inert><svg><a id="svg-inert" href="#s"><text>inert</text></a></svg></div>
        <div inert><map name="inert-map"><area id="area-inert" href="#x" alt="inert"></map></div>
        <img usemap="#inert-map" alt="inert">
        <div inert><object id="object-inert" data="doc.html" aria-label="inert"></object></div>
        <div id="host" contenteditable="true">
          <map name="edit-map"><area id="area-editable" href="#y" alt="editable"></map>
        </div>
        <img usemap="#edit-map" alt="editable">`);
      Object.defineProperty(el("object-inert"), "contentWindow", { value: { closed: false } });

      expect(ids(sequentialTabStops(r))).toEqual(["host"]);
    });

    it("moves from a non-stop element past an added stop that a negative tabindex takes out", () => {
      const r = root(`
        <button id="a">a</button>
        <h2 id="heading" tabindex="-1">heading</h2>
        <svg><a id="svg-negative" href="#s" tabindex="-1"><text>negative</text></a></svg>
        <button id="b">b</button>
        <button id="c">c</button>`);

      expect(ids(sequentialTabStops(r, el("heading")))).toEqual(["b", "c", "a"]);
    });

    it("stops on an object that holds a nested document, like an iframe", () => {
      const r = root(`
        <object id="object-document" data="doc.html" aria-label="document"></object>
        <object id="object-image" data="image.gif" aria-label="image"></object>
        <object id="object-negative" data="doc.html" tabindex="-1" aria-label="negative"></object>`);
      const nested = { closed: false };
      Object.defineProperty(el("object-document"), "contentWindow", { value: nested });
      Object.defineProperty(el("object-image"), "contentWindow", { value: null });
      Object.defineProperty(el("object-negative"), "contentWindow", { value: nested });

      expect(ids(sequentialTabStops(r))).toEqual(["object-document"]);
    });

    it("leaves out a details element without a summary, whose generated summary script cannot focus", () => {
      const r = root('<details id="bare"><p>Body</p></details><button id="after">After</button>');

      expect(ids(sequentialTabStops(r))).toEqual(["after"]);
    });
  });
});

describe("deepActiveElement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns the focused element", () => {
    document.body.innerHTML = '<button id="a">A</button>';
    (document.getElementById("a") as HTMLElement).focus();

    expect(deepActiveElement(document)?.id).toBe("a");
  });

  it("looks through nested open shadow roots", () => {
    document.body.innerHTML = '<div id="outer"></div>';
    const outer = (document.getElementById("outer") as HTMLElement).attachShadow({ mode: "open" });
    outer.innerHTML = '<div id="inner"></div>';
    const inner = (outer.getElementById("inner") as HTMLElement).attachShadow({ mode: "open" });
    inner.innerHTML = '<button id="deep">Deep</button>';
    (inner.getElementById("deep") as HTMLElement).focus();

    expect(deepActiveElement(document)?.id).toBe("deep");
  });

  it("stops at a closed shadow host", () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById("host") as HTMLElement;
    const closed = host.attachShadow({ mode: "closed" });
    closed.innerHTML = "<button>Inside</button>";
    (closed.querySelector("button") as HTMLElement).focus();

    expect(deepActiveElement(document)).toBe(host);
  });
});

/**
 * The flat tree the focus checks walk: a slotted element's parent is its slot, a shadow
 * root's child's parent is the host, and a host's children are its open shadow root's.
 * happy-dom does not implement `assignedSlot`, so the slotted cases set the slot the engine
 * reports on the element.
 */
describe("flat tree", () => {
  const el = (selector: string) => document.querySelector<HTMLElement>(selector) as HTMLElement;
  /** A host holding a slotted button, with an open shadow root around the slot. */
  const slotted = (): { host: HTMLElement; shadow: ShadowRoot; slot: HTMLSlotElement } => {
    document.body.innerHTML = '<div id="host"><button id="slotted">Slotted</button></div>';
    const host = el("#host");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<section id="frame"><slot></slot></section><p id="aside">Aside</p>';
    const slot = shadow.querySelector("slot") as HTMLSlotElement;
    Object.defineProperty(el("#slotted"), "assignedSlot", { value: slot, configurable: true });
    return { host, shadow, slot };
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("climbs from a slotted element to its slot, from a shadow root's child to the host, and stops at the top", () => {
    const { host, shadow, slot } = slotted();
    const frame = shadow.querySelector("#frame") as HTMLElement;

    expect(flatTreeParent(el("#slotted"))).toBe(slot);
    expect(flatTreeParent(slot)).toBe(frame);
    expect(flatTreeParent(frame)).toBe(host);
    expect(flatTreeParent(host)).toBe(document.body);
    expect(flatTreeParent(document.documentElement)).toBeNull();
    const detached = document.createDocumentFragment();
    detached.append(document.createElement("div"));
    expect(flatTreeParent(detached.firstElementChild as Element)).toBeNull();
  });

  it("leaves an element the engine assigns to no slot of an open shadow root outside the flat tree", () => {
    document.body.innerHTML =
      '<div id="host"><span id="light"><b id="inner">Light</b></span></div>';
    el("#host").attachShadow({ mode: "open" }).innerHTML = "<p>Shadow</p>";
    // happy-dom does not implement `assignedSlot`; this is what the engine reports.
    Object.defineProperty(el("#light"), "assignedSlot", { value: null, configurable: true });
    expect(flatTreeParent(el("#light"))).toBeNull();
    expect(flatTreeParent(el("#inner"))).toBe(el("#light"));
    expect(flatTreeContains(el("#host"), el("#inner"))).toBe(false);
    expect(flatTreeContains(document.body, el("#light"))).toBe(false);
    expect(closestInFlatTree(el("#inner"), "body")).toBeNull();
  });

  it("climbs from a closed shadow host's child, whose slot the engine does not report, to the host", () => {
    document.body.innerHTML = '<div id="host"><span id="light">Light</span></div>';
    el("#host").attachShadow({ mode: "closed" }).innerHTML = "<slot></slot>";
    Object.defineProperty(el("#light"), "assignedSlot", { value: null, configurable: true });
    expect(flatTreeParent(el("#light"))).toBe(el("#host"));
  });

  it("holds an element inside itself, through a slot and through a host, and nothing else", () => {
    const { host, shadow } = slotted();
    const frame = shadow.querySelector("#frame") as HTMLElement;

    expect(flatTreeContains(frame, el("#slotted"))).toBe(true);
    expect(flatTreeContains(document.body, shadow.querySelector("#aside"))).toBe(true);
    expect(flatTreeContains(host, host)).toBe(true);
    expect(flatTreeContains(shadow.querySelector("#aside") as Element, el("#slotted"))).toBe(false);
    expect(flatTreeContains(host, null)).toBe(false);
  });

  it("finds the nearest match from the element itself up through its slot and host", () => {
    const { host, shadow } = slotted();
    host.setAttribute("data-mark", "host");
    (shadow.querySelector("#frame") as HTMLElement).setAttribute("data-mark", "frame");

    expect(closestInFlatTree(el("#slotted"), "[data-mark]")?.id).toBe("frame");
    expect(closestInFlatTree(shadow.querySelector("#aside") as Element, "[data-mark]")).toBe(host);
    expect(closestInFlatTree(el("#slotted"), "button")).toBe(el("#slotted"));
    expect(closestInFlatTree(el("#slotted"), "[inert]")).toBeNull();
  });

  it("lists a host's open shadow root children, a slot's assigned elements or its fallback, and an element's children", () => {
    const { host, shadow, slot } = slotted();

    expect(flatTreeChildren(host).map((child) => child.id)).toEqual(["frame", "aside"]);
    expect(flatTreeChildren(slot)).toEqual([el("#slotted")]);
    const empty = document.createElement("slot");
    empty.name = "none";
    empty.innerHTML = '<i id="fallback">Fallback</i>';
    shadow.append(empty);
    expect(flatTreeChildren(empty).map((child) => child.id)).toEqual(["fallback"]);
    expect(flatTreeChildren(shadow.querySelector("#frame") as Element)).toEqual([slot]);
  });

  it("lists a closed shadow host's own children", () => {
    document.body.innerHTML = '<div id="host"><span id="light">Light</span></div>';
    el("#host").attachShadow({ mode: "closed" }).innerHTML = "<p>Shadow</p>";
    expect(flatTreeChildren(el("#host"))).toEqual([el("#light")]);
  });
});
