import type { A11yRules } from "./types";

/**
 * Tags a form control's accessible name can reach through natively, via a
 * `<label for>`. A rule disarmed on these is not conceding the name is
 * optional — it is conceding that the label may sit in a different partial,
 * where no single-file check can see it.
 */
export const NATIVELY_LABELLED = ["input", "select", "textarea"];

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
 * the source, or every correct page would be flagged. A rule is listed only
 * where the controller does **not** `setAttribute` the listed ARIA and the
 * documented markup contract has the author supply it; attributes the
 * controller manages are intentionally absent.
 *
 * `aria-selected` is managed everywhere it appears: every selectable element
 * gets an explicit value on connect, whether the attribute marks the *active*
 * candidate or a committed choice. Its set-level half — "at most one `true` in
 * a single-select scope" — is an invariant no per-element requirement can
 * express, and lives in the cardinality rules instead.
 *
 * Like the structure rules, these are conservative: a requirement is listed
 * only when the pattern genuinely cannot be accessible without that ARIA, so
 * the check stays trustworthy rather than noisy. Concretely, a rule must
 * clear all of:
 *
 * 1. the controller never sets the attribute at runtime (else: excluded, e.g.
 *    tabs' `aria-selected`, switch's `role`/`aria-checked`, menu/listbox's
 *    `aria-expanded`/`aria-activedescendant`, separator's defaulted `role`);
 * 2. the documented markup contract and its example actually author it;
 * 3. the APG pattern is broken for AT without it. For **accessible names** this
 *    is not a yes/no question: ARIA assigns each role its own requirement level,
 *    so the rules mirror that level rather than a single house rule. Required
 *    (`dialog`, `alertdialog`, `tree`, `grid`, `radiogroup`, `listbox`,
 *    `combobox`, `tabpanel`, `slider`, `spinbutton`, `meter`, `progressbar`)
 *    reports as an **error**; Recommended (`menu`, `menubar`, `tablist`,
 *    `toolbar`) as a **warning**, because the pattern still works unnamed;
 *    discretionary names (a focusable `separator`) are checked only once the
 *    file holds enough of them to make the name load-bearing. Conditional
 *    levels are written as conditions, not rounded off: a toolbar's name
 *    escalates to Required on the second toolbar in the file;
 * 4. no legitimate alternative spelling exists (e.g. `<td>` inside a
 *    `role="grid"` table is an *implicit* gridcell, so cell roles on
 *    table-based grids are not required; a controller that documents an
 *    attribute as optional and falls back gracefully keeps it optional here).
 *    Where the alternative depends on the tag rather than the contract, the
 *    rule says so with `whenElement` instead of being dropped: a
 *    `<table role="grid">` names from its `<caption>` and a
 *    `<fieldset role="radiogroup">` from its `<legend>`, but the `div` spelling
 *    of either has no such path and goes unchecked if the rule is abandoned.
 *    The exemption is keyed on the tag, never on finding the native name — a
 *    `<label for>` legitimately sits in a different partial.
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
      target: "input",
      attrs: ["aria-labelledby", "aria-label"],
      whenElement: { exceptTags: NATIVELY_LABELLED },
      suggestion: "Name the combobox via aria-labelledby, aria-label, or a native <label for>.",
    },
    {
      target: "list",
      attrs: ["role"],
      values: ["listbox"],
      suggestion: 'Add role="listbox" to the list target.',
    },
    {
      target: "list",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name the listbox via aria-labelledby (the input's label) or aria-label.",
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
    // ARIA recommends (does not require) a name on `menu`: the pattern works
    // unnamed, the name only tells the user which trigger opened this one.
    {
      target: "menu",
      attrs: ["aria-labelledby", "aria-label"],
      severity: "warning",
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
    // Recommended, as on every other `menu`. A context menu has no visible
    // trigger to name it after, so `aria-label` is usually the only option.
    {
      target: "menu",
      attrs: ["aria-labelledby", "aria-label"],
      severity: "warning",
      suggestion: "Name the menu via aria-label (a context menu has no visible trigger).",
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
    // Recommended names, the same level `stimeo--menu`'s menu sits at. One
    // menubar owns several menus, so the name that distinguishes them matters
    // more, not less, than on a lone dropdown.
    {
      target: "",
      attrs: ["aria-labelledby", "aria-label"],
      severity: "warning",
      suggestion: "Name the menubar via aria-labelledby or aria-label.",
    },
    {
      target: "menu",
      attrs: ["aria-labelledby", "aria-label"],
      severity: "warning",
      suggestion: "Name each menu via aria-labelledby (its top item's id) or aria-label.",
    },
    // A menu the consumer fills asynchronously still opens, so an empty one is
    // supported markup — but `role="menu"` requires owned `menuitem`s, and the
    // controller cannot tell "still loading" from "nothing to show", so it never
    // infers the state. Declaring the temporary absence is therefore the
    // author's job, and only while the menu is structurally empty: a menu whose
    // items exist but are all inert is structurally satisfied and not busy.
    {
      target: "menu",
      whenContains: { target: "item", max: 0 },
      attrs: ["aria-busy"],
      values: ["true"],
      suggestion:
        'Add aria-busy="true" to the empty menu and drop it once the items land — role="menu" requires owned menuitems, and the controller never infers the state.',
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
    // ARIA requires a name on `listbox`. The popup is a div/ul by contract, so
    // there is no native `<select>` naming path to exempt here.
    {
      target: "list",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name the listbox via aria-labelledby (the trigger's label) or aria-label.",
    },
    {
      target: "option",
      attrs: ["role"],
      values: ["option"],
      suggestion: 'Add role="option" to each option target.',
    },
  ],
  // Free-input tags have no single APG composite role, but every generated
  // remove button still needs an author-localized accessible name. The
  // controller expands placeholders; it deliberately never invents prose.
  "stimeo--tags-input": [
    {
      target: "remove",
      attrs: ["aria-label"],
      suggestion:
        'Add a localized aria-label to the remove target (for example, aria-label="Remove {label}").',
    },
  ],
  // Editable combobox (APG): the input's combobox role and its list-filter
  // announcement are authored. ARIA requires a name on both `combobox` and
  // `listbox`, but the input's is disarmed on the native tags — an
  // `<input role="combobox">` is named by a `<label for>` that legitimately
  // lives in another partial, so demanding ARIA there would flag correct pages.
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
      target: "input",
      attrs: ["aria-labelledby", "aria-label"],
      whenElement: { exceptTags: NATIVELY_LABELLED },
      suggestion: "Name the combobox via aria-labelledby, aria-label, or a native <label for>.",
    },
    {
      target: "list",
      attrs: ["role"],
      values: ["listbox"],
      suggestion: 'Add role="listbox" to the list target.',
    },
    {
      target: "list",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name the listbox via aria-labelledby (the input's label) or aria-label.",
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
      target: "input",
      attrs: ["aria-labelledby", "aria-label"],
      whenElement: { exceptTags: NATIVELY_LABELLED },
      suggestion: "Name the combobox via aria-labelledby, aria-label, or a native <label for>.",
    },
    {
      target: "list",
      attrs: ["role"],
      values: ["listbox"],
      suggestion: 'Add role="listbox" to the list target.',
    },
    {
      target: "list",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name the listbox via aria-labelledby (the input's label) or aria-label.",
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
    {
      target: "remove",
      attrs: ["aria-label"],
      suggestion:
        'Add a localized aria-label to the remove target (for example, aria-label="Remove {label}").',
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
    // Recommended, not required: an unnamed tablist is still a working tab set.
    {
      target: "list",
      attrs: ["aria-labelledby", "aria-label"],
      severity: "warning",
      suggestion: "Name the tablist via aria-labelledby or aria-label.",
    },
    // The panel, by contrast, ARIA *requires* a name for — and the contract
    // already has the author point it at the controlling tab, so nothing here
    // is new to write. The controller never sets it (it owns aria-selected
    // only), which is what makes the requirement checkable at all.
    {
      target: "panel",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name each panel via aria-labelledby (its tab's id) or aria-label.",
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
    // A slide is a `tabpanel`, whose name ARIA requires. Unnamed, every slide
    // is announced as "slide" and the position the roledescription promised is
    // exactly the thing the user cannot hear.
    {
      target: "slide",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name each slide via aria-labelledby (its picker's id) or aria-label.",
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
    // ARIA requires a name on `radiogroup` — without it the individual radios
    // are announced with no idea what they are choosing between. Disarmed on
    // `<fieldset>`, which names the group from its `<legend>`; the `div`
    // spelling the contract documents has no such path.
    {
      target: "",
      attrs: ["aria-labelledby", "aria-label"],
      whenElement: { exceptTags: ["fieldset"] },
      suggestion: "Name the radio group via aria-labelledby or aria-label.",
    },
  ],
  // Toggle buttons expose their state through controller-managed aria-pressed.
  // The group role and generic-host button roles remain authored: a native
  // button supplies its own implicit role, while a generic host does not.
  "stimeo--toggle-group": [
    {
      target: "",
      attrs: ["role"],
      values: ["group"],
      suggestion: 'Add role="group" to the controller element.',
    },
    {
      target: "item",
      attrs: ["role"],
      values: ["button"],
      whenElement: { exceptTags: ["button"] },
      suggestion: 'Add role="button" to each non-button item target.',
    },
    // The role itself remains usable unnamed, so this contextual label is a
    // warning. A fieldset can obtain the same name from its native legend.
    {
      target: "",
      attrs: ["aria-labelledby", "aria-label"],
      whenElement: { exceptTags: ["fieldset"] },
      severity: "warning",
      suggestion: "Name the toggle group via aria-labelledby or aria-label.",
    },
  ],
  // Toolbar (APG): the controller provides the roving tabindex; the toolbar
  // role that makes the grouping perceivable is authored, and so is the
  // orientation — the controller reads its own Value to decide which arrow keys
  // move focus, but never writes `aria-orientation`, so a vertical toolbar is
  // announced as horizontal unless the author says otherwise. The requirement
  // holds *only* in the vertical configuration: `horizontal` is the implicit
  // ARIA default, so demanding the attribute unconditionally would reject the
  // correct markup of every horizontal toolbar.
  "stimeo--toolbar": [
    {
      target: "",
      attrs: ["role"],
      values: ["toolbar"],
      suggestion: 'Add role="toolbar" to the controller element.',
    },
    {
      target: "",
      when: { value: "orientation", equals: ["vertical"], default: "horizontal" },
      attrs: ["aria-orientation"],
      values: ["vertical"],
      suggestion:
        'Add aria-orientation="vertical" to the controller element — the toolbar roves with Up/Down but is announced as horizontal without it.',
    },
    // ARIA recommends a toolbar's name and *requires* it once a page holds more
    // than one — with two, "toolbar" alone identifies neither. The count is per
    // file, which under-approximates a page assembled from partials: that only
    // ever leaves the level at warning, never raises it wrongly.
    {
      target: "",
      attrs: ["aria-labelledby", "aria-label"],
      severity: "warning",
      escalateWhen: { role: "toolbar", atLeast: 2 },
      suggestion: "Name the toolbar via aria-labelledby or aria-label.",
    },
  ],
  // Tree view (APG): tree/treeitem/group roles are authored on a ul/li
  // structure whose implicit list semantics can never stand in for them;
  // aria-expanded is controller-managed; aria-selected is shared — the author may
  // render the initial selection and connect normalizes it, so it is not required.
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
    // ARIA requires a name on `tree`. There is no native spelling of a tree to
    // exempt — a `<ul>` carrying role="tree" has lost the list semantics it
    // might otherwise have been named through — so the requirement is
    // unconditional.
    {
      target: "",
      attrs: ["aria-labelledby", "aria-label"],
      suggestion: "Name the tree via aria-labelledby or aria-label.",
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
    // ARIA requires a name on `grid`. Disarmed on `<table>`, which names itself
    // from a `<caption>` — the contract's own example is table-based, so an
    // unconditional rule would reject the documented spelling. The `div` form
    // has no caption to fall back on and stays checked.
    {
      target: "",
      attrs: ["aria-labelledby", "aria-label"],
      whenElement: { exceptTags: ["table"] },
      suggestion: "Name the grid via aria-labelledby or aria-label.",
    },
  ],
  // Date range picker: unlike stimeo--calendar (table-based; grid role lives on
  // a non-target <table> and <td> cells are implicit gridcells), its documented
  // contract is div/button-based, so the grid and gridcell roles are explicit
  // and authored on the targets themselves — and with no `<table>` in sight
  // there is no `<caption>` to name the grid either, so ARIA's required name
  // has to be authored. aria-selected and aria-disabled are both
  // controller-managed: unavailable dates arrive as the `disabled-dates` Value,
  // not as markup, because the 42 cells are recycled across months.
  "stimeo--date-range-picker": [
    {
      target: "grid",
      attrs: ["role"],
      values: ["grid"],
      suggestion: 'Add role="grid" to the grid target.',
    },
    {
      target: "grid",
      attrs: ["aria-labelledby", "aria-label"],
      whenElement: { exceptTags: ["table"] },
      suggestion: "Name the grid via aria-labelledby (the month heading) or aria-label.",
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
    // ARIA leaves a focusable separator's name discretionary and only
    // recommends one "if more than one focusable separator" exists — a single
    // splitter is unambiguous, and naming it would add an announcement the user
    // gains nothing from. So the rule arms on the second one in the file rather
    // than standing unconditionally, and reports at the recommended level.
    //
    // `focusable` is load-bearing, not decoration: a decorative
    // `hr role="separator"` is not something a user can land on, so it cannot
    // create the ambiguity the name resolves. Counting it would warn about a
    // page that has exactly one reachable splitter.
    {
      target: "separator",
      attrs: ["aria-label", "aria-labelledby"],
      whenDocument: { role: "separator", atLeast: 2, focusable: true },
      severity: "warning",
      suggestion:
        "Name each separator target via aria-label or aria-labelledby — this file has more than one focusable separator.",
    },
  ],
  // Live-region contracts (`or` groups): the announcement channel can be
  // spelled as a live role OR a bare aria-live region — either satisfies the
  // requirement, while a present-and-wrong value on either side (e.g.
  // aria-live="off") is still an error.
  "stimeo--sortable": [
    {
      target: "status",
      attrs: ["role"],
      values: ["status", "alert"],
      or: [{ attrs: ["aria-live"], values: ["polite", "assertive"] }],
      suggestion: 'Add role="status" (or aria-live="polite") to the status target.',
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
