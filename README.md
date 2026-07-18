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
bundle add stimeo-ui --version "0.1.0.pre.beta.3"
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

## Inspector CLI & MCP server

Stimeo UI bundles a zero-dependency static checker for its own markup contract
— spelling of controllers/targets/values, required structure, and the ARIA
attributes you (the author) must supply:

```bash
npx stimeo-ui check app/views    # check your templates (exit 1 on errors)
npx stimeo-ui catalog            # list every controller's public API
```

Both commands accept `--json` for machine-readable output, so `check` drops
straight into CI.

The same engine runs as a **Model Context Protocol** server, so AI coding
agents (Claude Code, Cursor, …) can discover the catalog, fetch verified
reference markup, and validate generated HTML/ERB before presenting it:

```bash
claude mcp add stimeo -- npx -y stimeo-ui mcp
```

or in `.mcp.json` (Claude Code) / `.cursor/mcp.json` (Cursor):

```json
{
  "mcpServers": {
    "stimeo": {
      "command": "npx",
      "args": ["-y", "stimeo-ui", "mcp"]
    }
  }
}
```

It exposes four read-only tools — `stimeo_check` (validate a source string),
`stimeo_catalog`, `stimeo_controller` (one controller's full contract,
accessibility requirements included), and `stimeo_example` (verified example
markup: the official catalog demo under [`examples/`](examples/), bundled at
build time and guaranteed to pass the checker) — plus MCP resources
(`stimeo://manifest`, `stimeo://examples/<id>`) for preloading context without
a tool round-trip. The server reads only its bundled manifest and example
index; there are no write-capable tools.

The same checks also run **live in your editor**: the **Stimeo UI Inspector**
extension on the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=stimeo-labs.stimeo-ui)
and [Open VSX](https://open-vsx.org/extension/stimeo-labs/stimeo-ui) (for Cursor /
VSCodium / Windsurf) gives as-you-type diagnostics, quick fixes, completions,
and contract hovers. No setup: the engine and a manifest snapshot are bundled,
and when your workspace installs `stimeo-ui`, the nearest installed version
wins — so diagnostics always match what you run.

## Contributing

Bug reports and feature requests are very welcome — please open a GitHub issue.
For code changes, open an issue first to discuss direction; see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License & Pro

Free and open source under the [MIT License](LICENSE) © Stimeo Labs. Every
component in this repository is Core, and the MIT grant is irrevocable.

**Stimeo UI Pro** — advanced behavior components that are the most work to
build yourself — is planned around 1.0 as a separately licensed commercial
track, built alongside (never carved out of) Core. For release news and
early access, join the waitlist at
[stimeo-labs.com/waitlist](https://stimeo-labs.com/waitlist).
