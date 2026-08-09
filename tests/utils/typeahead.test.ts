import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findTypeaheadMatch,
  isTypeaheadKey,
  TYPEAHEAD_RESET_MS,
  Typeahead,
  typeaheadLabel,
} from "../../src/utils/typeahead";

/**
 * Unit tests for the shared type-ahead primitive: query accumulation with an idle
 * reset ({@link Typeahead}), the printable-key predicate, name resolution, and the
 * wrapping prefix search. These are the mechanical halves the widgets share; the
 * per-pattern policy (candidate set, what a match does) stays in the controllers.
 */
describe("Typeahead", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with an empty query", () => {
    expect(new Typeahead().query).toBe("");
  });

  it("lowercases each pushed character", () => {
    const typeahead = new Typeahead();
    expect(typeahead.push("S")).toBe("s");
    expect(typeahead.query).toBe("s");
  });

  it("concatenates distinct characters into one prefix", () => {
    const typeahead = new Typeahead();
    typeahead.push("s");
    expect(typeahead.push("e")).toBe("se");
  });

  it("collapses a repeated character back to a single-character query", () => {
    const typeahead = new Typeahead();
    typeahead.push("c");
    expect(typeahead.push("c")).toBe("c");
    expect(typeahead.push("c")).toBe("c");
  });

  it("resumes narrowing after a repeat instead of carrying a dead query", () => {
    // The whole point of collapsing the stored query: "s","s","e" must search
    // "se". Deriving a shorter query only at search time would leave "sse" here,
    // which no label can match.
    const typeahead = new Typeahead();
    typeahead.push("s");
    typeahead.push("s");
    expect(typeahead.push("e")).toBe("se");
  });

  it("treats a character that only matches part of the query as narrowing", () => {
    const typeahead = new Typeahead();
    typeahead.push("s");
    typeahead.push("e");
    // "e" repeats the last character but not the whole query, so it narrows.
    expect(typeahead.push("e")).toBe("see");
  });

  it("drops the query once the idle window elapses", () => {
    const typeahead = new Typeahead();
    typeahead.push("s");
    vi.advanceTimersByTime(TYPEAHEAD_RESET_MS);
    expect(typeahead.query).toBe("");
  });

  it("keeps accumulating while presses stay inside the idle window", () => {
    const typeahead = new Typeahead();
    typeahead.push("s");
    vi.advanceTimersByTime(TYPEAHEAD_RESET_MS - 1);
    expect(typeahead.push("e")).toBe("se");
    // The second press restarted the window rather than inheriting its remainder.
    vi.advanceTimersByTime(TYPEAHEAD_RESET_MS - 1);
    expect(typeahead.query).toBe("se");
  });

  it("honors a custom idle window", () => {
    const typeahead = new Typeahead({ resetMs: 50 });
    typeahead.push("s");
    vi.advanceTimersByTime(49);
    expect(typeahead.query).toBe("s");
    vi.advanceTimersByTime(1);
    expect(typeahead.query).toBe("");
  });

  it("defaults the idle window to TYPEAHEAD_RESET_MS", () => {
    expect(TYPEAHEAD_RESET_MS).toBe(500);
    const typeahead = new Typeahead({});
    typeahead.push("s");
    vi.advanceTimersByTime(TYPEAHEAD_RESET_MS - 1);
    expect(typeahead.query).toBe("s");
  });

  it("cancels the pending reset on reset(), so nothing outlives a disconnect", () => {
    const typeahead = new Typeahead();
    typeahead.push("s");
    expect(vi.getTimerCount()).toBe(1);

    typeahead.reset();
    expect(typeahead.query).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps only one pending reset across repeated presses", () => {
    const typeahead = new Typeahead();
    typeahead.push("s");
    typeahead.push("e");
    typeahead.push("n");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("starts a fresh query after a reset", () => {
    const typeahead = new Typeahead();
    typeahead.push("s");
    typeahead.reset();
    expect(typeahead.push("e")).toBe("e");
  });
});

describe("isTypeaheadKey", () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

  it("accepts a bare printable character", () => {
    expect(isTypeaheadKey(key({ key: "a" }))).toBe(true);
  });

  it("rejects multi-character keys", () => {
    expect(isTypeaheadKey(key({ key: "ArrowDown" }))).toBe(false);
    expect(isTypeaheadKey(key({ key: "Enter" }))).toBe(false);
  });

  it("rejects Space so a button-based item keeps native activation", () => {
    expect(isTypeaheadKey(key({ key: " " }))).toBe(false);
  });

  it("rejects command chords", () => {
    expect(isTypeaheadKey(key({ key: "a", ctrlKey: true }))).toBe(false);
    expect(isTypeaheadKey(key({ key: "a", metaKey: true }))).toBe(false);
    expect(isTypeaheadKey(key({ key: "a", altKey: true }))).toBe(false);
  });

  it("accepts a shifted character (Shift alone is not a command chord)", () => {
    expect(isTypeaheadKey(key({ key: "A", shiftKey: true }))).toBe(true);
  });

  it("rejects input that is still being composed", () => {
    expect(isTypeaheadKey(key({ key: "a", isComposing: true }))).toBe(false);
  });
});

