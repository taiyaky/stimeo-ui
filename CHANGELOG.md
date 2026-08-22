# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, the public API (the `stimeo--*` data attributes) may
change between releases.

## [0.8.0] - 2026-08-22

Minor release with no new components. Eight existing ones are reworked —
auto-submit, carousel, currency-input, file-dropzone, input-mask, nested-form,
otp, and textarea-autosize — and of those, carousel, otp, and file-dropzone also
changed their markup contracts, so read Removed and Changed before upgrading. The
Inspector manifest stays on schema v12.

### Removed

- otp: `length` — the number of `field` targets is the passcode length.
- file-dropzone: the `status` target, `dragLabel`, and the
  `data-file-dropzone-slot` attributes.

### Added

- `reconcile` on auto-submit, direct-upload, file-dropzone, flash, frame-loading,
  input-mask, nested-form, otp, spinner, and submit-once — it also reports the
  state a Turbo rewind discarded, carrying what that component lost
  (`{ files }`, `{ ids }`, `{ forms }`, `{ removed }`, or `{}`).
- carousel: `data-state`, `inert` on inactive slides, `prefers-reduced-motion`,
  and optional pickers. otp: `clear` / `onPointerDown`, and text carrying several
  characters spread across the following fields. file-dropzone:
  `allowDuplicates`, a `thumb` target, and the `announce*Text` wording.
- Characters an IME commits full-width are read as their half-width form in
  input-mask, otp, and currency-input.
- Inspector: rules for the reworked markup — carousel's controller-owned ARIA,
  the `playToggle` an `autoplay` carousel needs, the `prev` / `next` pair, a
  finite positive `interval`, otp's group and field names, and the parts
  file-dropzone's item template must contain.

### Changed

- carousel: drop the `data-action` wiring and any authored `aria-pressed` —
  clicks, picker keys, hover, and focus are delegated, and `aria-pressed` /
  `aria-disabled` / `aria-live` / `aria-atomic` are controller-owned. Name the
  toggle with `aria-label`, pair `prev` with `next`, and give an `autoplay`
  carousel a `playToggle` (WCAG 2.2.2).
- otp: the root needs `role="group"` and a name, and each `field` its own.
  `invalid` reports only input that filled no field.
- file-dropzone: put a `stimeo--announcer` on the page, set the `announce*Text`
  wording, and use `name` / `thumb` / `remove` targets in the item template with
  an authored `aria-label`. Validation runs `type` → `size` → `duplicate` →
  `count`, and `change` precedes `reject`.
- input-mask: `change` fires only for a user edit; normalization and runtime
  Value changes report `reconcile`. The manifest reports `tokens` as `String`
  where it reported `Object`.
- textarea-autosize: `resize` no longer fires when a connect leaves the height
  unchanged; width, font, and runtime `minRows` / `maxRows` changes are followed.
- currency-input keeps what was typed while typing and rounds on blur;
  nested-form absorbs rows added or removed outside it; auto-submit follows a
  swapped `form` target.

### Fixed

- carousel: the play toggle stops rotation — the `focusin` before the click no
  longer makes the press resume instead. otp: a full-width commit into one field
  fills the following ones. currency-input: a locale with non-Latin digits
  reparses its own output. nested-form: a discarded-but-visible row's remove
  button no longer swallows the click.

## [0.7.0] - 2026-08-16

Minor release reworking the form stack, separator, and scroll-area, with
announcements moving onto the shared `stimeo--announcer`. The Inspector manifest
moves to schema v12, so `stimeo check` can report on views that passed under
0.6.0.

### Removed

- **Breaking** — direct-upload: the `status` target and the `announce` /
  `doneLabel` / `errorLabel` Values. Use `announceDoneText` /
  `announceErrorText` with `{name}` instead of `%{name}`.
- **Breaking** — persist: the unversioned draft format. Drafts written by earlier
  releases are discarded, not migrated.

### Added

- separator `min` / `max` / `value`; submit-once `finish` / `cancel` and
  `idle` / `busy` targets; dirty-form `acceptRestore`; character-counter
  `announceText`; form-field `setError(message, { focus })`; persist `error`;
  `reconcile` on character-counter and conditional-fields.
- form-validation: localized constraint wording through
  `data-stimeo--form-validation-message[-<constraint>]`, a declarative
  `disallow="whitespace"`, and controls attached with `form="id"`.
- Inspector: schema v12 (`requiredActions`, `actionCompletion`) with the
  `missing-required-action`, `missing-action-completion`, and
  `missing-announcer` diagnostics.

### Changed

