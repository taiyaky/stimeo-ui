import type { CompositionRules } from "./types";

/**
 * Hand-written **composition rules** (Inspector stage 3, schema v5).
 *
 * Multi-controller compositions carry value-alignment contracts that no
 * single-controller rule can express: the correct value of one controller
 * depends on a value of its host. Each rule below encodes one such contract as
 * a machine check, so dropping or misaligning the value fails `stimeo check`
 * instead of silently breaking keyboard interaction at runtime.
 *
 * Rules fire only when the companion controller is actually co-located —
 * composing at all stays the author's choice. Effective values are compared
 * (authored attribute, or the declared default when absent); the `default`
 * fields duplicate the controllers' `static values` defaults and are
 * drift-guarded by `tests/inspector/manifest.test.ts`.
 */
export const compositionRules: CompositionRules = {
  // Sortable's keyboard contract (the composition contract in
  // docs/specs/basic/sortable.md) hangs on two axis alignments. Both
  // companions default to a value that does NOT match sortable's default
  // `vertical` axis (roving) or can be authored off axis (pointer-drag), and a
  // mismatch is a *silent* failure: Tab still lands on the handles, but the
  // arrow keys do nothing.
  "stimeo--sortable": [
    // roving orientation ⇔ sort axis. roving defaults to `horizontal`, so a
    // vertical list (sortable's default) must author `vertical` (or `both`) —
    // omitted, ↑/↓ stop moving focus between handles.
    {
      target: "list",
      fallbackToScope: true,
      coController: "stimeo--roving",
      when: { value: "orientation", equals: ["vertical"], default: "vertical" },
      require: { value: "orientation", oneOf: ["vertical", "both"], default: "horizontal" },
      suggestion:
        'Set data-stimeo--roving-orientation-value="vertical" on the list so Up/Down move focus between handles (roving defaults to "horizontal").',
    },
    {
      target: "list",
      fallbackToScope: true,
      coController: "stimeo--roving",
      when: { value: "orientation", equals: ["horizontal"], default: "vertical" },
      require: { value: "orientation", oneOf: ["horizontal", "both"], default: "horizontal" },
      suggestion:
        'Set data-stimeo--roving-orientation-value="horizontal" on the list so Left/Right move focus between handles.',
    },
    // pointer-drag axis ⇔ sort axis. The `both` default is always safe; the
    // failure is an authored off-axis lock (`axis="x"` on a vertical list):
    // grabbed arrows on the sort axis are consumed but emit no move.
    {
      target: "item",
      coController: "stimeo--pointer-drag",
      when: { value: "orientation", equals: ["vertical"], default: "vertical" },
      require: { value: "axis", oneOf: ["y", "both"], default: "both" },
      suggestion:
        'Set data-stimeo--pointer-drag-axis-value="y" on the item so grabbed Up/Down (and vertical drags) move it along the list.',
    },
    {
      target: "item",
      coController: "stimeo--pointer-drag",
      when: { value: "orientation", equals: ["horizontal"], default: "vertical" },
      require: { value: "axis", oneOf: ["x", "both"], default: "both" },
      suggestion:
        'Set data-stimeo--pointer-drag-axis-value="x" on the item so grabbed Left/Right (and horizontal drags) move it along the list.',
    },
  ],
};