describe("typeaheadLabel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const element = (html: string) => {
    document.body.innerHTML = html;
    return document.body.firstElementChild as HTMLElement;
  };

  it("normalizes text content by trimming and lowercasing", () => {
    expect(typeaheadLabel(element("<div>  Read Me  </div>"))).toBe("read me");
  });

  it("prefers an authored aria-label over the text", () => {
    expect(typeaheadLabel(element('<div aria-label="Zeta">Alpha</div>'))).toBe("zeta");
  });

  it("skips a blank aria-label, matching accname", () => {
    // A screen reader announces "Alpha" here, so type-ahead must reach it by "a".
    expect(typeaheadLabel(element('<div aria-label="">Alpha</div>'))).toBe("alpha");
    expect(typeaheadLabel(element('<div aria-label="   ">Alpha</div>'))).toBe("alpha");
  });

  it("uses the supplied fallback text instead of the whole subtree", () => {
    const item = element("<div>Docs<ul><li>readme</li></ul></div>");
    expect(typeaheadLabel(item, () => "Docs")).toBe("docs");
  });

  it("still lets an authored aria-label win over the supplied fallback", () => {
    const item = element('<div aria-label="Zeta">Docs<ul><li>readme</li></ul></div>');
    expect(typeaheadLabel(item, () => "Docs")).toBe("zeta");
  });

  it("does not call the fallback when an aria-label names the element", () => {
    // Laziness is the contract: a tree item's fallback walks its subtree, and a
    // named row must not pay for it on every candidate of every keypress.
    const item = element('<div aria-label="Zeta">Docs</div>');
    const fallback = vi.fn(() => "Docs");
    expect(typeaheadLabel(item, fallback)).toBe("zeta");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back through a blank aria-label to the supplied source", () => {
    const item = element('<div aria-label=" ">Docs<ul><li>readme</li></ul></div>');
    expect(typeaheadLabel(item, () => "Docs")).toBe("docs");
  });
});

describe("findTypeaheadMatch", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const list = (...labels: string[]): HTMLElement[] => {
    document.body.innerHTML = labels.map((label) => `<div>${label}</div>`).join("");
    return Array.from(document.body.children) as HTMLElement[];
  };

  it("starts the search just after `from`", () => {
    const items = list("beta", "bravo", "alpha");
    expect(findTypeaheadMatch(items, 0, "b")).toBe(1);
  });

  it("wraps around and evaluates `from` itself last", () => {
    const items = list("beta", "bravo", "alpha");
    expect(findTypeaheadMatch(items, 1, "b")).toBe(0);
  });

  it("returns `from` when it is the only match", () => {
    const items = list("beta", "alpha", "gamma");
    expect(findTypeaheadMatch(items, 0, "b")).toBe(0);
  });

  it("treats -1 as 'nothing current' and starts at the first item", () => {
    const items = list("alpha", "beta");
    expect(findTypeaheadMatch(items, -1, "a")).toBe(0);
  });

  it("folds an out-of-range `from` back into the list rather than skipping slots", () => {
    // `%` keeps the sign of its left operand, so a single fold would leave a
    // negative index — an empty slot that silently drops a candidate.
    const items = list("alpha", "beta");
    expect(findTypeaheadMatch(items, -3, "b")).toBe(1);
    expect(findTypeaheadMatch(items, -3, "a")).toBe(0);
    expect(findTypeaheadMatch(items, 7, "a")).toBe(0);
  });

  it("returns -1 when nothing matches", () => {
    const items = list("alpha", "beta");
    expect(findTypeaheadMatch(items, 0, "z")).toBe(-1);
  });

  it("returns -1 for an empty candidate list", () => {
    expect(findTypeaheadMatch([], 0, "a")).toBe(-1);
  });

  it("returns -1 for an empty query rather than matching everything", () => {
    const items = list("alpha", "beta");
    expect(findTypeaheadMatch(items, 0, "")).toBe(-1);
  });

  it("matches a multi-character prefix", () => {
    const items = list("save", "save as", "send");
    expect(findTypeaheadMatch(items, 0, "sa")).toBe(1);
  });

  it("matches on a prefix, not a substring", () => {
    const items = list("alpha", "the beta");
    expect(findTypeaheadMatch(items, 0, "beta")).toBe(-1);
  });

  it("resolves names through aria-label by default", () => {
    const items = list("alpha", "beta");
    items[1]?.setAttribute("aria-label", "zeta");
    expect(findTypeaheadMatch(items, 0, "z")).toBe(1);
    expect(findTypeaheadMatch(items, 0, "b")).toBe(-1);
  });

  it("uses a supplied label resolver instead of the default", () => {
    const items = list("alpha", "beta");
    const byIndex = (item: HTMLElement) => (item === items[0] ? "second" : "first");
    expect(findTypeaheadMatch(items, -1, "first", byIndex)).toBe(1);
  });

  it("visits every candidate exactly once", () => {
    const items = list("alpha", "beta", "gamma");
    const seen: string[] = [];
    findTypeaheadMatch(items, 0, "zzz", (item) => {
      seen.push(item.textContent ?? "");
      return item.textContent ?? "";
    });
    expect(seen).toEqual(["beta", "gamma", "alpha"]);
  });
});
