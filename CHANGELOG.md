# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, the public API (the `stimeo--*` data attributes) may
change between releases.

## [0.3.0] - 2026-08-09

Minor release focused on consistent keyboard and selection behavior, resilient
runtime DOM changes, and substantially stronger Inspector diagnostics. No
controller, target, value, action, event, or package export was removed. The
Inspector manifest advances from schema v5 to v8, so tools that read the raw
manifest must accept the new schema and fields.

### Upgrade notes

- Run `stimeo check` against existing views before deploying. New structural
  checks can report errors for incomplete optional target groups, missing
  companion controllers, undeclared role-bearing targets, and invalid
  cardinality. New ARIA checks can also add warnings without failing the command.
- In RTL containers, horizontal arrow keys now follow logical inline direction
  across composite widgets. LTR behavior is unchanged.
- Slider, range-slider, and color-picker pointer/arrow mirroring remains opt-in:
  set their new `logicalTrack` value only when the consuming CSS mirrors the
  track in RTL.
- calendar's `stimeo--calendar:monthchange` no longer fires while the grid
  settles on its initial month, so code that ran from that first event must now
  run once at initialization. Listeners that re-apply per-date `aria-disabled`
  marks are the common case.

### Added

- breadcrumb: a public `update` action for reconciling collapsible state after
  application-driven DOM changes.
- tree-view: a public `toggle` action for explicitly expanding or collapsing an
  item from application markup.
- scrollspy: a `focusSection` value for opting into focus movement when a link
  activates a section.
- slider, range-slider, color-picker: the `logicalTrack` value described above.
- Inspector schema v6-v8: conditional target requirements and the new
  `missing-companion`, `undeclared-target`, `cardinality-violation`,
  `forbidden-aria`, and `missing-conditional-target` diagnostics. Rules can now
  depend on controller values, element/document conditions, contained targets,
  and ARIA requirement severity.

### Changed

- accordion, carousel, calendar, combobox, command-palette, context-menu,
  data-grid, date-range-picker, listbox, menu, menubar, multi-select,
  navigation-menu, OTP, radio-group, roving, tabs, tags-input, time-picker,
  toggle-group, toolbar, tree-view, and related horizontal controls now resolve
  Left/Right behavior from the effective text direction. Sortable geometry also
  follows logical inline direction.
- Arrow-key handlers yield modified browser shortcuts, and composite handlers
  yield events already consumed by a nested widget. IME composition continues to
  take precedence over component shortcuts.
- Selection widgets normalize controller-owned `aria-selected` state, preserve a
  single active/selected item where the pattern requires one, and reconcile that
  state when options are inserted, removed, or replaced at runtime.
- menu and overflow-menu delegate item interaction from their containers, so
  dynamically added items work without per-item actions. Existing action markup
  remains compatible.
- `aria-disabled="true"` items remain discoverable by composite keyboard
  navigation while activation, expansion, and consumer actions are suppressed.
- Outside pointer listeners for dismissible composites — click and context-menu
  alike — run in the capture phase so nested application code cannot leave an
  open layer stuck by stopping bubbling.
- Inspector accessible-name diagnostics now follow ARIA's Required, Recommended,
  and conditional levels instead of treating every role alike.

### Fixed

- combobox, command-palette, listbox, and multi-select no longer retain stale
  active IDs, selection, chips, or hidden fields after Turbo morphs and runtime
  target replacement. A disconnect/reconnect in the same task can no longer let
  an old reconciliation microtask consume the fresh generation's pass.
- breadcrumb fails open when its optional disclosure targets are incomplete and
  restores items that leave the collapsible set instead of leaving them hidden.
- menu, menubar, navigation-menu, overflow-menu, pagination, and tree-view now
  recover focus consistently across empty lists, disabled fieldsets, hidden
  ancestors, item banking, and runtime item removal.
- toolbar restores its single tab stop when an enclosing `<fieldset>` is
  re-enabled, so unlocking a form brings the group back into the Tab sequence.
- multi-select keeps chip focus when the selection was made in an order other
  than the option order. The chips are reconciled against the selected value set
  rather than position by position, and their labels are paired by value.
