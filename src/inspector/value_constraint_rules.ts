import type { ValueConstraint, ValueConstraintRules, ValueSyntaxConstraintRules } from "./types";

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
  "stimeo--carousel": [
    {
      value: "interval",
      type: "number",
      finite: true,
      greaterThan: 0,
      suggestion:
        "Set interval to a finite number of milliseconds greater than 0 — anything else falls back to 5000 at runtime.",
    },
  ],
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

/**
 * Grammar contracts on the String Values whose accepted set cannot be listed.
 *
 * Kept apart from {@link valueConstraintRules} because they reach the manifest
 * through their own field, which an engine that predates them skips rather than
 * reading through `allowedValues`.
 */
export const valueSyntaxConstraintRules: ValueSyntaxConstraintRules = {
  "stimeo--input-mask": [
    {
      value: "tokens",
      type: "string",
      syntax: "json-object",
      entries: "regexp",
      suggestion:
        "Declare tokens as a JSON object of single-character keys to regex sources, " +
        'e.g. \'{"H":"[0-9A-Fa-f]"}\' — a source that does not compile leaves that key on ' +
        "its default at runtime, and a key without one stops being a token at all.",
    },
  ],
  "stimeo--otp": [
    {
      value: "pattern",
      type: "string",
      syntax: "regexp",
      suggestion:
        "Set pattern to a regular expression matching one character, e.g. [0-9a-f] — " +
        "a source that does not compile falls back to [0-9] at runtime.",
    },
  ],
};
