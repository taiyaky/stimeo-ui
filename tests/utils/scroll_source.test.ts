import { afterEach, describe, expect, it } from "vitest";
import {
  resolveScrollContainer,
  resolveScrollSource,
  scrollOffset,
} from "../../src/utils/scroll_source";

/**
 * Behavioral tests for the scroll-source helpers: which element a selector
 * resolves to, when that resolution falls back to the viewport, and how far each
 * kind of source reads as having scrolled.
 */
describe("scroll source", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const mount = (html: string): void => {
    document.body.innerHTML = html;
  };

  describe("resolveScrollContainer", () => {
    it("returns the element a selector names", () => {
      mount('<div id="pane"></div>');

      expect(resolveScrollContainer("#pane")).toBe(document.getElementById("pane"));
    });

    it("reads an empty or unmatched selector as the viewport", () => {
      mount('<div id="pane"></div>');

      expect(resolveScrollContainer("")).toBeNull();
      expect(resolveScrollContainer("#absent")).toBeNull();
    });

    it("reads a match that cannot scroll as the viewport", () => {
      // An SVG node answers the query but is not a scroll container.
      mount('<svg id="chart"></svg>');

      expect(resolveScrollContainer("#chart")).toBeNull();
    });
  });

  describe("resolveScrollSource", () => {
    it("substitutes the window wherever the container reads as the viewport", () => {
      mount('<div id="pane"></div><svg id="chart"></svg>');

      expect(resolveScrollSource("#pane")).toBe(document.getElementById("pane"));
      expect(resolveScrollSource("")).toBe(window);
      expect(resolveScrollSource("#absent")).toBe(window);
      expect(resolveScrollSource("#chart")).toBe(window);
    });
  });

  describe("scrollOffset", () => {
    /** Replaces one window property for the duration of a case. */
    const stubWindow = (name: "scrollY" | "pageYOffset", value: unknown): (() => void) => {
      const original = Object.getOwnPropertyDescriptor(window, name);
      Object.defineProperty(window, name, { configurable: true, value });
      return () => {
        if (original) Object.defineProperty(window, name, original);
      };
    };

    it("reads the window through the modern name", () => {
      const restore = stubWindow("scrollY", 120);
      try {
        expect(scrollOffset(window)).toBe(120);
      } finally {
        restore();
      }
    });

    it("falls back to the legacy name, then to zero", () => {
      const restoreModern = stubWindow("scrollY", undefined);
      const restoreLegacy = stubWindow("pageYOffset", 80);
      try {
        expect(scrollOffset(window)).toBe(80);
        const restoreBoth = stubWindow("pageYOffset", undefined);
        try {
          expect(scrollOffset(window)).toBe(0);
        } finally {
          restoreBoth();
        }
      } finally {
        restoreLegacy();
        restoreModern();
      }
    });

    it("reads an element through its own offset", () => {
      mount('<div id="pane"></div>');
      const pane = document.getElementById("pane") as HTMLElement;
      Object.defineProperty(pane, "scrollTop", { configurable: true, value: 42 });

      expect(scrollOffset(pane)).toBe(42);
    });
  });
});
