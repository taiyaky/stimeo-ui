import { describe, expect, it, vi } from "vitest";
import { ownerIndex, ownerOf, ownersOf } from "../../src/utils/event_owner";

/**
 * Tests for {@link ownerIndex}, {@link ownerOf} and {@link ownersOf}.
 *
 * The non-`Node` cases carry the most detail because the environment hides the
 * hazard they exist for: happy-dom answers `contains(anything)` with `false`,
 * while browsers throw `TypeError` for a target that is not a `Node`. A test
 * that only asserted the return value would therefore pass with the narrowing
 * removed, so these cases assert the mechanism instead — that `contains` is
 * never reached. The project does not configure `restoreMocks`, so each spy is
 * restored in a `finally` rather than by a blanket restore that would also drop
 * one another file installed.
 */
describe("ownerIndex", () => {
  const fixture = () => {
    document.body.innerHTML = `
      <div id="outer">
        <div id="inner"><button id="deep">deep</button></div>
      </div>
      <p id="outside">outside</p>`;
    const at = (id: string) => document.querySelector(`#${id}`) as HTMLElement;
    return { outer: at("outer"), inner: at("inner"), deep: at("deep"), outside: at("outside") };
  };

  it("finds a candidate that is the node itself", () => {
    const { outside, inner } = fixture();
    expect(ownerIndex([outside, inner], inner)).toBe(1);
  });

  it("finds the candidate that contains the node", () => {
    const { inner, deep } = fixture();
    expect(ownerIndex([inner], deep)).toBe(0);
  });

  it("finds the candidate owning a node that is not an element", () => {
    const { inner, deep } = fixture();
    const text = deep.firstChild as Text;
    // Pinned: if the fixture's button started with an element, this would pass as an
    // element case.
    expect(text.nodeType).toBe(Node.TEXT_NODE);
    expect(ownerIndex([inner], text)).toBe(0);
  });

  it("answers -1 when the node is an ancestor of a candidate", () => {
    const { outer, inner } = fixture();
    expect(ownerIndex([inner], outer)).toBe(-1);
  });

  it("answers -1 when no candidate owns the node", () => {
    const { inner, outside } = fixture();
    expect(ownerIndex([inner], outside)).toBe(-1);
  });

  it("answers -1 for an empty candidate list", () => {
    const { deep } = fixture();
    expect(ownerIndex([], deep)).toBe(-1);
  });

  it("resolves nested candidates in the order they were listed", () => {
    const { outer, inner, deep } = fixture();
    expect(ownerIndex([outer, inner], deep)).toBe(0);
    expect(ownerIndex([inner, outer], deep)).toBe(0);
  });

  it("answers -1 for an event target that is not a node, without testing it", () => {
    const { outer } = fixture();
    const contains = vi.spyOn(Node.prototype, "contains");
    try {
      expect(ownerIndex([outer], new EventTarget())).toBe(-1);
      expect(contains).not.toHaveBeenCalled();
    } finally {
      contains.mockRestore();
    }
  });

  it("answers -1 for a missing node, without testing it", () => {
    const { outer } = fixture();
    const contains = vi.spyOn(Node.prototype, "contains");
    try {
      expect(ownerIndex([outer], null)).toBe(-1);
      expect(ownerIndex([outer], undefined)).toBe(-1);
      expect(contains).not.toHaveBeenCalled();
    } finally {
      contains.mockRestore();
    }
  });
});

describe("ownerOf", () => {
  const fixture = () => {
    document.body.innerHTML = `
      <div id="a"><span id="deep">deep</span></div>
      <div id="b"></div>
      <p id="outside">outside</p>`;
    const at = (id: string) => document.querySelector(`#${id}`) as HTMLElement;
    return { a: at("a"), b: at("b"), deep: at("deep"), outside: at("outside") };
  };

  it("returns the candidate that owns the node", () => {
    const { a, b, deep } = fixture();
    expect(ownerOf([a, b], deep)).toBe(a);
    expect(ownerOf([a, b], b)).toBe(b);
  });

  it("returns null when no candidate owns the node", () => {
    const { a, outside } = fixture();
    expect(ownerOf([a], outside)).toBeNull();
  });

  it("returns null when the node is an ancestor of a candidate", () => {
    const { a } = fixture();
    expect(ownerOf([a], document.body)).toBeNull();
  });

  it("returns null for absent and non-node targets", () => {
    const { a } = fixture();
    const contains = vi.spyOn(Node.prototype, "contains");
    try {
      expect(ownerOf([a], null)).toBeNull();
      expect(ownerOf([a], new EventTarget())).toBeNull();
      expect(contains).not.toHaveBeenCalled();
    } finally {
      contains.mockRestore();
    }
  });
});

describe("ownersOf", () => {
  const fixture = () => {
    document.body.innerHTML = `
      <div id="outer">
        <div id="inner"><button id="deep">deep</button></div>
        <div id="beside"></div>
      </div>
      <p id="outside">outside</p>`;
    const at = (id: string) => document.querySelector(`#${id}`) as HTMLElement;
    return {
      outer: at("outer"),
      inner: at("inner"),
      deep: at("deep"),
      beside: at("beside"),
      outside: at("outside"),
    };
  };

  it("returns every candidate that holds the node, in the order they were listed", () => {
    const { outer, inner, beside, outside, deep } = fixture();
    expect(ownersOf([outer, beside, inner, outside], deep)).toEqual([outer, inner]);
    expect(ownersOf([inner, outer], deep)).toEqual([inner, outer]);
  });

  it("includes a candidate that is the node itself alongside its ancestor", () => {
    const { outer, inner, beside } = fixture();
    expect(ownersOf([outer, inner], inner)).toEqual([outer, inner]);
    expect(ownersOf([outer, inner, beside], beside)).toEqual([outer, beside]);
  });

  it("returns the one owner of a node held by a single candidate", () => {
    const { inner, beside } = fixture();
    expect(ownersOf([inner, beside], beside)).toEqual([beside]);
  });

  it("finds the owners of a node that is not an element", () => {
    const { outer, inner, deep } = fixture();
    const text = deep.firstChild as Text;
    // Pinned: if the fixture's button started with an element, this would pass as an
    // element case.
    expect(text.nodeType).toBe(Node.TEXT_NODE);
    expect(ownersOf([outer, inner], text)).toEqual([outer, inner]);
  });

  it("returns an empty list when no candidate holds the node", () => {
    const { inner, beside, outside, outer } = fixture();
    expect(ownersOf([inner, beside], outside)).toEqual([]);
    expect(ownersOf([inner], outer)).toEqual([]);
    expect(ownersOf([], outer)).toEqual([]);
  });

  it("returns an empty list for absent and non-node targets, without testing them", () => {
    const { outer } = fixture();
    const contains = vi.spyOn(Node.prototype, "contains");
    try {
      expect(ownersOf([outer], null)).toEqual([]);
      expect(ownersOf([outer], undefined)).toEqual([]);
      expect(ownersOf([outer], new EventTarget())).toEqual([]);
      expect(contains).not.toHaveBeenCalled();
    } finally {
      contains.mockRestore();
    }
  });

  it("leaves the candidate list as it was", () => {
    const { outer, inner, beside, deep } = fixture();
    const candidates = [outer, beside, inner];

    const owners = ownersOf(candidates, deep);

    expect(owners).not.toBe(candidates);
    expect(candidates).toEqual([outer, beside, inner]);
  });
});
