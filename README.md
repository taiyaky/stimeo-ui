# Stimeo UI

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

> Status: **alpha** (`0.x`). The `stimeo--*` attribute API may still change before
> 1.0 — pin your version.

## Install

### Rails with importmap (recommended)

```bash
bundle add stimeo-ui
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
npm install stimeo-ui @hotwired/stimulus
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

## Contributing

Bug reports and feature requests are very welcome — please open a GitHub issue.
For code changes, open an issue first to discuss direction; see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Released under the [MIT License](LICENSE) © Stimeo Labs.
