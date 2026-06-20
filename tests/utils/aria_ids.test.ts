import { afterEach, describe, expect, it } from "vitest";
import { ensureId, uniqueId } from "../../src/utils/aria_ids";

/**
 * Unit tests for the id primitives backing ARIA relationship wiring: unique id
 * generation and idempotent id assignment.
 */
describe("uniqueId", () => {
  it("returns distinct values on each call", () => {
    const a = uniqueId();
    const b = uniqueId();
    expect(a).not.toBe(b);
  });

  it("applies the given prefix", () => {
    expect(uniqueId("stimeo--form-field-error")).toMatch(/^stimeo--form-field-error-\d+$/);
  });

  it("defaults the prefix to stimeo", () => {
    expect(uniqueId()).toMatch(/^stimeo-\d+$/);
  });
});

describe("ensureId", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps an existing id untouched", () => {
    const el = document.createElement("p");
    el.id = "author-supplied";
    expect(ensureId(el)).toBe("author-supplied");
    expect(el.id).toBe("author-supplied");
  });

  it("assigns and returns a generated id when none exists", () => {
    const el = document.createElement("p");
    const id = ensureId(el, "desc");
    expect(id).toMatch(/^desc-\d+$/);
    expect(el.id).toBe(id);
  });

  it("never produces a collision between two unidentified elements", () => {
    const first = document.createElement("p");
    const second = document.createElement("p");
    expect(ensureId(first)).not.toBe(ensureId(second));
  });

  it("skips an id already owned by an element in the document", () => {
    // Pre-occupy the next counter-based candidate so generation must step past it.
    const taken = uniqueId("collide");
    const occupant = document.createElement("div");
    occupant.id = `collide-${Number(taken.split("-").pop()) + 1}`;
    document.body.appendChild(occupant);

    const el = document.createElement("p");
    document.body.appendChild(el);
    const id = ensureId(el, "collide");
    expect(id).not.toBe(occupant.id);
    expect(document.getElementById(id)).toBe(el);
  });
});
