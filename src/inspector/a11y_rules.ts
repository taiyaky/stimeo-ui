import type { A11yRules } from "./types";

/**
 * Hand-written **accessibility rules** (Inspector stage 3).
 *
 * Stage 1/2 check that markup is spelled and structured correctly; stage 3
 * checks that the markup is *accessible*. The rules below encode the ARIA the
 * **author** must supply — the attributes a controller relies on but does
 * **not** set itself at runtime.
 *
 * The distinction is deliberate and load-bearing: a controller that assigns,
 * say, `aria-selected` on connect must never have that attribute *required* in
 * the source, or every correct page would be flagged. Each rule here was
 * verified against the controller implementation (it does **not** `setAttribute`
 * the listed ARIA) and the recommended demo markup (the author **does** author
 * it). Attributes the controller manages are intentionally absent.
 *
 * Like the structure rules, these are conservative: only the ARIA a pattern
 * genuinely cannot be accessible without is listed, so the check stays
 * trustworthy rather than noisy. Roles/attributes a controller sets at runtime
 * (e.g. tabs' `aria-selected`, switch's `role`/`aria-checked`, menu/listbox's
 * `aria-expanded`/`aria-activedescendant`) are excluded by design.
 *
 * Each requirement carries a `suggestion` used by stage 4 to print the exact
 * attribute to add.
 */
export const a11yRules: A11yRules = {
  // Modal dialogs: the controller provides focus trap / Esc / scroll lock but
  // sets no ARIA — `role`, `aria-modal` and the accessible name are authored.
  "stimeo--dialog": [
    {
      target: "dialog",
      attrs: ["role"],
      values: ["dialog"],
      suggestion: 'Add role="dialog" to the dialog target.',
    },
    {
      target: "dialog",
      attrs: ["aria-modal"],
      values: ["true"],
      suggestion: 'Add aria-modal="true" to the dialog target.',
    },
    {
      target: "dialog",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name the dialog via aria-labelledby (its title's id) or aria-label.",
    },
  ],
  "stimeo--alert-dialog": [
    {
      target: "dialog",
      attrs: ["role"],
      values: ["alertdialog"],
      suggestion: 'Add role="alertdialog" to the dialog target.',
    },
    {
      target: "dialog",
      attrs: ["aria-modal"],
      values: ["true"],
      suggestion: 'Add aria-modal="true" to the dialog target.',
    },
    {
      target: "dialog",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name the alert dialog via aria-labelledby (its title's id) or aria-label.",
    },
  ],
  "stimeo--drawer": [
    {
      target: "panel",
      attrs: ["role"],
      values: ["dialog"],
      suggestion: 'Add role="dialog" to the panel target.',
    },
    {
      target: "panel",
      attrs: ["aria-modal"],
      values: ["true"],
      suggestion: 'Add aria-modal="true" to the panel target.',
    },
    {
      target: "panel",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name the drawer via aria-labelledby (its title's id) or aria-label.",
    },
  ],
  "stimeo--command-palette": [
    {
      target: "dialog",
      attrs: ["role"],
      values: ["dialog"],
      suggestion: 'Add role="dialog" to the dialog target.',
    },
    {
      target: "dialog",
      attrs: ["aria-modal"],
      values: ["true"],
      suggestion: 'Add aria-modal="true" to the dialog target.',
    },
    {
      target: "dialog",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name the command palette via aria-labelledby or aria-label.",
    },
  ],
  // Tabs (APG): the controller manages aria-selected and roving tabindex, but
  // the role of each tab and panel is authored.
  "stimeo--tabs": [
    {
      target: "tab",
      attrs: ["role"],
      values: ["tab"],
      suggestion: 'Add role="tab" to each tab target.',
    },
    {
      target: "panel",
      attrs: ["role"],
      values: ["tabpanel"],
      suggestion: 'Add role="tabpanel" to each panel target.',
    },
  ],
};
