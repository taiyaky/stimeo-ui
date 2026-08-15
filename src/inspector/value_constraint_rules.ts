import type { ValueConstraint, ValueConstraintRules } from "./types";

/** Shared public contract for step-based input controls. */
const POSITIVE_STEP: ValueConstraint = {
  value: "step",
  type: "number",
  finite: true,
  greaterThan: 0,
  suggestion: "Set step to a finite number greater than 0.",
};

/** Minute segments expose integral values, so their step cannot be fractional. */
const POSITIVE_INTEGER_STEP: ValueConstraint = {
  ...POSITIVE_STEP,
  integer: true,
  suggestion: "Set step to a positive integer.",
};

/** Builds the finite-number contract shared by Range Slider's public Values. */
function finiteRangeValue(value: "min" | "max" | "start" | "end"): ValueConstraint {
  return {
    value,
    type: "number",
    finite: true,
    suggestion: `Set ${value} to a finite number.`,
  };
}

/** Literal Stimulus Value contracts that reflection cannot derive from types. */
export const valueConstraintRules: ValueConstraintRules = {
  "stimeo--number-input": [POSITIVE_STEP],
  "stimeo--range-slider": [
    finiteRangeValue("min"),
    finiteRangeValue("max"),
    POSITIVE_STEP,
    finiteRangeValue("start"),
    finiteRangeValue("end"),
  ],
  "stimeo--slider": [POSITIVE_STEP],
  "stimeo--time-picker": [POSITIVE_INTEGER_STEP],
};
