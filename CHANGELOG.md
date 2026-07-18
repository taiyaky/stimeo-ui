# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, the public API (the `stimeo--*` data attributes) may
change between releases.

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

[0.1.0-beta.3]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-beta.1
[0.1.0-alpha.1]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-alpha.1
