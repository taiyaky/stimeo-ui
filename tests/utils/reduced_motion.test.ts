import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion } from "../../src/utils/reduced_motion";

/**
 * Unit tests for {@link prefersReducedMotion}: the shared guarded
 * `(prefers-reduced-motion: reduce)` lookup. `matchMedia` is stubbed per case
 * (happy-dom's built-in always reports `matches: false`), and the stub keys on
 * the query it receives so the exact media query string is pinned.
 */
describe("prefersReducedMotion", () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  /** Installs a `matchMedia` stub that reports `reduce` for the reduce query. */
  const installMatchMedia = (reduce: boolean) => {
    const matchMedia = vi.fn((queryString: string) => ({
      matches: reduce && queryString.includes("prefers-reduced-motion"),
      media: queryString,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }));
    window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
    return matchMedia;
  };

  it("returns true when the reduce preference matches", () => {
    const matchMedia = installMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("returns false when the preference does not match", () => {
    installMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("returns false when matchMedia is unavailable", () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });

  it("re-reads the preference on every call (no caching)", () => {
    const matchMedia = installMatchMedia(true);
    prefersReducedMotion();
    prefersReducedMotion();
    expect(matchMedia).toHaveBeenCalledTimes(2);
  });
});