- overflow-menu measures items adopted from server-rendered overflow in the bar
  rather than inside the closed menu, so an already-overflowed bar no longer
  returns every item to the bar on first paint.
- combobox commits a clicked option after its input target is removed instead of
  throwing, matching the tolerance the popup already had for that state.
- color-picker falls back to the per-channel range when a slider omits
  `aria-valuemin` / `aria-valuemax`, instead of pinning the channel at zero.
- calendar maintains exactly one roving tab stop while selection and available
  days change.
- calendar reports `monthchange` from the month it paints, so a malformed
  `month` value can no longer put a raw non-`YYYY-MM` string in `detail.month`.
  The report is driven by the repaint rather than by the `month` value, so a
  fallback month moved by `selected` or by selecting a neighbouring month's cell
  is announced as it happens instead of arriving on a later repaint. Re-applying
  the same month, as a Turbo cache restore does, stays silent.
- scrollspy re-evaluates links and sections after every supported entry path;
  intersection-based controllers align fallback thresholds, hidden-layout
  handling, and reduced-motion behavior.
- `stimeo catalog --json` and large `stimeo check --json` reports are no longer
  truncated when stdout is piped; the CLI now lets buffered output flush before
  exiting, and the build audit exercises the real piped catalog.

## [0.2.1] - 2026-07-26

Patch release from a review of the disclosure and layout components, plus a
packaging fix. No breaking changes, but `stimeo check` now reports two markup
requirements that existing pages may need to satisfy.

### Added

- sidebar: `beforeCache` action for Turbo page caching — wire
  `data-action="turbo:before-cache@document->stimeo--sidebar#beforeCache"` to close
  an open overlay and release its modal side effects before the snapshot is taken.
- sidebar, stepper: the `breakpoint` and `index` values now take effect when
  changed at runtime. An invalid `breakpoint` falls back to 768px.
- Inspector: `stimeo check` verifies that the tabs `role="tablist"` element has an
  accessible name.

### Changed

- tabs: the tablist container is now a required `list` target. Add
  `data-stimeo--tabs-target="list"` to it, or `stimeo check` reports an error.
  Runtime behavior is unchanged.
- Inspector: `stimeo check` reports an error when `stimeo--sidebar` markup has no
  `panel` target.

### Fixed

- package exports: 26 controllers — including sidebar, drawer, collapsible,
  read-more, alert-dialog, carousel and tree-view — had no build output behind the
  `./controllers/*` subpath their `package.json` `exports` declares, so
  `import … from "stimeo-ui/controllers/<name>_controller"` failed to resolve in
  0.2.0. Every controller in the catalog now ships one.
- transition, flash, toast, sidebar, drawer, collapsible: animations now wait for
  every declared transition property and its `transition-delay`, not just the
  first duration. Multi-property and delayed animations are no longer cut short, a
  cancelled transition settles immediately, and pseudo-element transitions no
  longer end the wait early — so `hidden`, events, focus restore and scroll unlock
  land at the right moment.
- sidebar, drawer, collapsible: an interrupted close animation no longer leaves the
  panel stuck open with the focus trap, background `inert` or scroll lock in place.
- sidebar, drawer, collapsible, read-more, sticky-observer, overflow-indicator:
  targets swapped in or added after connect (Turbo morph, lazily loaded Frames,
  Streams) are now reconciled with the current state instead of keeping the value
  they were rendered with.
- overflow-indicator, scroll-area: horizontal position is read logically, so the
  overflow attributes, the `scrollByPage` action, `data-scroll` and
  `--stimeo-scroll-progress` behave correctly inside `dir="rtl"` containers.
- overflow-indicator: reaching an edge while a page button has focus no longer
  drops focus to the page body — the button stays focused and inert via
  `aria-disabled`, becoming natively `disabled` only once blurred.
- read-more: the toggle is no longer hidden while it holds keyboard focus when the
  text starts to fit; overflow is re-checked on blur, on content changes, and when
  media inside it finishes loading.
- sticky-observer: `data-stuck="true"` is set only once the sentinel has actually
  scrolled past the top edge — one that is merely out of view, or inside a hidden
  container, no longer marks the element as stuck. Negative `offset` values are now
  accepted.
