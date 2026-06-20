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
 * @remarks Method-name checks for `data-action` are out of scope for the
 * minimal version; only the controller identifier is validated.
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
  "stimeo--breadcrumb": { requiredTargets: ["list"] },
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
  "stimeo--file-dropzone": { requiredTargets: ["input", "trigger"] },
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
  // No targets: the controller element is the <turbo-frame> it lazy-loads.
  "stimeo--lazy-frame": {},
  "stimeo--listbox": { requiredTargets: ["trigger", "list", "option"] },
  // No targets: formats the controller element (the <time>) itself from `datetime`.
  "stimeo--local-time": {},
  "stimeo--masonry": { requiredTargets: ["item"] },
  "stimeo--menu": { requiredTargets: ["trigger", "menu"] },
  "stimeo--menubar": { requiredTargets: ["top", "menu", "item"] },
  "stimeo--multi-select": { requiredTargets: ["input", "list", "tags"] },
  "stimeo--navigation-menu": { requiredTargets: ["trigger", "panel"] },
  "stimeo--nested-form": { requiredTargets: ["list", "template"] },
  "stimeo--number-input": { requiredTargets: ["input"] },
  "stimeo--otp": { requiredTargets: ["field"] },
  "stimeo--overflow-indicator": { requiredTargets: ["viewport"] },
  "stimeo--overflow-menu": { requiredTargets: ["items", "more"] },
  "stimeo--pagination": { requiredTargets: ["page"] },
  "stimeo--password-reveal": { requiredTargets: ["input", "toggle"] },
  // `label` is optional (the polite live-region readout); the input + meter are core.
  "stimeo--password-strength": { requiredTargets: ["input", "meter"] },
  // No required targets: `field` is optional (defaults to the form's named controls).
  "stimeo--persist": {},
  "stimeo--popover": { requiredTargets: ["trigger", "panel"] },
  // No required targets: `content` is optional (defaults to the controller element).
  "stimeo--portal": {},
  // No targets: guards the controller element itself based on the global preview state.
  "stimeo--preview-guard": {},
  "stimeo--radio-group": { requiredTargets: ["radio"] },
  "stimeo--range-slider": { requiredTargets: ["track", "startThumb", "endThumb"] },
  "stimeo--rating": { requiredTargets: ["symbol"] },
  "stimeo--read-more": { requiredTargets: ["content", "trigger"] },
  // No required targets: it scans for `data-reset-*` directives within scope.
  "stimeo--reset-before-cache": {},
  "stimeo--resizable": { requiredTargets: ["primary", "secondary", "separator"] },
  "stimeo--roving": { requiredTargets: ["item"] },
  "stimeo--scroll-area": { requiredTargets: ["viewport"] },
  "stimeo--scroll-visibility": { requiredTargets: ["element"] },
  "stimeo--scrollspy": { requiredTargets: ["link"] },
  "stimeo--separator": {},
  "stimeo--slider": { requiredTargets: ["track", "thumb"] },
  "stimeo--step-indicator": { requiredTargets: ["step"] },
  "stimeo--stepper": { requiredTargets: ["step"] },
  // No required targets: `content` is optional (defaults to the scroll container).
  "stimeo--stick-to-bottom": {},
  "stimeo--sticky-observer": { requiredTargets: ["sentinel", "element"] },
  // No required targets: `submit` falls back to the form's native button[type=submit].
  "stimeo--submit-once": {},
  "stimeo--switch": {},
  "stimeo--tabs": { requiredTargets: ["tab", "panel"] },
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
};
