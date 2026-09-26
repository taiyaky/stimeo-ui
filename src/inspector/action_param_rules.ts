import type { ActionParamRules } from "./types";

/**
 * Hand-written **action-param rules** (Inspector stage 1).
 *
 * Stimulus assembles `event.params` from `data-<identifier>-<param>-param` on the
 * element carrying the `data-action`. The spelling is not reflected anywhere, so a
 * param that never arrives reads the same as one the author never meant to send:
 * the method runs, finds nothing, and returns. The control is bound, looks wired,
 * and does nothing.
 *
 * A param is `required` only where the reader has **no other way** to the value.
 * Most readers fall back to `event.detail`, and a page that drives the action with
 * a `CustomEvent` is correct without any param attribute at all — declaring those
 * required would report working markup.
 *
 * `allowedValues` is for a reader that accepts a fixed set, and `integer` for one
 * that takes a whole number. Declaring either also names the values that are
 * silently normalized away, which is the other shape of the same defect: the author
 * wrote something, the widget did something else, and nothing said so.
 */
export const actionParamRules: ActionParamRules = {
  // The direction decides which way the page scrolls and is read nowhere else:
  // without it the handler returns, and the end-of-scroll disabling reads the same
  // attribute, so the button neither scrolls nor dims.
  "stimeo--overflow-indicator": [
    {
      action: "scrollByPage",
      param: "direction",
      required: true,
      allowedValues: ["start", "end"],
      suggestion:
        'Name the direction: data-stimeo--overflow-indicator-direction-param="end" (or "start").',
    },
  ],
  // The index is the whole instruction. Without it the jump stops, and a value
  // between two steps stops the same way: the reader takes the number only where it
  // is whole.
  "stimeo--stepper": [
    {
      action: "goto",
      param: "index",
      required: true,
      integer: true,
      suggestion: 'Name the step: data-stimeo--stepper-index-param="2".',
    },
  ],
  // Both fields fall back to the event's detail, so a page dispatching a
  // `CustomEvent` needs no attribute. The type decides the live-region urgency and
  // anything but "alert" settles as a polite status, which discards an author who
  // meant the urgent one.
  "stimeo--toast": [
    {
      action: "show",
      param: "type",
      allowedValues: ["status", "alert"],
      suggestion:
        'Use data-stimeo--toast-type-param="alert" for an urgent toast, or "status" for the polite default.',
    },
  ],
  // Assertive is a boolean Stimulus casts from the attribute. A value it cannot
  // cast settles as polite, which is the opposite of what the author asked for.
  "stimeo--announcer": [
    {
      action: "announce",
      param: "assertive",
      allowedValues: ["true", "false"],
      suggestion: 'Write the flag as data-stimeo--announcer-assertive-param="true".',
    },
  ],
};
