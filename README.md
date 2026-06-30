<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/taiyaky/stimeo-ui/main/assets/logo-wordmark-dark.png">
    <img alt="Stimeo UI" src="https://raw.githubusercontent.com/taiyaky/stimeo-ui/main/assets/logo-wordmark.png" width="240">
  </picture>
</h1>

<p align="center"><a href="https://stimeo-labs.com"><strong>Live demo (beta) →</strong></a></p>

[![CI](https://github.com/taiyaky/stimeo-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/taiyaky/stimeo-ui/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/stimeo-ui/beta)](https://www.npmjs.com/package/stimeo-ui) [![gem](https://img.shields.io/gem/v/stimeo-ui)](https://rubygems.org/gems/stimeo-ui) [![License: MIT](https://img.shields.io/github/license/taiyaky/stimeo-ui)](LICENSE)

**Headless Stimulus UI framework for Ruby on Rails.** Stimeo UI ships *behavior*
— ARIA state, keyboard interaction, focus management, Turbo resilience — as
`data-*`-driven Stimulus controllers. It does **not** ship CSS: the consuming app
owns the look entirely.

- Lean by design: the **core** needs only `@hotwired/stimulus` at runtime (kept
  external in the build). The opt-in `stimeo-ui/positioning` module is the one
  exception — it uses `@floating-ui/dom` (an optional **peer dependency**; see the
  Peer dependencies note below).
- Accessibility first: every controller follows the relevant WAI-ARIA APG pattern
  and the related WCAG 2.2 AA criteria.
- Public controller identifiers use the `stimeo--` namespace (e.g.
  `stimeo--dropdown`).

> Status: **beta** (`0.x`). The `stimeo--*` attribute API may still change before
> 1.0 — pin your version.

## Install

### Rails with importmap (recommended)

```bash
bundle add stimeo-ui --version "0.1.0.pre.beta.1"
bin/rails generate stimeo:install
```

The generator vendors the prebuilt JS into `vendor/javascript/stimeo/`, pins
`stimeo-ui` in `config/importmap.rb`, and registers all controllers with your
Stimulus application. Then drive components from HTML alone:

```erb
<div data-controller="stimeo--dropdown">
  <button data-stimeo--dropdown-target="trigger"
          data-action="click->stimeo--dropdown#toggle">Menu</button>
  <div data-stimeo--dropdown-target="menu" hidden>…</div>
</div>
```

### npm (jsbundling or any bundler)

```bash
npm install stimeo-ui@beta @hotwired/stimulus
```

```js
import { Application } from "@hotwired/stimulus";
import { registerStimeo } from "stimeo-ui";

const application = Application.start();
registerStimeo(application); // registers every stimeo--* controller
```

Need only a few controllers? Import them individually from
`stimeo-ui/controllers/*` and register them under your own identifiers.

- **Peer dependencies:** `@hotwired/stimulus` (always), `@floating-ui/dom` (only
  if you use the opt-in `stimeo-ui/positioning` module — tooltips, popovers, etc.
  work without it via the default flow layout).
- **No CSS is shipped.** Style the components yourself; controllers only toggle
  ARIA state and `data-*` hooks.

## Linting

Stimeo UI is headless, so **you** author the WAI-ARIA roles, states, and
properties — and some controllers use explicit roles as selector contracts (the
data-grid finds its rows via `[role="row"]`). Your markup therefore contains
valid custom-widget ARIA such as `<ul role="menu">`, `<div role="radio">`, and
`<table role="grid">…<td role="gridcell">`.

Strict static a11y linters — Biome's `recommended` preset (≥ 2.5) and
`eslint-plugin-jsx-a11y` — report these valid
[APG](https://www.w3.org/WAI/ARIA/apg/) patterns as errors, because their
heuristics assume native semantic elements (there is no native equivalent for a
custom, fully-stylable radio). Relax the conflicting rules **only for the paths
where you author Stimeo UI markup** — set `includes` to your own component
directories (the value below is a placeholder; adjust it to your layout) and
keep the rules on everywhere else. For Biome:

```json
{
  "overrides": [
    {
      "includes": ["app/components/**"],
      "linter": {
        "rules": {
          "a11y": {
            "noNoninteractiveElementToInteractiveRole": "off",
            "noRedundantRoles": "off",
            "useSemanticElements": "off",
            "useFocusableInteractive": "off",
            "noNoninteractiveTabindex": "off"
          }
        }
      }
    }
  ]
}
```

The `eslint-plugin-jsx-a11y` equivalents are
`no-noninteractive-element-to-interactive-role`, `no-redundant-roles`,
`prefer-tag-over-role`, `interactive-supports-focus`, and
`no-noninteractive-tabindex`. These components' real accessibility is exercised
with axe-core and real screen readers in this project's own test suite.

## Contributing

Bug reports and feature requests are very welcome — please open a GitHub issue.
For code changes, open an issue first to discuss direction; see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Released under the [MIT License](LICENSE) © Stimeo Labs.
