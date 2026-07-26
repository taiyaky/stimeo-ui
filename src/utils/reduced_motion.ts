/**
 * Shared `prefers-reduced-motion` lookup for the motion-aware controllers
 * (count-up, highlight, overflow-indicator, scroll-visibility, stick-to-bottom,
 * transition).
 *
 * Each of those controllers used to duplicate the same guarded `matchMedia`
 * read; this one-liner keeps the media query string and the environment guard
 * single-sourced. The preference is intentionally re-read on every call — the
 * controllers check it at each animation/scroll start (WCAG 2.2 **2.3.3**), so
 * flipping the OS setting takes effect immediately without any listener or
 * cache bookkeeping here.
 */

/**
 * Whether the user currently requests reduced motion.
 *
 * @returns `true` when `(prefers-reduced-motion: reduce)` matches; `false`
 * otherwise, including environments without `window.matchMedia` (treated as
 * "no preference").
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
