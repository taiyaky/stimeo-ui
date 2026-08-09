import type { CompanionRules } from "./types";

/**
 * Hand-written **required-companion rules** (Inspector stage 3).
 *
 * A controller may delegate an entire interaction to a second controller placed
 * on one of its own elements. Where that delegation is the design — not an
 * optional enhancement — the companion is part of the markup contract, and its
 * absence is a silent failure: the markup renders, every name and structure
 * check passes, and the delegated behavior simply never happens.
 *
 * Composition rules cannot cover this. They fire only once the companion is
 * co-located, which is exactly right for optional compositions (whether to
 * compose is the author's call) and exactly wrong here — the case to report is
 * the companion being missing.
 *
 * Kept deliberately small: a rule belongs here only when the host provides no
 * fallback for the missing behavior. A host that degrades gracefully documents
 * the composition instead.
 */
export const companionRules: CompanionRules = {
  // The More wrapper is a menu the overflow controller only fills: it moves
  // banked items in and sets their menu target attribute, but opening, closing,
  // roving and Escape all belong to the menu controller. Without it the trigger
  // is an inert button and every banked item — the ones that no longer fit, so
  // the only way to reach them — is unreachable by keyboard and pointer alike.
  "stimeo--overflow-menu": [
    {
      target: "more",
      controller: "stimeo--menu",
      suggestion:
        'Add data-controller="stimeo--menu" to the more target — the overflow controller banks items into it but never opens it.',
    },
  ],
};
