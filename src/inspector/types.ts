/**
 * Shared types for the Stimeo Inspector CLI (`stimeo check`).
 *
 * The Inspector statically checks HTML/ERB against a *manifest* describing the
 * official `stimeo--` controllers. The same engine powers both the project's own
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
  /**
   * Keyboard prerequisites (stage 3, schema v4): targets whose documented
   * contract makes the *author* responsible for focusability — the controller
   * moves focus (or relies on the Tab order) but never writes `tabindex` for
   * them. Each listed target must be natively focusable or carry `tabindex`.
   * Targets whose controller initializes a roving tabindex on connect (tabs,
   * toolbar, radio group, …) are deliberately excluded.
   */
  readonly keyboard: readonly KeyboardRequirement[];
  /**
   * Author-futile attributes (stage 3, schema v4): ARIA the controller
   * recomputes wholesale at runtime, where an authored value can neither
   * survive nor serve as pre-connect initial state (e.g. a combobox input's
   * `aria-activedescendant`). Authoring one is reported as a *warning*.
   * Attributes whose authored value is a legitimate initial (`aria-expanded`,
   * `aria-checked`, `aria-valuenow`, …) are deliberately excluded.
   */
  readonly managedAria: readonly ManagedAriaRule[];
  /**
   * Conditional cross-controller composition rules (stage 3, schema v5):
   * value-alignment contracts between this controller and a co-located
   * companion (e.g. sortable's sort axis vs roving's `orientation`). Prose-only
   * before v5, where a dropped or misaligned value silently broke keyboard
   * interaction while `stimeo check` passed.
   */
  readonly compositions: readonly CompositionRule[];
}

/**
 * A single accessibility requirement on a controller's markup (Inspector
 * stage 3). At least one of {@link attrs} must be present on the
 * {@link target} element; when {@link values} is given, the present
 * attribute's value must be one of them. {@link or} widens the requirement
 * with alternative attribute/value groups — the requirement is satisfied when
 * *any* group is (schema v4; e.g. `role="status"` **or** `aria-live`).
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
  /**
   * Alternative attribute groups, each with its **own** allowed-value set —
   * something `attrs` alone cannot express (its `values` apply to every listed
   * attribute). A present attribute with a wrong value is still reported even
   * when another group is satisfied: an invalid authored value is an error in
   * its own right (e.g. `aria-live="off"` silencing a satisfied `role="status"`).
   */
  readonly or?: readonly A11yAlternative[];
  /** Human-readable fix suggestion shown by the CLI (stage 4). */
  readonly suggestion: string;
}

/** One alternative attribute group of an {@link A11yRequirement} (`or`). */
export interface A11yAlternative {
  /** Candidate attribute names — at least one must be present. */
  readonly attrs: readonly string[];
  /** Allowed values for the matched attribute; omit to accept any value. */
  readonly values?: readonly string[];
}

/**
 * A keyboard prerequisite (stage 3, schema v4): every present element of
 * {@link target} must be reachable by keyboard. What "reachable" means depends
 * on how the controller drives focus, expressed by {@link reach}:
 *
 * - `"tab"` (Tab stop): the element is a steady tab stop the user reaches with
 *   Tab, so it must be natively tab-focusable (`button`, `input` except
 *   `type="hidden"`, `select`, `textarea`, `summary`, `a[href]`, `area[href]`,
 *   or `contenteditable`) **or** carry `tabindex="0"` (any non-negative value).
 *   A `tabindex="-1"` removes it from the Tab order and therefore **fails** —
 *   this is the case a mere "has tabindex" presence check would miss.
 * - `"focus"` (roving / programmatic): the controller moves focus with
 *   `element.focus()`, so the element only has to be focusable *at all* —
 *   natively focusable **or** carrying any valid `tabindex` (including the
 *   roving `-1`).
 *
 * Only the per-element floor is checked; the roving set-level invariant
 * ("exactly one item is `tabindex="0"`") is runtime state owned by the
 * controller and deliberately out of scope.
 */
export interface KeyboardRequirement {
  /** Target name the requirement applies to (never the scope element). */
  readonly target: string;
  /**
   * How the user reaches the target. Defaults to `"tab"` (the common case —
   * most operation points are steady Tab stops); set `"focus"` only for
   * targets the controller roves via programmatic focus.
   */
  readonly reach?: "tab" | "focus";
  /** Human-readable fix suggestion shown by the CLI (stage 4). */
  readonly suggestion: string;
}

/**
 * An author-futile attribute rule (stage 3, schema v4): authoring any of
 * {@link attrs} on the {@link target} element draws a `managed-aria`
 * **warning** — the controller recomputes the attribute wholesale, so the
 * authored value is dead weight that misleads readers of the markup.
 */
export interface ManagedAriaRule {
  /**
   * Target name the rule applies to; the empty string `""` means the
   * controller's own scope element.
   */
  readonly target: string;
  /** Attribute names the controller owns outright. */
  readonly attrs: readonly string[];
  /** Human-readable fix suggestion shown by the CLI (stage 4). */
  readonly suggestion: string;
}

