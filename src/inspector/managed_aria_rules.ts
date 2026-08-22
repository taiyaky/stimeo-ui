import type { ManagedAriaRules } from "./types";

/**
 * Shared suggestion for the `aria-activedescendant` author-futile rule, reused
 * by every combobox-family controller that imports this. The controller
 * recomputes the attribute on open/navigation, so the fix is always
 * "remove it"; only the target name and the popup noun differ.
 */
export function removeActivedescendantSuggestion(target: string, popup = "listbox"): string {
  return `Remove aria-activedescendant from the ${target} target — the controller sets it while the ${popup} is open.`;
}

/**
 * Hand-written **author-futile attribute rules** (Inspector stage 3): ARIA that
 * must NOT be authored because the controller owns it outright.
 *
 * This is the inverse of `a11y_rules.ts`, held to an even stricter bar. Most
 * controller-managed attributes are still legitimate to author as the
 * *pre-connect initial* (`aria-expanded="false"`, `aria-checked`,
 * `aria-valuenow`, `aria-sort="none"`, … — the shipped examples author them
 * for server-rendered truth), so warning on them would flag every correct
 * page. A rule lands here only when an authored value is meaningless in
 * every state:
 *
 * - `aria-activedescendant` is recomputed on every open/navigation and points
 *   at a hidden popup while closed — an authored value is dead weight that
 *   misleads readers of the markup.
 * - `aria-selected` on an option, **only where it marks the active candidate
 *   rather than a committed choice**. Ownership splits by that meaning: where
 *   the committed value lives outside the popup (an editable input's `value`)
 *   or nothing is ever committed (a command run), the controller overwrites any
 *   authored value on connect, so authoring one is futile. Where the committed
 *   value lives *inside* the popup (`listbox`, `multi-select`, `tree-view`,
 *   `tabs`, …) an authored value is the server-rendered initial selection and
 *   is deliberately NOT listed here.
 *
 * Violations are **warnings** (the page still works; the markup lies), so
 * they never affect the exit code.
 */
export const managedAriaRules: ManagedAriaRules = {
  // The carousel derives every one of these from state it already owns — the
  // rotation intent lives in the `autoplay` Value, and reachability follows from
  // `loop` and the slide count — so each is recomputed on connect and on every
  // move. None of them has a server-rendered initial an author could get right.
  "stimeo--carousel": [
    {
      target: "playToggle",
      attrs: ["aria-pressed"],
      suggestion:
        "Remove aria-pressed from the playToggle target — the controller mirrors the autoplay Value onto it. Set data-stimeo--carousel-autoplay-value to choose the initial state.",
    },
    {
      target: "playToggle",
      attrs: ["aria-disabled"],
      suggestion:
        "Remove aria-disabled from the playToggle target — the controller marks it when the carousel has no slide left to rotate to.",
    },
    {
      target: "prev",
      attrs: ["aria-disabled"],
      suggestion:
        "Remove aria-disabled from the prev target — the controller marks it at the first slide of a non-looping carousel.",
    },
    {
      target: "next",
      attrs: ["aria-disabled"],
      suggestion:
        "Remove aria-disabled from the next target — the controller marks it at the last slide of a non-looping carousel.",
    },
    {
      target: "viewport",
      attrs: ["aria-live", "aria-atomic"],
      suggestion:
        "Remove aria-live and aria-atomic from the viewport target — the controller switches the region between off while rotating and polite while stopped.",
    },
  ],
  "stimeo--combobox": [
    {
      target: "input",
      attrs: ["aria-activedescendant"],
      suggestion: removeActivedescendantSuggestion("input"),
    },
    {
      target: "option",
      attrs: ["aria-selected"],
      suggestion:
        "Remove aria-selected from the option target — here it marks the active candidate, which the controller overwrites on connect. The committed value lives in the input.",
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
    {
      target: "option",
      attrs: ["aria-selected"],
      suggestion:
        "Remove aria-selected from the option target — here it marks the active candidate, which the controller overwrites on connect. A palette runs a command and keeps nothing selected.",
    },
  ],
  // The passcode fields' invalid state is derived from input the controller
  // itself rejected, and it lends the two attributes only while reporting one.
  // An authored value is dropped the first time anything is typed.
  "stimeo--otp": [
    {
      target: "field",
      attrs: ["aria-invalid", "aria-errormessage"],
      suggestion:
        "Remove aria-invalid and aria-errormessage from the field target — the controller writes them while it reports discarded input and returns them once the input is accepted.",
    },
  ],
};
