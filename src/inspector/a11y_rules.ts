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
 * Like the structure rules, these are conservative: a requirement is listed
 * only when the pattern genuinely cannot be accessible without that ARIA, so
 * the check stays trustworthy rather than noisy. Concretely, a rule must
 * clear all of:
 *
 * 1. the controller never sets the attribute at runtime (else: excluded, e.g.
 *    tabs' `aria-selected`, switch's `role`/`aria-checked`, menu/listbox's
 *    `aria-expanded`/`aria-activedescendant`, separator's defaulted `role`);
 * 2. the documented markup contract and demo actually author it;
 * 3. the APG pattern is broken for AT without it — accessible-name rules are
 *    limited to roles that only name from author (dialog, menu, combobox,
 *    slider, spinbutton, meter, progressbar, separator-handle), never to plain
 *    inputs (a native `<label for>` is a legitimate alternative the static
 *    check cannot see) nor to optional names outside the documented contract;
 * 4. no legitimate alternative spelling exists (e.g. `<td>` inside a
 *    `role="grid"` table is an *implicit* gridcell, so cell roles on
 *    table-based grids are not required; a controller that documents an
 *    attribute as optional and falls back gracefully keeps it optional here).
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
  // Blocking confirm (the window.confirm replacement) is the alert-dialog
  // pattern: same authored role/aria-modal/name contract.
  "stimeo--confirm": [
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
      suggestion: "Name the confirm dialog via aria-labelledby (its title's id) or aria-label.",
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
  // Command palette: a modal dialog whose search field is an APG combobox over
  // a listbox of commands. The dialog trio matches the dialogs above; the
  // combobox roles are authored while the controller manages aria-expanded /
  // aria-activedescendant / aria-selected.
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
    {
      target: "input",
      attrs: ["role"],
      values: ["combobox"],
      suggestion: 'Add role="combobox" to the input target.',
    },
    {
      target: "input",
      attrs: ["aria-autocomplete"],
      values: ["list"],
      suggestion: 'Add aria-autocomplete="list" to the input target.',
    },
    {
      target: "list",
      attrs: ["role"],
      values: ["listbox"],
      suggestion: 'Add role="listbox" to the list target.',
    },
    {
      target: "option",
      attrs: ["role"],
      values: ["option"],
      suggestion: 'Add role="option" to each option target.',
    },
    {
      target: "option",
      attrs: ["id"],
      suggestion:
        "Add a unique id to each option target so aria-activedescendant can reference it.",
    },
  ],
  // Non-modal popover (APG dialog run modelessly): the panel's dialog role and
  // name are authored; deliberately NO aria-modal (the background stays
  // interactive — requiring it would break the pattern's contract).
  "stimeo--popover": [
    {
      target: "panel",
      attrs: ["role"],
      values: ["dialog"],
      suggestion: 'Add role="dialog" to the panel target.',
    },
    {
      target: "panel",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name the popover via aria-labelledby (its title's id) or aria-label.",
    },
  ],
  // Tooltip (APG): the controller only toggles visibility with show/hide
  // delays; the tooltip role and the trigger→tooltip description link are
  // authored (`role="tooltip"` is what makes aria-describedby resolve as the
  // trigger's description).
  "stimeo--tooltip": [
    {
      target: "content",
      attrs: ["role"],
      values: ["tooltip"],
      suggestion: 'Add role="tooltip" to the content target.',
    },
    {
      target: "trigger",
      attrs: ["aria-describedby"],
      suggestion:
        "Point the trigger at the tooltip via aria-describedby (the content target's id).",
    },
  ],
  // Menu button (APG menu): the controller manages aria-expanded and roving
  // focus, but the popup signal, menu name, and menu/menuitem roles are authored.
  // Item roles admit the checkbox/radio variants.
  "stimeo--menu": [
    {
      target: "trigger",
      attrs: ["aria-haspopup"],
      values: ["menu", "true"],
      suggestion: 'Add aria-haspopup="menu" to the trigger target.',
    },
    {
      target: "menu",
      attrs: ["role"],
      values: ["menu"],
      suggestion: 'Add role="menu" to the menu target.',
    },
    {
      target: "menu",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name the menu via aria-labelledby (the trigger's id) or aria-label.",
    },
    {
      target: "item",
      attrs: ["role"],
      values: ["menuitem", "menuitemcheckbox", "menuitemradio"],
      suggestion:
        'Add role="menuitem" (or "menuitemcheckbox" / "menuitemradio") to each item target.',
    },
  ],
  // Context menu: same menu/menuitem contract as stimeo--menu. No rule on the
  // right-click region — aria-haspopup there is a discoverability nicety, not
  // load-bearing.
  "stimeo--context-menu": [
    {
      target: "menu",
      attrs: ["role"],
      values: ["menu"],
      suggestion: 'Add role="menu" to the menu target.',
    },
    {
      target: "item",
      attrs: ["role"],
      values: ["menuitem", "menuitemcheckbox", "menuitemradio"],
      suggestion:
        'Add role="menuitem" (or "menuitemcheckbox" / "menuitemradio") to each item target.',
    },
  ],
  // Menubar (APG): the bar / top items / submenus / items carry authored
  // roles. aria-controls and aria-haspopup on top items are intentionally NOT
  // required: the controller resolves the pair via aria-controls but tolerates
  // top items without a submenu (plain commands), so requiring them would flag
  // valid markup.
  "stimeo--menubar": [
    {
      target: "",
      attrs: ["role"],
      values: ["menubar"],
      suggestion: 'Add role="menubar" to the controller element.',
    },
    {
      target: "top",
      attrs: ["role"],
      values: ["menuitem"],
      suggestion: 'Add role="menuitem" to each top target.',
    },
    {
      target: "menu",
      attrs: ["role"],
      values: ["menu"],
      suggestion: 'Add role="menu" to each menu target.',
    },
    {
      target: "item",
      attrs: ["role"],
      values: ["menuitem", "menuitemcheckbox", "menuitemradio"],
      suggestion:
        'Add role="menuitem" (or "menuitemcheckbox" / "menuitemradio") to each item target.',
    },
  ],
  // Select-only combobox (APG): the trigger IS the combobox — a role that only
  // names from author, so the name is required (the visible value alone would
  // otherwise be announced as the name). Expanded state / active option /
  // selection are controller-managed.
  "stimeo--listbox": [
    {
      target: "trigger",
      attrs: ["role"],
      values: ["combobox"],
      suggestion: 'Add role="combobox" to the trigger target.',
    },
    {
      target: "trigger",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name the trigger via aria-labelledby (label + value ids) or aria-label.",
    },
    {
      target: "list",
      attrs: ["role"],
      values: ["listbox"],
      suggestion: 'Add role="listbox" to the list target.',
    },
    {
      target: "option",
      attrs: ["role"],
      values: ["option"],
      suggestion: 'Add role="option" to each option target.',
    },
  ],
  // Editable combobox (APG): the input's combobox role and its list-filter
  // announcement are authored; no name rule — a native <label for> is a
  // legitimate alternative the static check cannot see.
  "stimeo--combobox": [
    {
      target: "input",
      attrs: ["role"],
      values: ["combobox"],
      suggestion: 'Add role="combobox" to the input target.',
    },
    {
      target: "input",
      attrs: ["aria-autocomplete"],
      values: ["list"],
      suggestion: 'Add aria-autocomplete="list" to the input target.',
    },
    {
      target: "list",
      attrs: ["role"],
      values: ["listbox"],
      suggestion: 'Add role="listbox" to the list target.',
    },
    {
      target: "option",
      attrs: ["role"],
      values: ["option"],
      suggestion: 'Add role="option" to each option target.',
    },
  ],
  // Multi-select combobox: the editable-combobox contract plus the authored
  // multi-selection signal on the listbox (the controller toggles
  // aria-selected per option but never declares the list multiselectable).
  "stimeo--multi-select": [
    {
      target: "input",
      attrs: ["role"],
      values: ["combobox"],
      suggestion: 'Add role="combobox" to the input target.',
    },
    {
      target: "input",
      attrs: ["aria-autocomplete"],
      values: ["list"],
      suggestion: 'Add aria-autocomplete="list" to the input target.',
    },
    {
      target: "list",
      attrs: ["role"],
      values: ["listbox"],
      suggestion: 'Add role="listbox" to the list target.',
    },
    {
      target: "list",
      attrs: ["aria-multiselectable"],
      values: ["true"],
      suggestion: 'Add aria-multiselectable="true" to the list target.',
    },
    {
      target: "option",
      attrs: ["role"],
      values: ["option"],
      suggestion: 'Add role="option" to each option target.',
    },
  ],
  // Tabs (APG): the controller manages aria-selected and roving tabindex, but
  // each role and the required tablist's accessible name are authored.
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
    {
      target: "list",
      attrs: ["role"],
      values: ["tablist"],
      suggestion: 'Add role="tablist" to the list target.',
    },
    {
      target: "list",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name the tablist via aria-labelledby or aria-label.",
    },
  ],
  // Tabbed carousel (APG): picker dots are tabs and slides are tabpanels with
  // the "slide" role description; the container announces itself as a
  // carousel and must therefore be named. Slide selection (aria-selected) is
  // controller-managed.
  "stimeo--carousel": [
    {
      target: "",
      attrs: ["aria-roledescription"],
      values: ["carousel"],
      suggestion: 'Add aria-roledescription="carousel" to the controller element.',
    },
    {
      target: "",
      attrs: ["aria-label", "aria-labelledby"],
      suggestion: "Name the carousel via aria-label or aria-labelledby.",
    },
    {
      target: "slide",
      attrs: ["role"],
      values: ["tabpanel"],
      suggestion: 'Add role="tabpanel" to each slide target.',
    },
    {
      target: "slide",
      attrs: ["aria-roledescription"],
      values: ["slide"],
      suggestion: 'Add aria-roledescription="slide" to each slide target.',
    },
    {
      target: "picker",
      attrs: ["role"],
      values: ["tab"],
      suggestion: 'Add role="tab" to each picker target.',
    },
  ],
  // Custom radio group (APG; documented for non-native radios only, so the
  // roles are always authored — native inputs neither need nor use this
  // controller). aria-checked is controller-managed.
  "stimeo--radio-group": [
    {
      target: "",
      attrs: ["role"],
      values: ["radiogroup"],
      suggestion: 'Add role="radiogroup" to the controller element.',
    },
    {
      target: "radio",
      attrs: ["role"],
      values: ["radio"],
      suggestion: 'Add role="radio" to each radio target.',
    },
  ],
  // Toolbar (APG): the controller provides the roving tabindex; the toolbar
  // role that makes the grouping perceivable is authored.
  "stimeo--toolbar": [
    {
      target: "",
      attrs: ["role"],
      values: ["toolbar"],
      suggestion: 'Add role="toolbar" to the controller element.',
    },
  ],
  // Tree view (APG): tree/treeitem/group roles are authored on a ul/li
  // structure whose implicit list semantics can never stand in for them;
  // aria-expanded / aria-selected are controller-managed.
  "stimeo--tree-view": [
    {
      target: "",
      attrs: ["role"],
      values: ["tree"],
      suggestion: 'Add role="tree" to the controller element.',
    },
    {
      target: "item",
      attrs: ["role"],
      values: ["treeitem"],
      suggestion: 'Add role="treeitem" to each item target.',
    },
    {
      target: "group",
      attrs: ["role"],
      values: ["group"],
      suggestion: 'Add role="group" to each group target.',
    },
  ],
  // Data grid (APG grid): only the grid role on the table is required — a
  // plain <table> never becomes a grid by itself, while row/columnheader/
  // gridcell are implicit on tr/th/td inside a grid table, so requiring them
  // explicitly would flag valid markup. aria-sort / aria-selected are
  // controller-managed.
  "stimeo--data-grid": [
    {
      target: "",
      attrs: ["role"],
      values: ["grid"],
      suggestion: 'Add role="grid" to the controller element.',
    },
  ],
  // Date range picker: unlike stimeo--calendar (table-based; grid role lives on
  // a non-target <table> and <td> cells are implicit gridcells), its documented
  // contract is div/button-based, so the grid and gridcell roles are explicit
  // and authored on the targets themselves. The grid's accessible name is NOT
  // required: the controller's minimal markup contract omits it (the demo's
  // aria-labelledby month link goes beyond the contract). aria-selected /
  // aria-disabled are controller-managed.
  "stimeo--date-range-picker": [
    {
      target: "grid",
      attrs: ["role"],
      values: ["grid"],
      suggestion: 'Add role="grid" to the grid target.',
    },
    {
      target: "cell",
      attrs: ["role"],
      values: ["gridcell"],
      suggestion: 'Add role="gridcell" to each cell target.',
    },
  ],
  // Value widgets (APG slider / window splitter / spinbutton / meter): the
  // controller keeps aria-valuenow (and friends) in sync; the widget role and
  // its accessible name are authored. All these roles name from author only,
  // so without a name AT announces a bare value with zero context.
  "stimeo--slider": [
    {
      target: "thumb",
      attrs: ["role"],
      values: ["slider"],
      suggestion: 'Add role="slider" to the thumb target.',
    },
    {
      target: "thumb",
      attrs: ["aria-label", "aria-labelledby"],
      suggestion: "Name the thumb via aria-label or aria-labelledby.",
    },
  ],
  "stimeo--range-slider": [
    {
      target: "startThumb",
      attrs: ["role"],
      values: ["slider"],
      suggestion: 'Add role="slider" to the startThumb target.',
    },
    {
      target: "startThumb",
      attrs: ["aria-label", "aria-labelledby"],
      suggestion: "Name the startThumb via aria-label or aria-labelledby.",
    },
    {
      target: "endThumb",
      attrs: ["role"],
      values: ["slider"],
      suggestion: 'Add role="slider" to the endThumb target.',
    },
    {
      target: "endThumb",
      attrs: ["aria-label", "aria-labelledby"],
      suggestion: "Name the endThumb via aria-label or aria-labelledby.",
    },
  ],
  // Color picker channels: each channel is an APG slider. aria-valuemin/max
  // are deliberately NOT required — the controller documents per-channel
  // fallbacks when they are omitted.
  "stimeo--color-picker": [
    {
      target: "slider",
      attrs: ["role"],
      values: ["slider"],
      suggestion: 'Add role="slider" to each slider target.',
    },
    {
      target: "slider",
      attrs: ["aria-label", "aria-labelledby"],
      suggestion: "Name each slider target via aria-label or aria-labelledby.",
    },
  ],
  // Time picker segments: each segment is an APG spinbutton. aria-valuemin/
  // max/now/text are controller-managed (they follow the 12/24-hour mode).
  "stimeo--time-picker": [
    {
      target: "segment",
      attrs: ["role"],
      values: ["spinbutton"],
      suggestion: 'Add role="spinbutton" to each segment target.',
    },
    {
      target: "segment",
      attrs: ["aria-label", "aria-labelledby"],
      suggestion: "Name each segment target via aria-label or aria-labelledby.",
    },
  ],
  "stimeo--meter": [
    {
      target: "",
      attrs: ["role"],
      values: ["meter"],
      suggestion: 'Add role="meter" to the controller element.',
    },
    {
      target: "",
      attrs: ["aria-label", "aria-labelledby"],
      suggestion: "Name the meter via aria-label or aria-labelledby.",
    },
  ],
  "stimeo--progress": [
    {
      target: "",
      attrs: ["role"],
      values: ["progressbar"],
      suggestion: 'Add role="progressbar" to the controller element.',
    },
    {
      target: "",
      attrs: ["aria-label", "aria-labelledby"],
      suggestion: "Name the progress bar via aria-label or aria-labelledby.",
    },
  ],
  // Password strength readout: the meter target is an ARIA meter the
  // controller feeds (aria-valuenow); its role and name are authored.
  "stimeo--password-strength": [
    {
      target: "meter",
      attrs: ["role"],
      values: ["meter"],
      suggestion: 'Add role="meter" to the meter target.',
    },
    {
      target: "meter",
      attrs: ["aria-label", "aria-labelledby"],
      suggestion: "Name the meter target via aria-label or aria-labelledby.",
    },
  ],
  // Window splitter (APG): the separator handle's role and name are authored;
  // aria-valuenow/min/max are controller-managed. (The standalone
  // stimeo--separator is intentionally absent: it defaults its own role.)
  "stimeo--resizable": [
    {
      target: "separator",
      attrs: ["role"],
      values: ["separator"],
      suggestion: 'Add role="separator" to the separator target.',
    },
    {
      target: "separator",
      attrs: ["aria-label", "aria-labelledby"],
      suggestion: "Name the separator target via aria-label or aria-labelledby.",
    },
  ],
  // Live-region contracts (`or` groups, schema v4): the announcement channel
  // can be spelled as a live role OR a bare aria-live region — either
  // satisfies the requirement, while a present-and-wrong value on either side
  // (e.g. aria-live="off") is still an error.
  "stimeo--sortable": [
    {
      target: "status",
      attrs: ["role"],
      values: ["status", "alert"],
      or: [{ attrs: ["aria-live"], values: ["polite", "assertive"] }],
      suggestion: 'Add role="status" (or aria-live="polite") to the status target.',
    },
  ],
  "stimeo--spinner": [
    {
      target: "indicator",
      attrs: ["role"],
      values: ["status", "alert"],
      or: [{ attrs: ["aria-live"], values: ["polite", "assertive"] }],
      suggestion: 'Add role="status" (or aria-live="polite") to the indicator target.',
    },
  ],
  // Opt-in cable controller: the "X is typing…" copy must reach AT (WCAG 4.1.3)
  // and the controller only writes textContent — the live-region semantics on
  // the (optional) status target are the author's to supply.
  "stimeo--typing-indicator": [
    {
      target: "status",
      attrs: ["role"],
      values: ["status", "alert"],
      or: [{ attrs: ["aria-live"], values: ["polite", "assertive"] }],
      suggestion: 'Add role="status" (or aria-live="polite") to the status target.',
    },
  ],
  "stimeo--form-field": [
    {
      target: "error",
      attrs: ["role"],
      values: ["alert", "status"],
      or: [{ attrs: ["aria-live"], values: ["assertive", "polite"] }],
      suggestion: 'Add role="alert" (or aria-live="assertive") to the error target.',
    },
  ],
};
