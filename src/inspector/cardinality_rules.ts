import type { CardinalityRules } from "./types";

/**
 * Hand-written **cardinality rules** (Inspector stage 3).
 *
 * Two contracts recur across the controllers that no per-element rule can
 * state:
 *
 * - **A wrapper resolves to exactly one control.** Where a container target
 *   stands in for a control it contains, holding several is not ambiguous at
 *   runtime — it resolves to the first, every time, for every interaction with
 *   the wrapper. The markup looks deliberate and behaves as if the rest of the
 *   controls were not there.
 * - **At most one element is selected.** In a single-selection scope a second
 *   authored `aria-selected="true"` is normalized away on connect (first in DOM
 *   order wins). That repair is correct — an ARIA-invalid set must not reach
 *   assistive technology — but it *discards the author's stated intent* without
 *   a word. The page then renders a different selection than the source says,
 *   and nothing in the toolchain ever mentions it. A static count is the only
 *   layer that can, because at runtime the evidence is gone by first paint.
 *
 * Scope of the selection rules: only controllers where the initial
 * `aria-selected` is **author-visible on a declared target** — the value carries
 * the committed selection and survives connect as more than a repaint. Where
 * the attribute instead marks the transient active candidate, authoring it is
 * futile rather than over-specified, and the author-futile rules own that case.
 * Where the controller repaints every element from its own state on each render
 * (a calendar grid painting a full month), no authored value survives to be
 * counted.
 *
 * Counting follows the same ownership policy as the runtime: the Stimulus
 * target set, not every element that happens to carry the role. Elements
 * outside it are unmanaged by definition, and the reverse-direction rules are
 * what report them.
 */
export const cardinalityRules: CardinalityRules = {
  // A parent is optional, but the controller derives and cascades through its
  // singular parentTarget. A second parent would display an unmanaged state and
  // its action would still operate on the first one.
  "stimeo--checkbox": [
    {
      within: "",
      target: "parent",
      max: 1,
      suggestion:
        'Keep at most one "parent" target in a checkbox group — omit it for a child-only aggregate, or use one select-all checkbox for the children.',
    },
  ],
  // The picker's selected dot mirrors the visible slide; two of them means the
  // author asked for two slides at once, and connect keeps the first.
  "stimeo--carousel": [
    {
      within: "",
      target: "picker",
      attr: "aria-selected",
      values: ["true"],
      max: 1,
      suggestion:
        'Leave aria-selected="true" on exactly one picker and set the others to "false" — the carousel shows one slide, and connect keeps the first.',
    },
  ],
  // Rows are singly selectable only in the single configuration; the multiple
  // one exists precisely to allow more, so the bound cannot be unconditional.
  "stimeo--data-grid": [
    {
      within: "",
      target: "row",
      attr: "aria-selected",
      values: ["true"],
      max: 1,
      when: { value: "selection", equals: ["single"], default: "none" },
      suggestion:
        'Leave aria-selected="true" on exactly one row, or switch the grid to data-stimeo--data-grid-selection-value="multiple" if several were meant.',
    },
  ],
  // A listbox commits one option, and the committed value is also mirrored into
  // the trigger label and the hidden field on connect — all three derive from
  // the first selected option, so a second one is silently dropped everywhere.
  "stimeo--listbox": [
    {
      within: "",
      target: "option",
      attr: "aria-selected",
      values: ["true"],
      max: 1,
      suggestion:
        'Leave aria-selected="true" on exactly one option and set the others to "false" — the listbox commits a single value, and connect keeps the first.',
    },
  ],
  // The hover region stands in for the trigger it wraps. With several, every
  // hover anywhere in the region opens the first trigger's panel; with none, the
  // region is inert and the wider hover target the author asked for never works.
  "stimeo--navigation-menu": [
    {
      within: "hoverArea",
      target: "trigger",
      min: 1,
      max: 1,
      suggestion:
        "Wrap exactly one trigger per hoverArea — hovering an area that holds several always opens the first trigger's panel.",
    },
  ],
  // A custom radio group has one committed choice. Runtime normalization keeps
  // the first authored `true`, but the discarded choice is still an authoring
  // error that only the static checker can explain before first paint.
  "stimeo--radio-group": [
    {
      within: "",
      target: "radio",
      attr: "aria-checked",
      values: ["true"],
      max: 1,
      suggestion:
        'Leave aria-checked="true" on at most one radio and set the others to "false" — connect keeps the first checked radio in DOM order.',
    },
  ],
  // Tabs are singly selectable by definition; the initial one is server-rendered
  // and connect keeps the first, so a second is a selection the page never shows.
  "stimeo--tabs": [
    {
      within: "",
      target: "tab",
      attr: "aria-selected",
      values: ["true"],
      max: 1,
      suggestion:
        'Leave aria-selected="true" on exactly one tab and set the others to "false" — connect activates the first and deselects the rest.',
    },
  ],
  // A tree commits a single node. The authored selection is the server-rendered
  // one, so a second `true` is a node the tree will never show as selected.
  "stimeo--tree-view": [
    {
      within: "",
      target: "item",
      attr: "aria-selected",
      values: ["true"],
      max: 1,
      suggestion:
        'Leave aria-selected="true" on exactly one item and set the others to "false" — the tree commits a single node, and connect keeps the first.',
    },
  ],
};
