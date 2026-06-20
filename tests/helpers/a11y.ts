import type { AxeResults, Result, RunOptions } from "axe-core";
import { axe } from "vitest-axe";

/**
 * Layer ① a11y audit helper (machine-detectable violations) for happy-dom tests.
 *
 * Wraps `axe-core` (via `vitest-axe`) so every controller suite can assert the
 * absence of **machine-detectable** accessibility violations — ARIA misuse,
 * missing accessible names, duplicate ids, invalid roles, and similar.
 *
 * Honest framing: axe-core only detects the subset of
 * WCAG that is *machine-checkable*, and happy-dom does not model a real
 * browser's accessibility tree, CSS, layout, or focus behavior. A clean result
 * therefore means **"no machine-detectable a11y violation was found"** — it is
 * NOT a claim of WCAG 2.2 AA conformance. Real-browser checks and screen-reader
 * verification (virtual-screen-reader for speech order; a real screen reader /
 * human for real speech) cover what this layer cannot.
 */

/** What can be audited: a live DOM element or an HTML string. */
export type A11yAuditTarget = Element | string;

/**
 * Runs axe-core against `target` and resolves the raw results.
 *
 * Prefer {@link expectNoA11yViolations} in assertions; use this when a test
 * needs to inspect specific results (e.g. assert a *particular* violation is
 * present, or scope to a subset of rules).
 */
export function auditA11y(target: A11yAuditTarget, options?: RunOptions): Promise<AxeResults> {
  return axe(target, options);
}

/**
 * Asserts that `target` has no machine-detectable a11y violations. On failure it
 * throws a readable, grouped report (rule id, impact, help URL, offending nodes)
 * so the cause is actionable without inspecting the raw axe results object.
 */
export async function expectNoA11yViolations(
  target: A11yAuditTarget,
  options?: RunOptions,
): Promise<void> {
  const results = await auditA11y(target, options);
  if (results.violations.length > 0) {
    throw new Error(formatViolations(results.violations));
  }
}

/** Formats axe violations into a compact, human-readable multi-line report. */
function formatViolations(violations: Result[]): string {
  const count = violations.length;
  const header = `Found ${count} machine-detectable a11y violation${count === 1 ? "" : "s"}:`;
  const blocks = violations.map((violation) => {
    const nodes = violation.nodes.map((node) => `      - ${node.target.join(" ")}`).join("\n");
    return [
      `  • [${violation.impact ?? "n/a"}] ${violation.id}: ${violation.help}`,
      `    ${violation.helpUrl}`,
      nodes,
    ].join("\n");
  });
  return [header, ...blocks].join("\n");
}