- intersection: an element with no layout box (hidden ancestor, collapsed
  `<details>`) is no longer reported as scrolled past.

## [0.2.0] - 2026-07-22

First release off the beta channel: `npm install stimeo-ui` now resolves
this version as `latest`, and the gem no longer needs a prerelease pin. The
library is still `0.x`, so the `stimeo--*` attribute API may change before
1.0. The changes below come from a component-by-component hardening review
of the catalog, centered on layered Escape handling, IME-safe input, and
focus/dismissal correctness in the overlay controllers.

### Added

- dropdown: the trigger is now associated with its menu — on connect the
  controller sets `aria-controls`, minting a menu id when needed. Authored
  markup is never overwritten.
- toast: item interaction (dismiss click, Escape, hover/focus pause) is now
  delegated from the list container, so dynamically appended toasts work
  without per-item `data-action` attributes; the dismiss button is the
  element carrying the new `data-toast-dismiss` attribute. Existing per-item
  markup keeps working.
- Inspector: new checks — the menu target of `stimeo--menu` must carry an
  accessible name, and every command-palette option needs a unique `id`.

### Changed

- tooltip, hover-card: Escape dismissal is now owned by the shared layer
  stack, so the redundant `onKeydown` action was removed from the
  controllers and the documented trigger markup. Markup still binding it
  logs a Stimulus missing-action warning; dismissal keeps working.
- toast: the live-region role (`status`/`alert`) now applies to the body
  slot instead of the toast item, so screen readers announce only the
  message text.
- menu, overflow-menu: the documented markup contract now requires an
  accessible name on the `role="menu"` element (`aria-labelledby` or
  `aria-label`). Existing markup keeps working; the new Inspector check
  flags the missing name.
- command-palette: option ARIA is now controller-managed — `data-disabled`
  and authored `aria-disabled` stay in sync, and every option gets a
  baseline `aria-selected="false"`.

### Fixed

- Escape now dismisses exactly one overlay layer per press — the most
  recently opened one — when overlays are stacked: nested dialogs no longer
  close together, a tooltip or hover card shown above an open menu or dialog
  no longer closes the layer beneath it, a press already handled by a nested
  component (an inline edit, a listbox, a toast) is never acted on twice,
  and an Escape aimed at another layer no longer closes an overlay
  underneath or yanks focus back to its trigger. This covers dropdown,
  popover, menu, menubar, context-menu, navigation-menu, hover-card,
  tooltip, and the modal overlays; a combobox with its list closed now lets
  Escape reach the enclosing dialog.
- Escape or Enter pressed during an IME composition now steers the
  composition only: cancelling a Japanese/Chinese/Korean conversion no
  longer closes overlays, dismisses a toast or dismissible, or cancels an
  inline edit, a drag, or a pending date-range start — and a
  conversion-confirming Enter no longer saves an edit, commits a tag, or
  selects a command. Filtering inputs (combobox, multi-select,
  command-palette) apply the confirmed text once on `compositionend` instead
  of filtering intermediate text. The guards track the composition lifecycle
  instead of the deprecated `keyCode === 229` heuristic, and otp ignores
  events flagged `isComposing` even without a preceding `compositionstart`.
- command-palette: the open/close hotkey no longer misfires when Shift or
  Alt is held or when both Cmd and Ctrl are down, an unsupported hotkey
  value now does nothing, and stale `aria-activedescendant`/active-option
  state is cleaned up correctly.
- menu, context-menu: `aria-disabled="true"` items are truly inert —
  activating one runs no consumer handlers and the menu stays open — and
  Tab now lets the browser move focus before the menu closes. context-menu
  also closes on an outside right-click without stealing focus from the
  new target.
- popover, navigation-menu, dropdown: outside-interaction handling
  corrected — an outside click closes without refocusing the trigger,
  clicking non-focusable panel content or deactivating the browser window
  no longer dismisses an open panel, and dropdown's outside-click listener
  runs in the capture phase so a widget that stops click propagation can no
  longer leave a stuck menu.
- tooltip, hover-card: keyboard focus and pointer hover are now tracked as
  separate reasons to stay open (per WCAG 1.4.13), and a pending show/hide
  delay no longer leaves the element permanently stuck after a
  disconnect/reconnect cycle (e.g. a Turbo restore). The documented
  hover-card markup now also closes the card after keyboard focus leaves it.
