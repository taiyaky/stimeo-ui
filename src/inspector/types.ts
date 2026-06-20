/**
 * Shared types for the Stimeo Inspector CLI (`stimeo check`).
 *
 * The Inspector statically checks HTML/ERB against a *manifest* describing the
 * official `stimeo--` controllers. The same engine powers both internal CI
 * contract checks (e.g. `stimeo check app/views`) and the
 * user-facing product feature; it is therefore intentionally input-path
 * agnostic.
 */

/**
 * Per-controller manifest entry.
 *
 * `targets` and `values` are reflected from the controller class
 * (`static targets` / `static values`). `actions` and `events` are reflected
 * from co-located `static actions` / `static events` declarations — Stimulus
 * keeps no registry of action methods, and TypeScript `private` survives on the
 * prototype, so the public action/event surface cannot be told apart from
 * internal helpers by reflection alone; it must be declared explicitly in the
 * implementation. `requiredTargets` is a hand-written structure rule (Stimulus
 * reflection cannot express "required").
 */
export interface ControllerManifest {
  /** Target names declared via `static targets`. */
  readonly targets: readonly string[];
  /** Value names (camelCase) declared via `static values`. */
  readonly values: readonly string[];
  /**
   * Public action method names declared via `static actions`, wired by
   * consumers as `data-action="…-><identifier>#<action>"`.
   */
  readonly actions: readonly string[];
  /**
   * Logical event names declared via `static events`, dispatched as
   * `<identifier>:<event>` (Stimulus `this.dispatch("<event>")`).
   */
  readonly events: readonly string[];
  /** Targets that must be present at least once inside the controller scope. */
  readonly requiredTargets: readonly string[];
  /**
   * Accessibility requirements the *consumer's markup* must satisfy (stage 3):
   * ARIA attributes the controller does **not** set at runtime and therefore
   * relies on the author to provide (e.g. a dialog's `role`/`aria-modal`/name).
   * Attributes the controller manages itself (e.g. tabs' `aria-selected`) are
   * deliberately excluded — requiring them would be noise.
   */
  readonly a11y: readonly A11yRequirement[];
}

/**
 * A single accessibility requirement on a controller's markup (Inspector
 * stage 3). At least one of {@link attrs} must be present on the
 * {@link target} element; when {@link values} is given, the present
 * attribute's value must be one of them.
 */
export interface A11yRequirement {
  /**
   * Target name the requirement applies to; the empty string `""` means the
   * controller's own scope element (the `data-controller` node).
   */
  readonly target: string;
  /**
   * Candidate attribute names — at least one must be present. A list expresses
   * "any of" (e.g. `aria-labelledby` *or* `aria-label` for an accessible name).
   */
  readonly attrs: readonly string[];
  /** Allowed values for the matched attribute; omit to accept any value. */
  readonly values?: readonly string[];
  /** Human-readable fix suggestion shown by the CLI (stage 4). */
  readonly suggestion: string;
}

/**
 * The bundled manifest. `schemaVersion` tracks the manifest *format*;
 * `packageVersion` tracks the `stimeo-ui` release it was generated from so a
 * consumer can confirm the check matches their installed version.
 */
export interface Manifest {
  readonly schemaVersion: number;
  readonly packageVersion: string;
  /** Keyed by controller identifier, e.g. `stimeo--menu`. */
  readonly controllers: Readonly<Record<string, ControllerManifest>>;
}

/** Hand-written structure rules, merged into the reflected manifest. */
export type StructureRules = Readonly<
  Record<string, { readonly requiredTargets?: readonly string[] }>
>;

/** Hand-written accessibility rules (stage 3), merged into the manifest. */
export type A11yRules = Readonly<Record<string, readonly A11yRequirement[]>>;

/** Severity of a diagnostic. Only `error` affects the process exit code. */
export type DiagnosticSeverity = "error" | "warning";

/**
 * Stable identifiers for the kinds of problems the Inspector reports. Useful
 * for testing and for future machine-readable output.
 */
export type DiagnosticCode =
  | "unknown-controller"
  | "unknown-target"
  | "unknown-value"
  | "unknown-action-controller"
  | "unknown-action-method"
  | "orphan-target"
  | "missing-required-target"
  | "missing-aria"
  | "invalid-aria-value";

/** A single problem found in a source file. */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** 1-based line where the problem was detected. */
  readonly line: number;
  /** 1-based column where the problem was detected. */
  readonly column: number;
  /**
   * Optional fix suggestion (stage 4): the corrected attribute to add, or the
   * nearest known name for a likely typo. Rendered on its own line by the CLI.
   */
  readonly suggestion?: string;
}

/** Diagnostics grouped by the file they came from. */
export interface FileReport {
  readonly file: string;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Machine-readable result of `stimeo check --json`: the structured counterpart
 * of the human report, for editor tooling and CI. `files` lists only sources
 * that produced diagnostics; `ok` is
 * true when no error-severity diagnostic was found (mirrors the exit code).
 */
export interface CheckReport {
  /** True when no error-severity diagnostics were found. */
  readonly ok: boolean;
  /** Total number of HTML/ERB files scanned. */
  readonly checkedFiles: number;
  /** Count of error-severity diagnostics across all files. */
  readonly errorCount: number;
  /** Count of warning-severity diagnostics across all files. */
  readonly warningCount: number;
  /** Per-file reports, limited to files that produced at least one diagnostic. */
  readonly files: readonly FileReport[];
}
