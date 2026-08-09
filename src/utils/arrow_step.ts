import { isRtl } from "./logical_scroll";

/**
 * Turns an arrow key into a **logical** step: `+1` for "next", `-1` for
 * "previous", `0` when the key names neither.
 *
 * APG defines the horizontal pair as *next / previous* and says a vertical
 * arrangement swaps in Down/Up for the same meaning — so the pair is one axis's
 * spelling of an order, and the order reverses with the writing direction. Only
 * the horizontal pair reverses. Down/Up name an axis the writing direction does
 * not mirror, and returning them unchanged is the point: many controllers fold
 * both pairs into one branch, where swapping the branches under RTL would flip
 * the vertical axis too — a bug that reads as "the arrows work" until someone
 * presses Down.
 *
 * **Direction is read from the element the caller passes, which should be the
 * container that lays the items out** — not the focused child. A child may carry
 * its own `dir` (an LTR input inside an RTL form is ordinary authoring), and
 * probing per handler makes two handlers disagree at the boundary between them.
 *
 * This decides direction only. Whether the axis is even active (an
 * `orientation="horizontal"` widget ignoring Down/Up), how far the step lands,
 * and what wrapping does all stay with the caller.
 *
 * **It encodes the list-order convention: `ArrowDown` is *next*.** Widgets that
 * pair the arrows by *value* instead — `ArrowUp` meaning "more", as a rating or a
 * slider does — must not use this, or their vertical axis inverts. Reverse the
 * horizontal pair on its own there.
 *
 * @example
 * ```ts
 * const step = logicalArrowStep(event.key, this.element);
 * if (step === 0) return;
 * this.#roving.setActive(rovingMove(current, length, step, "wrap"), { focus: true });
 * ```
 */
export function logicalArrowStep(key: string, element: Element): 1 | -1 | 0 {
  if (key === "ArrowDown") return 1;
  if (key === "ArrowUp") return -1;
  if (key !== "ArrowRight" && key !== "ArrowLeft") return 0;
  const forward = isRtl(element) ? "ArrowLeft" : "ArrowRight";
  return key === forward ? 1 : -1;
}

/**
 * Rewrites `key` so an existing LTR-shaped branch keeps working under RTL:
 * `ArrowRight` and `ArrowLeft` trade places, everything else passes through.
 *
 * The alternative — negating a delta — silently breaks handlers whose two
 * horizontal branches are **not mirror images**. A grid that clamps one edge but
 * not the other, or a segmented field guarding `index > 0` on one side and
 * `index < length - 1` on the other, ends up applying the wrong guard to the
 * wrong direction. Swapping the key leaves each branch, guards and all, exactly
 * where its author put it.
 *
 * Same rule as {@link logicalArrowStep} about which element to read: pass the
 * container that lays the items out, not the focused child.
 *
 * @example
 * ```ts
 * switch (logicalArrowKey(event.key, this.element)) {
 *   case "ArrowLeft": // "previous" — whatever direction that is on screen
 * ```
 */
export function logicalArrowKey(key: string, element: Element): string {
  if (key !== "ArrowRight" && key !== "ArrowLeft") return key;
  if (!isRtl(element)) return key;
  return key === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
}

/** Modifiers a widget may claim on an arrow key, named for the `allow` list. */
export type ArrowModifier = "alt" | "ctrl" | "meta" | "shift";

/**
 * True when an arrow key arrived carrying a modifier the widget must leave to
 * the browser: return without calling `preventDefault()` and without moving any
 * state.
 *
 * A bare arrow belongs to the widget; a chorded one usually does not.
 * `Alt`/`Meta` plus a horizontal arrow is history back/forward on every desktop
 * browser, and a widget that swallows it makes the shortcut work or not
 * depending on where focus happens to sit — a coin-flip the user cannot see.
 *
 * `allow` is for the combinations APG assigns to a pattern **and the widget
 * actually implements** — today only Combobox's optional `Alt+Down`/`Alt+Up`.
 * Listing one the widget does not implement defeats the point: the chord then
 * runs the plain-arrow branch, which is exactly what this guard exists to stop.
 * Non-arrow keys return `false`, so chorded letters and
 * `Control+Home`/`Control+End` are untouched.
 *
 * @example
 * ```ts
 * if (isReservedArrowChord(event)) return;
 * ```
 */
export function isReservedArrowChord(
  event: KeyboardEvent,
  allow: readonly ArrowModifier[] = [],
): boolean {
  if (!event.key.startsWith("Arrow")) return false;
  return (
    (event.altKey && !allow.includes("alt")) ||
    (event.ctrlKey && !allow.includes("ctrl")) ||
    (event.metaKey && !allow.includes("meta")) ||
    (event.shiftKey && !allow.includes("shift"))
  );
}
