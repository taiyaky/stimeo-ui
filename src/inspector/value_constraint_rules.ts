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
function finiteRangeValue(value: "min" | "max" | "start" | "end" | "value"): ValueConstraint {
  return {
    value,
    type: "number",
    finite: true,
    suggestion: `Set ${value} to a finite number.`,
  };
}

/** Builds the non-negative integer contract used by Character Counter counts. */
function nonNegativeCharacterCount(value: "max" | "warnAt"): ValueConstraint {
  return {
    value,
    type: "number",
    finite: true,
    greaterThan: -1,
    integer: true,
    suggestion: `Set ${value} to a non-negative integer.`,
  };
}

/** Literal Stimulus Value contracts that reflection cannot derive from types. */
export const valueConstraintRules: ValueConstraintRules = {
  "stimeo--character-counter": [
    nonNegativeCharacterCount("max"),
    nonNegativeCharacterCount("warnAt"),
  ],
  "stimeo--number-input": [POSITIVE_STEP],
  "stimeo--range-slider": [
    finiteRangeValue("min"),
    finiteRangeValue("max"),
    POSITIVE_STEP,
    finiteRangeValue("start"),
    finiteRangeValue("end"),
  ],
  "stimeo--separator": [
    {
      value: "orientation",
      type: "string",
      allowedValues: ["horizontal", "vertical"],
      suggestion: 'Set orientation to "horizontal" or "vertical".',
    },
    finiteRangeValue("min"),
    finiteRangeValue("max"),
    POSITIVE_STEP,
    finiteRangeValue("value"),
  ],
  "stimeo--slider": [POSITIVE_STEP],
  "stimeo--time-picker": [POSITIVE_INTEGER_STEP],
};
