import type { KeyboardRules } from "./types";

/**
 * Hand-written **keyboard prerequisites** (Inspector stage 3).
 *
 * Static markup cannot prove key *behavior* — that is the library's own
 * contract, and it holds at runtime. What markup CAN break is **focus
 * reachability**: div-based operation points that keyboard users can only reach
 * when the author makes them focusable. These rules list exactly the targets
 * whose documented contract authors `tabindex` because the controller never
 * writes it:
 *
 * - It moves focus (`element.focus()`, which silently no-ops on a
 *   non-focusable element) or relies on the element being in the Tab order,
 *   and
 * - it does **not** initialize a roving tabindex on connect.
 *
 * Deliberately absent: every roving composite that assigns `tabindex` on
 * connect (tabs, toolbar, radio group, tree view, menubar, data grid,
 * calendar, date range picker, carousel), `stimeo--switch` (it defaults its
 * own `tabindex`), activedescendant patterns whose options are never focused
 * (combobox / listbox / command palette options), and targets whose contract
 * is a natively focusable element with no authored `tabindex` (dialog
 * triggers, combobox inputs) — a native element passes trivially, so a rule
 * would carry no signal.
 *
 * Each entry declares {@link KeyboardRequirement.reach}: `"tab"` for steady
 * Tab stops (the controller never touches their `tabindex`, so the authored
 * value *is* the steady state and must be `0` / native), `"focus"` for the two
 * menu families whose items the controller reaches with `element.focus()` and
 * which the APG pattern authors `tabindex="-1"`. The set-level roving invariant
 * ("exactly one item is `0`") stays runtime state the per-element engine does
 * not model.
 */
export const keyboardRules: KeyboardRules = {
  // APG slider thumb: a single Tab stop (the controller never roves it), so a
  // tabindex="-1" would strand it out of the Tab order.
  "stimeo--slider": [
    {
      target: "thumb",
      reach: "tab",
      suggestion: 'Add tabindex="0" to the thumb target (or use a natively focusable element).',
    },
  ],
  // Both thumbs are independent Tab stops, each authoring its own tabindex="0".
  "stimeo--range-slider": [
    {
      target: "startThumb",
      reach: "tab",
      suggestion:
        'Add tabindex="0" to the startThumb target (or use a natively focusable element).',
    },
    {
      target: "endThumb",
      reach: "tab",
      suggestion: 'Add tabindex="0" to the endThumb target (or use a natively focusable element).',
    },
  ],
  // Each color channel is an APG slider div operated in place — a Tab stop.
  "stimeo--color-picker": [
    {
      target: "slider",
      reach: "tab",
      suggestion: 'Add tabindex="0" to each slider target (or use a natively focusable element).',
    },
  ],
  // APG spinbutton segments: inline spans the user tabs between (each a Tab stop).
  "stimeo--time-picker": [
    {
      target: "segment",
      reach: "tab",
      suggestion: 'Add tabindex="0" to each segment target (or use a natively focusable element).',
    },
  ],
  // APG window splitter: the separator handle is dragged *and* keyed — a Tab stop.
  "stimeo--resizable": [
    {
      target: "separator",
      reach: "tab",
      suggestion: 'Add tabindex="0" to the separator target (or use a natively focusable element).',
    },
  ],
  // Menu items are roved via element.focus(); the contract authors
  // tabindex="-1" so non-native items are focusable without joining the Tab
  // order. Native buttons/links pass without any tabindex → reach: "focus".
  "stimeo--menu": [
    {
      target: "item",
      reach: "focus",
      suggestion:
        'Make each item target focusable: a native button/link, or tabindex="-1" for the roving focus.',
    },
  ],
  "stimeo--context-menu": [
    {
      // The right-click region is also the keyboard entry point (Shift+F10 /
      // the ContextMenu key only fire on a focused element) — a Tab stop.
      target: "region",
      reach: "tab",
      suggestion:
        'Add tabindex="0" to the region target so keyboard users can invoke the context menu.',
    },
    {
      // Items are roved via element.focus() (authored tabindex="-1").
      target: "item",
      reach: "focus",
      suggestion:
        'Make each item target focusable: a native button/link, or tabindex="-1" for the roving focus.',
    },
  ],
};
