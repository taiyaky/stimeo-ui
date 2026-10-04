import { afterEach, describe, expect, it } from "vitest";
import { LivedMark } from "../../src/utils/lived_mark";
import { flushMicrotasks } from "../helpers/timing";

/**
 * The mark that tells a copy of a page Turbo restores from its cache from a fresh render: each
 * connection writes it, a disconnect keeps it, a morph that drops it gets it back, and a new
 * instance that finds it reports the copy while a reconnect of the same instance does not.
 */
describe("LivedMark", () => {
  const marks: LivedMark[] = [];
  afterEach(() => {
    for (const mark of marks) mark.disconnect();
    marks.length = 0;
    document.body.innerHTML = "";
  });

  const MARK = "data-stimeo--drawer-lived";

  const create = (identifier = "stimeo--drawer"): LivedMark => {
    const mark = new LivedMark(identifier);
    marks.push(mark);
    return mark;
  };

  const element = (): HTMLElement => {
    const root = document.createElement("div");
    root.append(document.createElement("span"));
    document.body.append(root);
    return root;
  };

  const morph = (target: Element): void => {
    target.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
  };

  it("reports a fresh element and marks it", () => {
    const root = element();

    expect(create().connect(root)).toBe("fresh");
    expect(root.getAttribute(MARK)).toBe("");
  });

  it("reports a copy of a marked element to a new instance as restored", () => {
    const root = element();
    create().connect(root);
    const copy = root.cloneNode(true) as HTMLElement;

    expect(create().connect(copy)).toBe("restored");
    expect(copy.getAttribute(MARK)).toBe("");
  });

  it("reports a later connection of the same instance as a reconnect, mark or none", () => {
    const root = element();
    const mark = create();
    mark.connect(root);
    mark.disconnect();

    expect(mark.connect(root)).toBe("reconnect");
    root.removeAttribute(MARK);
    mark.disconnect();
    expect(mark.connect(root)).toBe("reconnect");
    expect(root.getAttribute(MARK)).toBe("");
  });

  it("keeps the mark when the controller disconnects", () => {
    const root = element();
    const mark = create();
    mark.connect(root);

    mark.disconnect();

    expect(root.getAttribute(MARK)).toBe("");
    expect(create().connect(root.cloneNode(true) as HTMLElement)).toBe("restored");
  });

  it("writes the mark again after a morph of the element or of a descendant dropped it", async () => {
    const root = element();
    create().connect(root);

    root.removeAttribute(MARK);
    morph(root);
    await flushMicrotasks();
    expect(root.getAttribute(MARK)).toBe("");

    root.removeAttribute(MARK);
    morph(root.querySelector("span") as HTMLElement);
    await flushMicrotasks();
    expect(root.getAttribute(MARK)).toBe("");
  });

  it("stops writing the mark after a morph once disconnected", async () => {
    const root = element();
    const mark = create();
    mark.connect(root);
    mark.disconnect();

    root.removeAttribute(MARK);
    morph(root);
    await flushMicrotasks();

    expect(root.hasAttribute(MARK)).toBe(false);
  });

  it("names the mark after the identifier, so one controller never reads another's", () => {
    const root = element();
    create("stimeo--command-palette").connect(root);

    expect(root.getAttributeNames().filter((name) => name.endsWith("-lived"))).toEqual([
      "data-stimeo--command-palette-lived",
    ]);
    expect(create().connect(root.cloneNode(true) as HTMLElement)).toBe("fresh");
  });
});
