# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, the public API (the `stimeo--*` data attributes) may
change between releases.

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

[0.1.0-beta.1]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-beta.1
[0.1.0-alpha.1]: https://github.com/taiyaky/stimeo-ui/releases/tag/v0.1.0-alpha.1
