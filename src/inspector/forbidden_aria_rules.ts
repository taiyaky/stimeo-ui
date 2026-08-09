import type { ForbiddenAriaRules } from "./types";

/**
 * Hand-written **forbidden-attribute rules** (Inspector stage 3).
 *
 * The inverse of `a11y_rules.ts`, and not to be confused with
 * `managed_aria_rules.ts`. All three talk about an attribute the author might
 * write; what separates them is *why* it should not be there:
 *
 * - required and missing → an accessibility requirement,
 * - futile in every state because the controller recomputes it → author-futile,
 * - **legitimately the author's, required in the other configuration, and
 *   contradicted by the surrounding markup here** → this file.
 *
 * These are **warnings**. A static reader sees one file at one instant and
 * cannot separate a stale declaration from a genuine in-progress one, so the
 * bar for an error — "this is wrong in every rendering" — is not met. The rules
 * still earn their place: the markup says something untrue about itself, and
 * nothing at runtime will ever correct it.
 */
export const forbiddenAriaRules: ForbiddenAriaRules = {
  // The mirror of the menubar's empty-menu requirement. `aria-busy` on a menu
  // declares the temporary absence of the `menuitem`s `role="menu"` requires;
  // once they are in the markup the declaration has nothing left to describe,
  // and a screen reader is told the menu is still updating while its items sit
  // right there. Left as a warning because a menu filled a chunk at a time is
  // correctly busy *with* items present — a distinction one file cannot make.
  "stimeo--menubar": [
    {
      target: "menu",
      attrs: ["aria-busy"],
      values: ["true"],
      whenContains: { target: "item", min: 1 },
      suggestion:
        "Drop aria-busy from the menu now that its items are in the markup — it only declares the temporary absence of the menuitems the role requires.",
    },
  ],
};
