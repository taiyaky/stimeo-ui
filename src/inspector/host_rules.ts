import type { HostRules } from "./types";

/**
 * Hand-written **host-element contracts** (Inspector stage 3).
 *
 * These rules cover an interaction boundary that ARIA and focusability checks
 * cannot express: a controller may require a generic host because placing its
 * behavior on another native interactive element creates two activation
 * models on one node. The checker admits only host shapes the runtime can own
 * unambiguously and stays silent when an ERB-generated attribute makes the
 * answer unknowable.
 */
export const hostRules: HostRules = {
  // A native button supplies click synthesis for Space/Enter, which the switch
  // deliberately leaves to the browser. It must be a non-submitting button;
  // every other supported spelling is a generic host whose activation belongs
  // entirely to the controller.
  "stimeo--switch": [
    {
      target: "",
      mode: "non-interactive-or-button",
      buttonTypes: ["button"],
      suggestion:
        'Use <button type="button">, or move stimeo--switch to a non-interactive host such as <div>.',
    },
  ],

  // Tree-view owns selection, expansion, and the roving key map on every item.
  // Nest a link or button inside the item when it needs a secondary action;
  // making that control the treeitem itself combines incompatible interactions.
  "stimeo--tree-view": [
    {
      target: "item",
      mode: "non-interactive",
      suggestion:
        'Place the "item" target on a non-interactive element such as <li> or <div>; put links and buttons inside it.',
    },
  ],
};