- toast: runtime `duration` changes now take effect (0 or below makes
  toasts persistent), a toast paused after its time fully elapsed dismisses
  immediately, and dismissal is idempotent — the dismiss event fires exactly
  once per removal.
- dismissible: the `closeOnEscape` value is live after connect, and focus
  retreat now skips unfocusable candidates instead of silently dropping
  focus to `<body>`.

## [0.1.0-beta.3] - 2026-07-18

Maintenance release: one bug fix in the focus-trap primitive shared by the
modal overlay controllers.

### Fixed

- dialog, alert-dialog, confirm, drawer, command-palette, sidebar: navigating
  away while the overlay is open no longer bakes the background scroll lock
  into Turbo's page cache. A restored page previously treated the locked
  `<body>` as its baseline, so closing the overlay could leave the page
  unscrollable; the shared focus trap now reverts its side effects on
  `turbo:before-cache`.
- drawer: the usage example in the API reference now shows the backdrop
  overlay `hidden` at rest and a neutral `<div>` as the panel element.

## [0.1.0-beta.2] - 2026-07-12

The Inspector grows two new faces: an MCP server for AI coding agents and a
VS Code extension that checks markup as you type.

### Added

- **MCP server** (`stimeo-ui mcp`): the Inspector engine now runs as a Model
  Context Protocol server, so AI coding agents (Claude Code, Cursor, …) can
  discover the catalog, fetch a controller's exact contract and verified
  example markup, and check generated HTML/ERB before presenting it. Four
  read-only tools (`stimeo_check`, `stimeo_catalog`, `stimeo_controller`,
  `stimeo_example`), preloadable resources (`stimeo://manifest`,
  `stimeo://examples/<id>`), and two prompts (`stimeo_build_ui`,
  `stimeo_fix_markup`) — hand-written like the rest of the Inspector, adding
  zero runtime dependencies.
- **VS Code extension — Stimeo UI Inspector**: live diagnostics, quick fixes,
  manifest-driven completions, and contract hovers for `stimeo--*` markup in
  HTML/ERB, published on the
  [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=stimeo-labs.stimeo-ui)
  and [Open VSX](https://open-vsx.org/extension/stimeo-labs/stimeo-ui).
- Ten new components — the catalog now spans **111 controllers**: count-up,
  intersection, optimistic, pointer-drag, reading-progress,
  smart-sticky-header, sortable, and — backed by Action Cable — live-counter,
  presence, and typing-indicator.
- pointer-drag: opt-in follow mode that translates the dragged element while
  the pointer moves.
- Inspector: checks now also cover keyboard-focusability prerequisites,
  controller-managed ARIA that must not be hardcoded, and conditional
  cross-controller composition rules (manifest schema v5). Verified example
  markup for every component ships with the package.

### Fixed

- listbox, combobox, and multi-select: the active option now scrolls into
  view while navigating with the keyboard (`aria-activedescendant` lists
  keep the highlighted option visible).

## [0.1.0-beta.1] - 2026-06-30

First beta. The 101 core components meet the accessibility quality bar, so the
library graduates from the `alpha` channel to `beta`.

### Added

- multi-select: emits named hidden fields so the current selection submits with
  the form, no application JavaScript required.
- form-validation: declarative per-constraint messages and a `disallow=whitespace`
  rule.
- hover-card, tooltip, and popover: opt-in dismiss when the page scrolls.
- submit-once: auto-subscribes to `turbo:submit-start` on connect.

### Fixed

- Ignore keydown events fired during IME composition in tags-input, multi-select,
  and combobox, so selecting a candidate no longer triggers shortcuts.

## [0.1.0-alpha.1] - 2026-06-20

Initial public alpha: 101 behavior-only, accessible Stimulus controllers driven
by `data-*` attributes, shipping no CSS. Published to npm (with provenance) and
RubyGems.

[0.3.0]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.3.0
[0.2.1]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.2.1
[0.2.0]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.2.0
[0.1.0-beta.3]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-beta.1
[0.1.0-alpha.1]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-alpha.1