- **Breaking** — announcing components need a `stimeo--announcer` on the page
  plus the wording: character-counter `announceText`, direct-upload
  `announceDoneText` / `announceErrorText`, submit-once `announceText` /
  `announceReadyText`. Drop `role="alert"` from form-field's `error` target and
  `aria-live` from character-counter's `output`.
- **Breaking** — separator: the Values are the only runtime input, so move
  `role`, `tabindex`, and the orientation / range ARIA into `orientation`,
  `focusable`, `min`, `max`, `step`, and `value`. A `focusable` separator also
  needs `keydown->stimeo--separator#onKeydown` on itself and an accessible name.
- **Breaking** — submit-once: sessions are per form, and `preventDefault()` no
  longer ends one — wire `finish` or `cancel`, or set a `timeout`. `start` /
  `end` carry `{ form, submitter, … }`.
- **Breaking** — direct-upload: `done` fires only on success, and a row that
  reached `error` stays there.
- **Breaking** — dirty-form: a successful submit re-baselines to what Turbo
  submitted, so later edits stay dirty, and one native confirmation covers every
  dirty form per navigation. With persist, add
  `data-action="stimeo--persist:restore->stimeo--dirty-form#acceptRestore"`.
- **Breaking** — character-counter: `change` fires only when a committed edit
  changes the length. form-field: `validate` fires only for `setError` /
  `clearError`.
- persist: `exclude` defaults to Rails' `authenticity_token` / `_method` /
  `utf8`; `password` is always excluded regardless of the list.

### Fixed

- Attribute and style leases are released by the subscriber that owns the
  lifecycle, so a cached page no longer retains detached elements.
- localStorage access goes through one guarded helper, so persist, sidebar, and
  theme keep working when the browser denies storage.

## [0.6.0] - 2026-08-15

Minor release that separates reconciled state from user edits: `change` now
means the user committed a value, and a controller that re-derives its own state
reports `reconcile` instead. Several markup contracts tightened, and authored
prose — remove-button names, announcements — moved out of the library. The
Inspector manifest stays on schema v11, but **`stimeo check` can report errors on
views that passed under 0.5.0**, so run it before deploying.

### Upgrade notes

- Listening to `change` to observe controller-driven repair? Subscribe to
  `reconcile` too: carousel, checkbox, color-picker, multi-select, number-input,
  radio-group, rating, tags-input, time-picker. Neither fires on connect.
- rating: delete `max` and every `data-rating-value`. The DOM order of the
  `symbol` targets is the scale.
- aspect-ratio: delete the `content` target.
- toggle-group, radio-group: items must be `<button type="button">` or a
  non-interactive host with `role="button"` / `role="radio"`. Others are left
  untouched at runtime.
- tags-input, multi-select: delete the `status` target, put a
  `stimeo--announcer` on the page, and set `announceText` /
  `announceRemovedText`. In the chip template add `label` and `remove` targets
  and author the remove button's `aria-label` (`{label}` / `{value}` expand).
  Drop `data-*-slot="label"` and tags-input's `removeTag` action.
- date-range-picker: declare unavailable days with `disabled-dates`; an
  `aria-disabled` you write on a cell is overwritten on the next paint.
- time-picker: AM/PM is a `role="spinbutton"` segment, not an `aria-pressed`
  toggle. `seconds` only decides whether the composed value carries seconds.
- List values are read as JSON strings — idle's `events`, password-strength's
  `levels`, persist's `exclude`, date-range-picker's `disabled-dates`. The
  markup is unchanged; the manifest reports `String` where it reported `Array`.

### Removed

- **Breaking** — rating: `max` and `data-rating-value`. aspect-ratio: the
  `content` target. tags-input, multi-select: the `status` target, tags-input's
  `removeTag` action, and the English `Remove {value}` label the library wrote
  onto generated remove buttons.

### Added

- A `reconcile` event, carrying the same `detail` as that component's `change`,
  on carousel, checkbox, color-picker, multi-select, number-input, radio-group,
  rating, tags-input, and time-picker.
- checkbox: a group works without a `parent`; the root still reports
  `all` / `partial` / `none`.
- rating: `Delete` and `Backspace` clear the rating when `clearable`.
- date-range-picker: `disabled-dates`, a `monthchange` event,
  `Shift+PageUp` / `Shift+PageDown` for stepping a year, and month labels
  formatted from `documentElement.lang`.
- multi-select: a `fields` target holding one hidden input per selected value,
  with `name` and `form`, plus `announceText` / `announceRemovedText`.
  tags-input: `label` and `remove` targets and the same two announce values.
- avatar: an `empty` state beside `loading`, `loaded`, and `error`.
- Inspector: `invalid-host` for radio-group and toggle-group items;
  chip-template parts required *inside* the template; `aria-label` on remove
  buttons and the group role on toggle groups; at most one checkbox `parent`
  and one checked radio; a positive integer time-picker `step`. An empty
  attribute value no longer satisfies a requirement that asks only for the
  attribute's presence.