/**
 * A conditional cross-controller composition rule (stage 3, schema v5): when a
 * companion controller is co-located on one of the host's elements, one of the
 * companion's values must align with a value of the host. The rule fires only
 * when {@link coController} is actually declared there — composition itself
 * stays optional (whether to compose is the author's call; the rule only
 * guards *how*).
 *
 * Both sides are compared by their **effective** value — the authored
 * attribute, or the declared default when the attribute is absent — because
 * the misalignments these rules exist for are default asymmetries (e.g.
 * sortable defaults its `orientation` to `vertical` while roving defaults to
 * `horizontal`, so a bare composition is silently broken). The defaults are
 * duplicated here from the controllers' `static values`; a manifest test
 * guards them against drift.
 */
export interface CompositionRule {
  /**
   * Host target whose element hosts the companion; the empty string `""`
   * means the controller's own scope element.
   */
  readonly target: string;
  /**
   * Check the scope element when {@link target} is absent — for optional
   * container targets whose documented fallback is the scope element itself
   * (e.g. sortable's `list`).
   */
  readonly fallbackToScope?: boolean;
  /** Companion controller identifier expected in the element's `data-controller`. */
  readonly coController: string;
  /**
   * Condition on the host's own value (read from the scope element); omit for
   * unconditional rules. The rule applies only when the host's effective
   * value is one of `equals`.
   */
  readonly when?: {
    /** Host value name (camelCase, as declared in `static values`). */
    readonly value: string;
    /** Effective host values that arm the rule. */
    readonly equals: readonly string[];
    /** The host value's declared default, used when the attribute is absent. */
    readonly default: string;
  };
  /** Requirement on the companion's value (read from the companion's element). */
  readonly require: {
    /** Companion value name (camelCase, as declared in `static values`). */
    readonly value: string;
    /**
     * Allowed effective values, **ordered**: the first entry is the canonical
     * alignment and feeds the machine fix when an authored value is wrong.
     */
    readonly oneOf: readonly string[];
    /** The companion value's declared default, used when the attribute is absent. */
    readonly default: string;
  };
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

/** Hand-written keyboard prerequisites (stage 3), merged into the manifest. */
export type KeyboardRules = Readonly<Record<string, readonly KeyboardRequirement[]>>;

/** Hand-written author-futile attribute rules, merged into the manifest. */
export type ManagedAriaRules = Readonly<Record<string, readonly ManagedAriaRule[]>>;

/** Hand-written composition rules (stage 3), merged into the manifest. */
export type CompositionRules = Readonly<Record<string, readonly CompositionRule[]>>;

/** Severity of a diagnostic. Only `error` affects the process exit code. */
export type DiagnosticSeverity = "error" | "warning";

/**
 * Stable identifiers for the kinds of problems the Inspector reports. Useful
 * for testing, machine-readable output, and `data-stimeo-ignore` suppression
 * lists (which is why the set also exists as a runtime array).
 */
export const DIAGNOSTIC_CODES = [
  "unknown-controller",
  "unknown-target",
  "unknown-value",
  "unknown-action-controller",
  "unknown-action-method",
  "orphan-target",
  "missing-required-target",
  "missing-aria",
  "invalid-aria-value",
  "keyboard-inaccessible",
  "unresolved-idref",
  "managed-aria",
  "composition-mismatch",
  "unknown-ignore-code",
] as const;

/** See {@link DIAGNOSTIC_CODES}. */
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/**
 * A machine-applicable fix for a diagnostic: replace the source text in
 * `[start, end)` with `text`. Only emitted when the engine can compute the
 * exact range with confidence — a typo'd token inside an attribute value, or
 * a single-valued ARIA correction. Editors surface it as a quick fix; the
 * human-readable `suggestion` stays the fallback for everything else.
 */
export interface DiagnosticFix {
  /** Absolute source offset where the replacement starts. */
  readonly start: number;
  /** Absolute source offset just past the replaced text. */
  readonly end: number;
  /** Replacement text. */
  readonly text: string;
  /** Short imperative label for editor UI, e.g. `Replace with "stimeo--menu"`. */
  readonly title: string;
}

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
   * Length in source characters of the anchored token starting at `column` —
   * the attribute name for attribute-anchored diagnostics, or the opening
   * `<tag` for element-anchored ones. Lets editors underline the exact token
   * instead of guessing a word boundary. Optional so hand-built or historical
   * reports without it stay valid; consumers should fall back to `1`.
   */
  readonly length?: number;
  /**
   * Optional fix suggestion (stage 4): the corrected attribute to add, or the
   * nearest known name for a likely typo. Rendered on its own line by the CLI.
   */
  readonly suggestion?: string;
  /** Machine-applicable replacement (stage 4), when one can be computed safely. */
  readonly fix?: DiagnosticFix;
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
