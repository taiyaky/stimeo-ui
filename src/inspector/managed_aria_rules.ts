import type { ManagedAriaRules } from "./types";

/**
 * Shared suggestion for the `aria-activedescendant` author-futile rule, reused
 * by every combobox-family controller (and the premium `multi-combobox`, which
 * imports this). The controller recomputes the attribute on open/navigation, so
 * the fix is always "remove it"; only the target name and the popup noun differ.
 */
export function removeActivedescendantSuggestion(target: string, popup = "listbox"): string {
  return `Remove aria-activedescendant from the ${target} target — the controller sets it while the ${popup} is open.`;
}

/**
 * Hand-written **author-futile attribute rules** (Inspector stage 3, schema
 * v4): ARIA that must NOT be authored because the controller owns it outright.
 *
 * This is the inverse of `a11y_rules.ts`, held to an even stricter bar. Most
 * controller-managed attributes are still legitimate to author as the
 * *pre-connect initial* (`aria-expanded="false"`, `aria-checked`,
 * `aria-valuenow`, `aria-sort="none"`, … — the demos themselves author them
 * for server-rendered truth), so warning on them would flag every correct
 * page. A rule lands here only when an authored value is meaningless in
 * every state:
 *
 * - `aria-activedescendant` is recomputed on every open/navigation and points
 *   at a hidden popup while closed — an authored value is dead weight that
 *   misleads readers of the markup.
 *
 * Violations are **warnings** (the page still works; the markup lies), so
 * they never affect the exit code.
 */
export const managedAriaRules: ManagedAriaRules = {
  "stimeo--combobox": [
    {
      target: "input",
      attrs: ["aria-activedescendant"],
      suggestion: removeActivedescendantSuggestion("input"),
    },
  ],
  "stimeo--listbox": [
    {
      target: "trigger",
      attrs: ["aria-activedescendant"],
      suggestion: removeActivedescendantSuggestion("trigger"),
    },
  ],
  "stimeo--multi-select": [
    {
      target: "input",
      attrs: ["aria-activedescendant"],
      suggestion: removeActivedescendantSuggestion("input"),
    },
  ],
  "stimeo--command-palette": [
    {
      target: "input",
      attrs: ["aria-activedescendant"],
      suggestion: removeActivedescendantSuggestion("input", "palette"),
    },
  ],
};