### Changed

- **Breaking** — `change` is reserved for user-committed values. DOM
  normalization, target churn, morphs, and runtime value changes report
  `reconcile`, and a repair that leaves the committed state unchanged reports
  nothing.
- **Breaking** — radio-group, time-picker: the hidden `field` fires a native
  `change` only for user edits, so a server-rendered repaint cannot drive an
  `auto-submit` companion into a resubmit loop.
- **Breaking** — multi-select: `max` is enforced at all times, not only on the
  click path; surplus options normalize to `aria-selected="false"`.
- **Breaking** — avatar: a present `src` value wins over an authored `src`, and
  an empty one means "no image". Remove the attribute to hand the element's own
  `src` back.
- **Breaking** — checkbox: a parent toggle sets each child's `checked` without
  synthesizing a native `change` per child; the root reports one event.
- toggle-group, radio-group, tags-input, multi-select: interaction is delegated
  from the container, so items added at runtime work without per-item
  `data-action`. Existing per-item actions stay compatible.
- toggle-group, radio-group: `aria-disabled` items stay reachable by arrow keys
  with activation suppressed; natively disabled and `hidden` items are skipped.
- number-input, rating, scroll-area, time-picker: ARIA and `tabindex` the
  controller writes are treated as loans and handed back to their authored
  values, without overwriting a change you made in the meantime.
- date-range-picker: a preset that only partly overlaps `min` / `max` is
  narrowed to the selectable span instead of committing an unavailable endpoint.
- multi-select, tags-input: `Backspace` in an empty input removes the last chip
  and keeps focus in the input.
- time-picker: a unit that wraps past noon or midnight carries AM/PM with it,
  and one operation reports one `change` with the final value.

### Fixed

- avatar, carousel, checkbox, radio-group, rating, roving, toggle-group: targets
  added, removed, or morphed at runtime settle on one state — a single tab stop,
  a single checked or pressed item, and focus on a surviving item.
- date-range-picker: an unavailable day cannot become a committed endpoint
  through a preset, a preview, or Enter/Space; a reversed stored range is
  normalized on connect; a pending selection is rewound before Turbo caches the
  page.
- number-input: commits compare numbers rather than the displayed text, and IME
  composition never commits a value.
- time-picker: with `wrap` disabled, 11 and 12 no longer step into each other,
  and an unfinished direct-entry buffer is discarded when focus leaves.
- multi-select, tags-input: a chip is built only when the template can produce a
  complete one, only the `remove` target inside a chip acts on it, and a
  replaced `tags` container is re-wired.
- file-dropzone, scroll-area: a replaced `list` / `viewport` keeps its state and
  takes over the listeners; the old element stops responding.
- idle, password-strength, persist, date-range-picker: a malformed list value
  falls back to its default instead of stopping the controller from connecting
  and leaving the whole element inert.

## [0.5.0] - 2026-08-13

### Changed

- **Breaking** — every CSS custom property the library writes now carries the
  `--stimeo--` namespace (two hyphens). Rename them in your stylesheets: a name
  you miss raises no error, it just falls back to `var()`'s default and the bar
  or thumb stops moving.
  - `--stimeo-range-start` / `--stimeo-range-end` →
    `--stimeo--range-slider-start` / `--stimeo--range-slider-end`
  - `--stimeo-<name>` → `--stimeo--<name>` for `aspect-ratio`,
    `collapsible-content-height`, `color`, `context-menu-x`, `context-menu-y`,
    `masonry-columns`, `meter-ratio`, `password-strength`, `progress-ratio`,
    `scroll-progress`, `step-indicator-ratio`, `textarea-rows`,
    `upload-progress`
- **Breaking** — spinner's `indicator`, the network-status banners, and
  countdown's `status` slot are no longer live regions. Drop `role="status"` /
  `role="alert"` / `aria-live` from them and set `announceText` (and its
  siblings) with a `stimeo--announcer` on the page; keeping the role reads the
  change twice.
- time-picker: committing a field change dispatches a native `change` from the
  `field` target, and `stimeo--time-picker:change` reports the composed value
  even when no `field` target is present.
- tree-view: more native elements count as nested-interactive (`label`,
  `summary`, `details`, `area[href]`, media with `controls`, `iframe`, `object`,
  `embed`), so a click or key inside one is left alone instead of moving the
  tree selection.

### Added

