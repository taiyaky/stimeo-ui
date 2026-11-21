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

Type checks run TypeScript 7 through the `@typescript/native` alias. The separate
`typescript` dependency stays on TypeScript 6 for the compiler API and declaration
generation. Use `bun run typecheck` so the compiler is selected explicitly.

### Watching source changes

The watch commands require Linux and the `flock` command from util-linux. Set
`STIMEO_WATCH_LOCK_ROOT` to an absolute directory on a shared Linux filesystem;
every writer or cleanup process for the same checkout must use that directory.
For a local Linux checkout, for example:

```bash
export STIMEO_WATCH_LOCK_ROOT=/tmp/stimeo-watch-locks
bun run dev
```

Watch output is kept in `.stimeo-watch/`, separately from the ordinary `dist/`
that `bun run build` generates for package use. Wait for the first published
generation, then use `bun run dev:inspector -- catalog` (or `check` / `mcp`) to
read its Inspector code, manifest and examples together. To inspect the ordinary
build instead, run `node dist/inspector/cli_bin.js catalog`.

Old watch generations remain available after rebuilding. Stop the watcher and
any readers before running `bun run dev:clean` with the same lock directory.
Cleanup removes those generations, so an existing reader must be restarted.

`bun run test` is the unit suite (Vitest + happy-dom) and covers behavior, ARIA,
keyboard interaction, machine-detectable a11y, and screen-reader speech order
(via a virtual screen reader). Please cover your change with unit tests. Only the
real-browser (end-to-end) and real-screen-reader layers run separately, and we
cover those — you don't need to add them; just note any real-browser behavior in
your PR.

## Releases

npm (`stimeo-ui`) and the RubyGem (`stimeo-ui`) are published from CI when a `v*`
tag is pushed; npm artifacts are published with provenance.
