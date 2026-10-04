import type { ValueConstraintRules, ValueSyntaxConstraintRules } from "./types";

/** Literal String Value contracts whose accepted values are explicitly listed. */
export const valueConstraintRules: ValueConstraintRules = {
  "stimeo--separator": [
    {
      value: "orientation",
      type: "string",
      allowedValues: ["horizontal", "vertical"],
      suggestion: 'Set orientation to "horizontal" or "vertical".',
    },
  ],
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
