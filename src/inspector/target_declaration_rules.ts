import type { TargetDeclarationRules } from "./types";

/**
 * Hand-written **reverse-direction target rules** (Inspector stage 3).
 *
 * Every other rule family reads *target → required attribute*, so it can only
 * ever judge markup the controller already knows about. These read the other
 * way: *attribute → required target*. They exist for the failure that direction
 * makes invisible — an element that carries the pattern's role, and is
 * therefore announced as part of the widget, but was never declared as a
 * target. It is absent from the controller's target set, so roving, visible-item
 * search, typeahead and selection sync all skip it, while every forward rule
 * reports nothing because there is no target to check.
 *
 * The bar for a rule here is that the role alone is *sufficient* evidence of
 * intent: a role that only ever appears inside this pattern, on an element the
 * controller must drive. Roles an author might legitimately use for
 * presentation inside the scope do not qualify.
 */
export const targetDeclarationRules: TargetDeclarationRules = {
  // A tree's arrow keys, typeahead and selection all walk the item target set.
  // A `role="treeitem"` outside it is announced as a node of the tree and can
  // even receive focus through the DOM-parent fallback, yet no key press moves
  // off it: the controller cannot find the current item among its visible
  // targets, so the move is computed from nothing and silently does not happen.
  "stimeo--tree-view": [
    {
      attr: "role",
      values: ["treeitem"],
      target: "item",
      suggestion:
        'Add data-stimeo--tree-view-target="item" to the treeitem — the controller only moves focus, expands and selects within its item targets.',
    },
  ],
};
