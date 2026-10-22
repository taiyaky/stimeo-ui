import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    execArgv: ["--expose-gc"],
    include: ["tests/**/*.test.ts"],
    // happy-dom passes a MutationObserver record on only while the node's WeakRef to the
    // observer's listener callback still dereferences. That callback stays strongly
    // reachable while the observer observes, so a collection does not drop the records
    // of an observer that is still observing, and this setup also pins WeakRef to a
    // strong ref, so delivery does not depend on the collector either way.
    setupFiles: [
      "tests/setup/deterministic-mutation-observer.ts",
      // With its default settings happy-dom reports every <img> whose src is not a data:
      // URL as complete=true with naturalWidth=0; this restores the real-browser loading
      // window (a pending src is complete=false until load/error fires) so the avatar
      // controller's loading/loaded/error phases stay testable.
      "tests/setup/deterministic-image-loading.ts",
      // A MutationObserver callback that keeps re-triggering an observer holds the
      // worker in microtasks, where no test timeout fires; this caps the deliveries
      // of one test's observers and fails the test that set such a loop off.
      "tests/setup/bounded-mutation-observer.ts",
      // happy-dom reports a replaceWith as an insertion followed by a removal; this
      // restores the browser order, where the departing target's callback runs first.
      "tests/setup/browser-replace-order.ts",
      // happy-dom's MediaQueryList drops the options of addEventListener and keeps one
      // window resize hook per callback; this keeps its listeners as a browser does.
      "tests/setup/browser-media-query-listeners.ts",
    ],
    // The a11y suites run axe-core on the real clock; under a constrained / loaded
    // runner (CI, Docker) those occasionally brush past Vitest's default 5s, flaking
    // across many files at once. A wider ceiling absorbs that without masking real
    // hangs (a genuinely stuck test still fails, just later).
    testTimeout: 15_000,
    coverage: {
      provider: "istanbul",
      // text → console, html → browsable report, lcov → lcov.info with per-line data for
      // other tools (plus an HTML copy), json-summary → the overall and per-file totals
      // as JSON.
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      // Coverage ratchet: a *floor* below the current totals; `test:coverage` fails when
      // any total drops under it. Raise these as coverage grows — the floor keeps coverage
      // from dropping and does not ask for a perfect score.
      thresholds: {
        statements: 89,
        branches: 75,
        functions: 95,
        lines: 93,
      },
    },
  },
});
