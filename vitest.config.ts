import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["tests/**/*.test.ts"],
    // happy-dom delivers MutationObserver records only while the callback's WeakRef
    // is still live; under the coverage run's GC pressure it gets reclaimed and the
    // records are silently dropped, flaking every MutationObserver-driven test
    // (Stimulus disconnect-on-removal, dynamic-insert detection). Pin WeakRef to a
    // strong ref so delivery is deterministic — see the setup file for the full why.
    setupFiles: ["tests/setup/deterministic-mutation-observer.ts"],
    // The a11y suites run axe-core on the real clock; under a constrained / loaded
    // runner (CI, Docker) those occasionally brush past Vitest's default 5s, flaking
    // across many files at once. A wider ceiling absorbs that without masking real
    // hangs (a genuinely stuck test still fails, just later).
    testTimeout: 15_000,
    coverage: {
      provider: "istanbul",
      // text → console (local), html → browsable report, lcov → CI/tooling,
      // json-summary → parsed into the CI job summary.
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      // Coverage ratchet: a regression *floor* set just below the current totals,
      // so it passes today but blocks any drop below it. Branches and lines sit
      // close to the actuals; statements and functions keep a wider margin. Raise
      // these as coverage grows — the goal is regression prevention, not a perfect
      // score.
      thresholds: {
        statements: 89,
        branches: 75,
        functions: 95,
        lines: 93,
      },
    },
  },
});
