import { Application, Controller } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The test environment delivers the callbacks of a one-task replacement in the order
 * browsers do: a replacement that is already in the page leaves first, in argument
 * order, then the departing target, then the arriving ones, which take the old node's
 * place. A single replacement that is the parent or one of its ancestors throws and
 * changes nothing.
 */
describe("one-task replacement in the test environment", () => {
  let application: Application;
  const calls: string[] = [];

  class SlotProbe extends Controller {
    static override targets = ["slot"];
    slotTargetConnected(element: Element): void {
      calls.push(`+${element.id}`);
    }
    slotTargetDisconnected(element: Element): void {
      calls.push(`-${element.id}`);
    }
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const slot = (id: string) => {
    const element = document.createElement("i");
    element.id = id;
    element.setAttribute("data-slot-probe-target", "slot");
    return element;
  };

  beforeEach(async () => {
    document.body.innerHTML =
      '<div id="root" data-controller="slot-probe"><b id="head"></b><i id="old" data-slot-probe-target="slot"></i><b id="tail"></b></div>';
    application = Application.start();
    application.register("slot-probe", SlotProbe);
    await tick();
    calls.length = 0;
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const order = () => Array.from(document.getElementById("root")?.children ?? [], (el) => el.id);

  it("delivers the departing target before the arriving one on replaceWith", async () => {
    document.getElementById("old")?.replaceWith(slot("new"));
    await tick();

    expect(calls).toEqual(["-old", "+new"]);
    expect(order()).toEqual(["head", "new", "tail"]);
  });

  it("places several nodes and text where the old node was", async () => {
    document.getElementById("old")?.replaceWith(slot("a"), "text", slot("b"));
    await tick();

    expect(calls).toEqual(["-old", "+a", "+b"]);
    expect(order()).toEqual(["head", "a", "b", "tail"]);
    expect(document.getElementById("a")?.nextSibling?.textContent).toBe("text");
  });

  it("keeps a node that replaces with itself where it is", async () => {
    const old = document.getElementById("old") as Element;
    old.replaceWith(old);
    await tick();

    expect(order()).toEqual(["head", "old", "tail"]);
  });

  it("does nothing for a node that has no parent", () => {
    const detached = slot("detached");

    expect(() => detached.replaceWith(slot("other"))).not.toThrow();
    expect(detached.parentNode).toBeNull();
  });

  it("delivers the departing target first on replaceChild and returns the old node", async () => {
    const root = document.getElementById("root") as Element;
    const old = document.getElementById("old") as Element;
    const returned = root.replaceChild(slot("new"), old);
    await tick();

    expect(returned).toBe(old);
    expect(calls).toEqual(["-old", "+new"]);
    expect(order()).toEqual(["head", "new", "tail"]);
  });

  it("moves an existing sibling into the old node's place on replaceChild", async () => {
    const root = document.getElementById("root") as Element;
    const tail = document.getElementById("tail") as Element;
    root.replaceChild(tail, document.getElementById("old") as Element);
    await tick();

    expect(order()).toEqual(["head", "tail"]);
  });

  it("falls back to the native replaceChild for a child of another parent", () => {
    const root = document.getElementById("root") as Element;
    const stranger = document.createElement("span");

    expect(() => root.replaceChild(slot("new"), stranger)).toThrow();
  });

  describe("a replacement that is already in the page", () => {
    beforeEach(async () => {
      const root = document.getElementById("root") as Element;
      document.getElementById("old")?.after(slot("next"));
      const other = document.createElement("div");
      other.id = "other";
      other.append(slot("far"));
      root.append(other);
      await tick();
      calls.length = 0;
    });

    const byId = (id: string) => document.getElementById(id) as Element;

    it("delivers a following target leaving before the old one on replaceWith", async () => {
      byId("old").replaceWith(byId("next"));
      await tick();

      expect(calls).toEqual(["-next", "-old", "+next"]);
      expect(order()).toEqual(["head", "next", "tail", "other"]);
    });

    it("delivers a target of another parent leaving before the old one on replaceWith", async () => {
      byId("old").replaceWith(byId("far"));
      await tick();

      expect(calls).toEqual(["-far", "-old", "+far"]);
      expect(order()).toEqual(["head", "far", "next", "tail", "other"]);
    });

    it("delivers the replacements leaving in argument order, the old node included", async () => {
      const old = byId("old");
      old.replaceWith(slot("a"), old, byId("next"));
      await tick();

      expect(calls).toEqual(["-old", "-next", "+a", "+old", "+next"]);
      expect(order()).toEqual(["head", "a", "old", "next", "tail", "other"]);
    });

    it("delivers a following target leaving before the old one on replaceChild", async () => {
      byId("root").replaceChild(byId("next"), byId("old"));
      await tick();

      expect(calls).toEqual(["-next", "-old", "+next"]);
      expect(order()).toEqual(["head", "next", "tail", "other"]);
    });

    it("delivers a target of another parent leaving before the old one on replaceChild", async () => {
      byId("root").replaceChild(byId("far"), byId("old"));
      await tick();

      expect(calls).toEqual(["-far", "-old", "+far"]);
      expect(order()).toEqual(["head", "far", "next", "tail", "other"]);
    });

    it("throws and changes nothing when replaceWith is given the parent or an ancestor", async () => {
      expect(() => byId("old").replaceWith(byId("root"))).toThrow();
      expect(() => byId("old").replaceWith(document.body)).toThrow();
      await tick();

      expect(calls).toEqual([]);
      expect(order()).toEqual(["head", "old", "next", "tail", "other"]);
    });

    it("throws and changes nothing when replaceChild is given the parent or an ancestor", async () => {
      expect(() => byId("root").replaceChild(byId("root"), byId("old"))).toThrow();
      expect(() => byId("root").replaceChild(document.body, byId("old"))).toThrow();
      await tick();

      expect(calls).toEqual([]);
      expect(order()).toEqual(["head", "old", "next", "tail", "other"]);
    });
  });
});
