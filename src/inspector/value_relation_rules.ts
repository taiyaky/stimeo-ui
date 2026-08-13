import type { ValueRelationRules } from "./types";

/** Literal relationships between Values that reflection cannot derive. */
export const valueRelationRules: ValueRelationRules = {
  "stimeo--range-slider": [
    {
      left: "min",
      operator: "less-than-or-equal",
      right: "max",
      leftDefault: 0,
      rightDefault: 100,
      suggestion: "Set min to a finite number less than or equal to max.",
    },
  ],
};