- Inspector: the manifest advances from schema v8 to **v11** — tools that read it
  raw must accept the new `valueConstraints`, `hosts`, and `valueRelations`
  fields. Two diagnostics are new, so **re-run `stimeo check` before deploying;
  it can report errors on views that passed under 0.4.0**:
  - `invalid-value` — slider, range-slider, and number-input need a finite,
    positive `step`; range-slider needs finite `min`, `max`, `start`, and `end`
    with `min` at or below `max`.
  - `invalid-host` — switch, time-picker, and tree-view report an unsupported
    host element before it reaches the browser.

### Fixed

- range-slider: two thumbs resting on the same value can be pulled apart with
  the pointer again, and invalid or reversed bounds fall back to a finite
  ordered range.
- slider, range-slider, number-input: an endpoint that does not sit on the step
  grid is reachable, and an invalid `step` falls back to `1`.
- slider, range-slider: a Turbo morph that swaps a value repaints instead of
  freezing, a replaced thumb or track picks up the current state, and a drag
  stays with the pointer that started it.
- switch: holding Space no longer scrolls a non-`<button>` host, and an ancestor
  `fieldset[disabled]` or `aria-disabled` blocks activation.
- flash: hover and focus pause the auto-dismiss independently, a flash paused
  after its deadline dismisses instead of staying forever, a second dismiss on a
  leaving flash is ignored, and a replaced `region` target is picked up.
- frame-loading: `aria-busy`, the skeleton, and `inert` are rolled back when the
  controller is detached, instead of burning in with nothing left to finish the
  load.
- empty-state: a replaced `list` or `empty` element and a runtime `itemSelector`
  change are followed, so the placeholder no longer sticks beside a filled list.
- highlight: a highlight that outlives a Turbo navigation is cleaned up on the
  way back instead of staying marked.
- idle: `data-idle` is cleared when a new measurement cycle connects, and
  `disconnect()` removes the listeners it actually registered even when `events`
  changed while connected.
- skeleton: a skeleton moved within the page keeps its ready intent.

## [0.4.0] - 2026-08-11

The feedback and status components announce through the shared
`stimeo--announcer` and survive Turbo caching and morphs. The Inspector reads the
`data:` hashes Rails helpers render. Two public API entries were removed.

### Removed

- **Breaking** — sidebar: the `beforeCache` action. Delete
  `data-action="turbo:before-cache@document->stimeo--sidebar#beforeCache"`; the
  behavior is built in, and leaving it makes `stimeo check` report an unknown
  action.
- **Breaking** — empty-state: the `announce` boolean, and the `role="status"` /
  `aria-live="polite"` it applied to the `empty` target. Use `announceText` /
  `announceFilledText` instead.

### Added

- countdown, empty-state, frame-loading, meter, network-status, progress,
  skeleton, spinner: `announceText`, plus `announceFilledText` /
  `announceOnlineText` / `announceReadyText` where a component has two
  transitions to report. Wording is yours and defaults to empty, and the page
  needs a `stimeo--announcer` for any of it to be read.
- spinner: `timeout`, with a `stimeo--spinner:timeout` event. Off by default.
- stick-to-bottom: `pinOnConnect`. Off by default.
- Inspector: Stimulus wiring in a Rails helper's literal `data:` hash is checked
  like static attributes. Re-run `stimeo check` — it can report new diagnostics.

### Changed

- meter, progress: an `aria-valuetext` you authored is preserved across renders.
- local-time, relative-time: the locale falls back to the nearest ancestor
  carrying `lang`, not just the element's own and then the document's.
- countdown: `data-state` is the source of truth for the run state; `autostart`
  governs only markup that states none.

### Fixed

- Turbo caching and morphs across announcer, color-picker, countdown,
  date-range-picker, frame-loading, local-time, meter, overflow-menu, progress,
  range-slider, rating, relative-time, sidebar, spinner, step-indicator: the
  page is rewound before the snapshot and repaints when values are swapped,
  instead of restoring stuck state or leaving a stale reading.
- network-status: transitions are actually announced.
- countdown: resume steps by one unit, and a settled timer no longer re-emits
  `complete` on reconnect.
- step-indicator: runtime step changes re-derive the set, and a non-numeric
  `current` falls back to the first step.
- local-time: a `datetime` with a space separator (`2026-06-08 12:30`) parses.
- relative-time: a malformed `locale` no longer throws.
- skeleton, frame-loading: a repeated signal no longer restarts or stacks the
  minimum-duration wait.
- Empty, inverted, and non-numeric ranges floor to `0` across meter, progress,
  slider, and range-slider.

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

[0.8.0]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.8.0
[0.7.0]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.7.0
[0.6.0]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.6.0
[0.5.0]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.5.0
[0.4.0]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.4.0
[0.3.0]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.3.0
[0.2.1]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.2.1
[0.2.0]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.2.0
[0.1.0-beta.3]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-beta.1
[0.1.0-alpha.1]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-alpha.1
