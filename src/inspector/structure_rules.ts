import type { StructureRules } from "./types";

/**
 * Hand-written **structure rules** (Inspector stage 2).
 *
 * Stimulus reflection (`static targets`) tells us which target *names* a
 * controller understands, but not which ones are structurally *required*. These
 * rules encode that knowledge: a target listed here must appear at least once
 * inside the controller's scope for the markup to be considered well-formed.
 *
 * Rules are intentionally conservative — only targets a controller genuinely
 * cannot function without are listed, so the check stays useful without being
 * noisy. Dynamically-generated targets (e.g. `toast` items rendered from a
 * `<template>`) are deliberately omitted.
 *
 * `data-action` controller and method validation is handled separately from the
 * reflected `static actions`; this table owns only target requiredness.
 */
export const structureRules: StructureRules = {
  "stimeo--accordion": { requiredTargets: ["trigger", "panel"] },
  "stimeo--alert-dialog": { requiredTargets: ["trigger", "dialog"] },
  // Opt-in positioning controller: both the reference and the positioned element
  // are structurally required (it positions `floating` against `anchor`).
  "stimeo--anchored": { requiredTargets: ["anchor", "floating"] },
  // No required targets: absent polite/assertive regions are generated at runtime.
  "stimeo--announcer": {},
  "stimeo--aspect-ratio": {},
  // No required targets: the controller element is the form unless `form` is given.
  "stimeo--auto-submit": {},
  "stimeo--avatar": { requiredTargets: ["image"] },
  "stimeo--breadcrumb": {
    requiredTargets: ["list"],
    // Collapsing is opt-in, but incomplete without its whole set: the items go
    // behind a disclosure, so a trail that marks `collapsible` and omits either
    // half of it hides them with no control that can bring them back. The
    // controller degrades safely (it simply never collapses), which is exactly
    // why the author gets no signal without this rule.
    conditionalTargets: [
      {
        whenPresent: "collapsible",
        require: ["ellipsis", "trigger"],
        suggestion:
          'Add the disclosure an author-marked "collapsible" needs: an "ellipsis" item and a "trigger" button inside it. Without both, the trail never collapses.',
      },
    ],
  },
  "stimeo--bulk-select": { requiredTargets: ["item", "bar"] },
  "stimeo--calendar": { requiredTargets: ["grid"] },
  "stimeo--carousel": { requiredTargets: ["slide", "picker"] },
  // No required targets: works on a bare <textarea>/<input> (no `input` target), and
  // the count display (`output`) is optional.
  "stimeo--character-counter": {},
  "stimeo--checkbox": { requiredTargets: ["parent"] },
  "stimeo--clipboard": { requiredTargets: ["button", "feedback"] },
  "stimeo--collapsible": { requiredTargets: ["trigger", "content"] },
  "stimeo--color-picker": { requiredTargets: ["slider"] },
  "stimeo--combobox": { requiredTargets: ["input", "list"] },
  "stimeo--command-palette": { requiredTargets: ["dialog", "input", "list"] },
  "stimeo--conditional-fields": { requiredTargets: ["trigger", "region"] },
  "stimeo--confirm": { requiredTargets: ["dialog"] },
  "stimeo--context-menu": { requiredTargets: ["region", "menu", "item"] },
  // No targets: the controller animates the authored text on its own element.
  "stimeo--count-up": {},
  // No required targets: every time slot and the completion status are optional.
  "stimeo--countdown": {},
  "stimeo--currency-input": { requiredTargets: ["display", "field"] },
  "stimeo--data-grid": { requiredTargets: ["columnHeader", "row", "cell"] },
  "stimeo--date-range-picker": { requiredTargets: ["grid", "cell"] },
  "stimeo--dialog": { requiredTargets: ["trigger", "dialog"] },
  "stimeo--direct-upload": { requiredTargets: ["list", "row"] },
  // No required targets: the controller element is the form; it declares no targets.
  "stimeo--dirty-form": {},
  "stimeo--dismissible": {},
  // `trigger` is intentionally not required: the `open` value can open the drawer
  // on connect with no trigger, so only `panel` is structurally required.
  "stimeo--drawer": { requiredTargets: ["panel"] },
  "stimeo--dropdown": { requiredTargets: ["trigger", "menu"] },
  "stimeo--editable": { requiredTargets: ["display", "input"] },
  // Only `list` is required (the collection being observed); `empty` is an
  // optional placeholder the controller guards individually (`hasEmptyTarget`).
  // Placeholder-style targets stay optional repo-wide (cf. `stimeo--filter` below),
  // so requiring `empty` here would reject valid CSS-driven (`data-empty`) markup.
  "stimeo--empty-state": { requiredTargets: ["list"] },
  "stimeo--file-dropzone": {
    requiredTargets: ["input", "trigger"],
    // The selected-file list is opt-in, and both halves are load-bearing: the
    // template supplies the item markup and the list is where it is appended.
    // With one of them the picker still works and the files are still submitted —
    // they just render nowhere, which reads to a user as a broken picker.
    conditionalTargets: [
      {
        whenPresent: "itemTemplate",
        require: ["list"],
        suggestion:
          'Add a "list" target for the rendered items — an "itemTemplate" with nowhere to append to renders nothing.',
      },
      {
        whenPresent: "list",
        require: ["itemTemplate"],
        suggestion:
          'Add an "itemTemplate" target — a "list" has no item markup to clone without it.',
      },
    ],
  },
  // Only `item` is required (the collection being filtered); `control`, `group`, and
  // `empty` are optional conveniences the controller guards individually.
  "stimeo--filter": { requiredTargets: ["item"] },
  // Only `region` is required; `message` targets may be absent (no flash to show).
  "stimeo--flash": { requiredTargets: ["region"] },
  // No required targets: `initial` is optional (defaults to the first focusable).
  "stimeo--focus": {},
  "stimeo--form-field": { requiredTargets: ["control"] },
  // No required targets: it validates the form's native controls and routes
  // messages through `stimeo--form-field` outlets, declaring no targets of its own.
  "stimeo--form-validation": {},
  // No required targets: content / skeleton / overlay are all optional; the frame
  // element drives the loading state from its own Turbo fetch events.
  "stimeo--frame-loading": {},
  // No targets: highlights the element itself, or (observe) its added children.
  "stimeo--highlight": {},
  "stimeo--hover-card": { requiredTargets: ["trigger", "card"] },
  // No targets: the controller element is the root and watches document-level activity.
  "stimeo--idle": {},
  // No required targets: the hidden `unmask` field is optional.
  "stimeo--input-mask": {},
  // No required targets: the controller observes its own element.
  "stimeo--intersection": {},
  // No targets: the controller element is the <turbo-frame> it lazy-loads.
  "stimeo--lazy-frame": {},
  "stimeo--listbox": { requiredTargets: ["trigger", "list", "option"] },
  // Opt-in cable controller. No required targets: without `value` the element
  // itself displays the count.
  "stimeo--live-counter": {},
  // No targets: formats the controller element (the <time>) itself from `datetime`.
  "stimeo--local-time": {},
  "stimeo--masonry": { requiredTargets: ["item"] },
  "stimeo--menu": { requiredTargets: ["trigger", "menu"] },
  // `item` is deliberately not required: a menu the consumer fills
  // asynchronously is supported markup, and requiring the target scope-wide
  // would reject the very markup the empty-menu `aria-busy` requirement accepts.
  // Emptiness is judged per menu by that rule instead, which is also the
  // sharper check — a scope-level presence test stays silent as soon as any one
  // menu has items.
  "stimeo--menubar": { requiredTargets: ["top", "menu"] },
  // No required targets: value/ARIA/state live on the controller element.
  "stimeo--meter": {},
  "stimeo--multi-select": { requiredTargets: ["input", "list", "tags"] },
  "stimeo--navigation-menu": { requiredTargets: ["trigger", "panel"] },
  "stimeo--nested-form": { requiredTargets: ["list", "template"] },
  // No required targets: offline and online announcement channels are optional.
  "stimeo--network-status": {},
  "stimeo--number-input": { requiredTargets: ["input"] },
  // No required targets: show/hide are both optional (the data-optimistic hook
  // and commit/rollback events work alone).
  "stimeo--optimistic": {},
  "stimeo--otp": { requiredTargets: ["field"] },
  "stimeo--overflow-indicator": { requiredTargets: ["viewport"] },
  "stimeo--overflow-menu": { requiredTargets: ["items", "more"] },
  // No required targets: a prev/next-only pager (no numbered page buttons) is a
  // supported configuration — the documented markup contract allows zero `page`
  // targets — so requiring `page` would reject valid markup. Boundary buttons
  // stay optional too (either one alone works).
  "stimeo--pagination": {},
  "stimeo--password-reveal": { requiredTargets: ["input", "toggle"] },
  // `label` is optional (the polite live-region readout); the input + meter are core.
  "stimeo--password-strength": { requiredTargets: ["input", "meter"] },
  // No required targets: `field` is optional (defaults to the form's named controls).
  "stimeo--persist": {},
  // No required targets: without a `handle`, the element itself is the drag handle.
  "stimeo--pointer-drag": {},
  "stimeo--popover": { requiredTargets: ["trigger", "panel"] },
  // No required targets: `content` is optional (defaults to the controller element).
  "stimeo--portal": {},
  // Opt-in cable controller. No required targets: the data-present hooks and the
  // join/leave/change events work without any roster rendering (count/list/template
  // are all optional presentation channels).
  "stimeo--presence": {},
  // No targets: guards the controller element itself based on the global preview state.
  "stimeo--preview-guard": {},
  // No required targets: value/ARIA/state live on the controller element.
  "stimeo--progress": {},
  "stimeo--radio-group": { requiredTargets: ["radio"] },
  "stimeo--range-slider": { requiredTargets: ["track", "startThumb", "endThumb"] },
  "stimeo--rating": { requiredTargets: ["symbol"] },
  // No targets: progress is measured and published from the controller element.
  "stimeo--reading-progress": {},
  "stimeo--read-more": { requiredTargets: ["content", "trigger"] },
  // No targets: the controller formats its own <time> element.
  "stimeo--relative-time": {},
  // No required targets: it scans for `data-reset-*` directives within scope.
  "stimeo--reset-before-cache": {},
  "stimeo--resizable": { requiredTargets: ["primary", "secondary", "separator"] },
  "stimeo--roving": { requiredTargets: ["item"] },
  "stimeo--scroll-area": { requiredTargets: ["viewport"] },
  // No targets: the controller persists its own scroll offsets.
  "stimeo--scroll-restore": {},
  "stimeo--scroll-visibility": { requiredTargets: ["element"] },
  "stimeo--scrollspy": { requiredTargets: ["link"] },
  "stimeo--separator": {},
  // Only `panel` is required; trigger and backdrop are optional guarded channels.
  "stimeo--sidebar": { requiredTargets: ["panel"] },
  // No required targets: placeholder and content are independently optional.
  "stimeo--skeleton": {},
  "stimeo--slider": { requiredTargets: ["track", "thumb"] },
  // No required targets: the controller element is the header itself.
  "stimeo--smart-sticky-header": {},
  // `list` and `status` are optional (element fallback / silent mode); the items are
  // what a reorderable list genuinely cannot exist without.
  "stimeo--sortable": { requiredTargets: ["item"] },
  // No required targets: indicator, region, and message are independently optional.
  "stimeo--spinner": {},
  "stimeo--step-indicator": { requiredTargets: ["step"] },
  "stimeo--stepper": { requiredTargets: ["step"] },
  // No required targets: `content` is optional (defaults to the scroll container).
  "stimeo--stick-to-bottom": {},
  "stimeo--sticky-observer": { requiredTargets: ["sentinel", "element"] },
  // No required targets: `submit` falls back to the form's native button[type=submit].
  "stimeo--submit-once": {},
  "stimeo--switch": {},
  "stimeo--tabs": { requiredTargets: ["tab", "panel", "list"] },
  "stimeo--tags-input": { requiredTargets: ["input", "tags"] },
  // No required targets: the controller element is the <textarea>; it declares no targets.
  "stimeo--textarea-autosize": {},
  // No required targets: the 2-value single-button contract has no `option` targets.
  "stimeo--theme": {},
  "stimeo--time-picker": { requiredTargets: ["segment", "field"] },
  "stimeo--toast": { requiredTargets: ["list"] },
  "stimeo--toggle-group": { requiredTargets: ["item"] },
  "stimeo--toolbar": { requiredTargets: ["control"] },
  "stimeo--tooltip": { requiredTargets: ["trigger", "content"] },
  // No targets: stages enter/leave classes on the controller element itself.
  "stimeo--transition": {},
  "stimeo--tree-view": { requiredTargets: ["item"] },
  // Opt-in cable controller. No required targets: the input listener is delegated
  // on the element (any descendant input works) and the status live region is optional.
  "stimeo--typing-indicator": {},
};
