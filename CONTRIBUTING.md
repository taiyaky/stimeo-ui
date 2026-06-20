# Contributing to Stimeo UI

Thanks for your interest in contributing!

## How to contribute

- **Issues & discussions** — very welcome. Please file bugs, questions, and
  feature requests as GitHub Issues.
- **Pull requests** — feel free to open a PR to propose a change. For anything
  non-trivial, please open an issue first so we can discuss direction; the
  maintainers will land accepted changes (you'll be credited).

## Local development

The library source and tests are included, so you can build and test locally:

```bash
bun install
bun run lint
bun run typecheck
bun run test
bun run build
```

`bun run test` is the unit suite (Vitest + happy-dom) and covers behavior, ARIA,
keyboard interaction, machine-detectable a11y, and screen-reader speech order
(via a virtual screen reader). Please cover your change with unit tests. Only the
real-browser (end-to-end) and real-screen-reader layers run separately, and we
cover those — you don't need to add them; just note any real-browser behavior in
your PR.

## Releases

npm (`stimeo-ui`) and the RubyGem (`stimeo-ui`) are published from CI when a `v*`
tag is pushed; npm artifacts are published with provenance.
