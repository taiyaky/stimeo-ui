/**
 * Shared types for the Stimeo Inspector CLI (`stimeo check`).
 *
 * The Inspector statically checks HTML/ERB against a *manifest* describing the
 * official `stimeo--` controllers. The same engine powers both the library's
 * own contract checks (e.g. `stimeo check app/views`) and the user-facing CLI;
 * it is therefore intentionally input-path agnostic.
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
   * Authoring constraints for literal Stimulus Values (stage 1). Reflection can
   * expose a Value's name and decoder, but not semantic bounds such as a
   * strictly positive step, so those contracts stay explicit and reviewable.
   */
  readonly valueConstraints: readonly ValueConstraint[];
  /** Statically decidable relationships between literal Stimulus Values. */
  readonly valueRelations: readonly ValueRelation[];
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
   * Target requirements that only apply once an optional target appears. See
   * {@link ConditionalTargetRule}.
   */
  readonly conditionalTargets: readonly ConditionalTargetRule[];
  /**
   * Accessibility requirements the *consumer's markup* must satisfy (stage 3):
   * ARIA attributes the controller does **not** set at runtime and therefore
   * relies on the author to provide (e.g. a dialog's `role`/`aria-modal`/name).
   * Attributes the controller manages itself (e.g. tabs' `aria-selected`) are
   * deliberately excluded — requiring them would be noise.
   */
  readonly a11y: readonly A11yRequirement[];
  /**
   * Keyboard prerequisites (stage 3): targets whose documented contract makes
   * the *author* responsible for focusability — the controller
   * moves focus (or relies on the Tab order) but never writes `tabindex` for
   * them. Each listed target must be natively focusable or carry `tabindex`.
   * Targets whose controller initializes a roving tabindex on connect (tabs,
   * toolbar, radio group, …) are deliberately excluded.
   */
  readonly keyboard: readonly KeyboardRequirement[];
  /**
   * Host-element contracts (stage 3): scope or target elements that must avoid
   * native interactive semantics the controller cannot safely compose with.
   * A rule may explicitly admit non-submitting buttons when the controller
   * delegates their native activation to the browser.
   */
  readonly hosts: readonly HostRequirement[];
  /**
   * Author-futile attributes (stage 3): ARIA the controller recomputes
   * wholesale at runtime, where an authored value can neither
   * survive nor serve as pre-connect initial state (e.g. a combobox input's
   * `aria-activedescendant`). Authoring one is reported as a *warning*.
   * Attributes whose authored value is a legitimate initial (`aria-expanded`,
   * `aria-checked`, `aria-valuenow`, …) are deliberately excluded.
   */
  readonly managedAria: readonly ManagedAriaRule[];
  /**
   * Conditional cross-controller composition rules (stage 3): value-alignment
   * contracts between this controller and a co-located companion (e.g.
   * sortable's sort axis vs roving's `orientation`). A dropped or misaligned
   * value silently breaks keyboard interaction, and no single-controller rule
   * can see it.
   */
  readonly compositions: readonly CompositionRule[];
  /**
   * Required companion controllers (stage 3): elements the contract says must
   * *also* declare another controller (e.g. an overflow menu's More
   * wrapper, whose menu behavior is delegated wholesale). Distinct from
   * {@link compositions}, which fire only once the companion is already there:
   * these fire on its **absence**, the case a rule keyed on presence can never
   * see.
   */
  readonly companions: readonly CompanionRequirement[];
  /**
   * Reverse-direction target rules (stage 3): markup that carries a pattern's
   * ARIA but was never declared as a target. Every other rule reads
   * target → required attribute; these read attribute → required target, the
   * direction in which an undeclared element is invisible to the controller
   * (and therefore to every forward rule).
   */
  readonly targetDeclarations: readonly TargetDeclarationRule[];
  /**
   * Set-level count constraints (stage 3): how many elements may or must exist
   * inside a scope or a container target. Every other family judges one element
   * at a time, which cannot express contracts of the form "exactly one" / "at
   * most one" however load-bearing they are.
   */
  readonly cardinality: readonly CardinalityRule[];
  /**
   * Attributes that must **not** be present in a given configuration
   * (stage 3). The inverse of {@link a11y}, and distinct from
   * {@link managedAria}: those attributes are futile because the *controller*
   * owns them, whereas these stay the author's to write — they are simply
   * contradicted by the markup around them (a menu declaring itself busy while
   * its items are right there).
   */
  readonly forbiddenAria: readonly ForbiddenAriaRule[];
}

/**
 * A condition on the controller's **own** Stimulus value, read from the scope
 * element. Shared by every rule family that needs one.
 *
 * The value is compared by its **effective** reading — the authored attribute,
 * or {@link default} when the attribute is absent — so a rule can be scoped to
 * a non-default configuration without flagging the default one. That is the
 * whole point: a horizontal toolbar must *not* carry
 * `aria-orientation="vertical"`, so the requirement only exists in the vertical
 * configuration and an unconditional rule would reject correct markup.
 *
 * {@link default} duplicates the controller's `static values` default; a
 * manifest test guards it against drift.
 */
export interface ValueCondition {
  /** Value name (camelCase, as declared in `static values`). */
  readonly value: string;
  /** Effective values that arm the rule. */
  readonly equals: readonly string[];
  /** The value's declared default, used when the attribute is absent. */
  readonly default: string;
}

/**
 * A condition on how many targets an element **holds**, evaluated against the
 * very element the rule applies to — not the controller scope, the way
 * {@link ValueCondition} is. Both may appear on one rule; both must hold.
 *
 * It exists for contracts whose ARIA depends on the element's own contents
 * rather than on any configuration value. A `role="menu"` requires owned
 * `menuitem`s, so a menu the consumer fills asynchronously has to declare the
 * temporary absence with `aria-busy` — a requirement that must arm on
 * emptiness alone, since the controller cannot tell "still loading" from
 * "nothing to show" and therefore never infers it.
 *
 * Bounds are inclusive and independently optional; a condition with neither is
 * meaningless and rejected by the manifest tests.
 */
export interface ContentCondition {
  /** Target name counted **inside** the element the rule applies to. */
  readonly target: string;
  /** Arms the rule when the count is at least this. */
  readonly min?: number;
  /** Arms the rule when the count is at most this. */
  readonly max?: number;
}

/**
 * A condition on the element's **own tag**, evaluated per element the way
 * {@link ContentCondition} is.
 *
 * It exists for roles whose accessible name ARIA marks *required* but which a
 * **native** element can name with no author ARIA at all: a
 * `<table role="grid">` names from its `<caption>`, a
 * `<fieldset role="radiogroup">` from its `<legend>`, an
 * `<input role="combobox">` from a `<label for>`. Requiring `aria-label` on
 * those would reject correct markup, while dropping the rule outright would
 * leave the `div`-based spelling — the one with no native naming path at all —
 * unchecked. This disarms exactly the spellings that have one.
 *
 * The exemption is keyed on the **tag**, not on finding the name: a
 * `<label for>` legitimately lives in another partial, so looking for it would
 * report a missing name that is present one file over. Erring toward
 * under-detection is the same call the cardinality rules make for
 * ERB-generated values.
 */
export interface ElementCondition {
  /** Lowercase tag names whose native naming path disarms the requirement. */
  readonly exceptTags: readonly string[];
}

/**
 * A condition on the **whole source file**: how many elements in it carry a
 * given role. Every other condition reads one element or one scope; this one
 * reads the file.
 *
 * It exists for ARIA's *conditionally* levelled names, which come in both
 * directions: a `toolbar`'s name is "Recommended" and becomes "Required if
 * multiple toolbars on a page" ({@link A11yRequirement.escalateWhen}), while a
 * focusable `separator`'s name is discretionary and only becomes "Recommended
 * if more than one focusable separator" ({@link A11yRequirement.whenDocument}).
 * One raises the level of a standing requirement; the other brings a
 * requirement into existence.
 *
 * A file is not a page, so this deliberately **under**-approximates: elements
 * split across partials are counted apart and stay at the lower level. That is
 * the safe direction — it never invents a requirement the author does not have.
 */
export interface DocumentCondition {
  /** Role counted across the file. */
  readonly role: string;
  /** Holds when at least this many elements in the file carry {@link role}. */
  readonly atLeast: number;
  /**
   * Counts only Tab-reachable elements; omit to count every carrier of the
   * role. ARIA qualifies some of these conditions by focusability and some not:
   * a `separator`'s name matters once there is more than one **focusable**
   * separator, because that is when a user can land on both and needs to tell
   * them apart — a decorative `hr` carrying the role does not create that
   * problem. A `toolbar`'s condition has no such qualifier, so it counts all.
   */
  readonly focusable?: boolean;
}

/**
 * A single accessibility requirement on a controller's markup (Inspector
 * stage 3). At least one of {@link attrs} must be present on the
 * {@link target} element; when {@link values} is given, the present
 * attribute's value must be one of them. {@link or} widens the requirement
 * with alternative attribute/value groups — the requirement is satisfied when
 * *any* group is (e.g. `role="status"` **or** `aria-live`).
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
  /**
   * Restricts the requirement to one configuration of the controller's own
   * value; omit for unconditional requirements. It exists for ARIA that is
   * mandatory in one configuration and *wrong* in another.
   */
  readonly when?: ValueCondition;
  /**
   * Restricts the requirement to elements holding a given number of a target;
   * omit for requirements that do not depend on the contents. Evaluated per
   * element, so sibling targets are judged independently.
   */
  readonly whenContains?: ContentCondition;
  /**
   * Disarms the requirement on elements whose tag already carries a native
   * naming path; omit for requirements that hold for every spelling of the
   * role.
   */
  readonly whenElement?: ElementCondition;
  /**
   * Arms the requirement only in files satisfying a file-level condition; omit
   * for requirements that apply to every file.
   *
   * Some ARIA names are optional alone and only start to matter in company: a
   * lone focusable `separator` needs no name, while a second one on the same
   * page leaves the two indistinguishable without one. Arming on the count
   * keeps the single-splitter page — by far the common one — silent, instead of
   * demanding a name that would only ever be read out as noise.
   */
  readonly whenDocument?: DocumentCondition;
  /**
   * Severity of an unmet requirement; omit for `"error"`.
   *
   * ARIA separates names it *requires* from names it merely *recommends*
   * (`toolbar`, `menubar`, `tablist`, `menu`). A missing recommended name is
   * real contract guidance but not a definite defect — the pattern still works
   * without it — so it reports as a warning, the bar `managed-aria` and
   * `forbidden-aria` already sit at. Reporting both levels as errors would make
   * the check say "broken" where ARIA says "could be clearer".
   */
  readonly severity?: DiagnosticSeverity;
  /**
   * Raises {@link severity} to `"error"` while the file-level condition holds;
   * omit for requirements whose level never moves. ARIA's conditional
   * requirements have exactly this shape — a toolbar's name is recommended on
   * its own and required once the file holds a second one, because that is the
   * point where the name stops being decoration and becomes the only way a user
   * can tell the two apart.
   */
  readonly escalateWhen?: DocumentCondition;
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
 * A keyboard prerequisite (stage 3): every present element of {@link target}
 * must be reachable by keyboard. What "reachable" means depends on how the
 * controller drives focus, expressed by {@link reach}:
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
 * A host-element contract (stage 3): the element carrying a controller or one
 * of its targets must use semantics the controller can own without competing
 * with another native interaction.
 *
 * `"non-interactive"` admits only generic, non-interactive elements.
 * `"non-interactive-or-button"` additionally admits a `<button>` whose
 * literal `type` is listed in {@link buttonTypes}. The explicit type matters:
 * a missing or invalid button type defaults to `submit`, so treating it as an
 * ordinary action button would silently submit an enclosing form.
 */
export interface HostRequirement {
  /** Target name; the empty string `""` means the controller scope element. */
  readonly target: string;
  /** Static host shapes the controller supports. */
  readonly mode: "non-interactive" | "non-interactive-or-button";
  /** Literal button types admitted by `"non-interactive-or-button"`. */
  readonly buttonTypes?: readonly string[];
  /** Human-readable fix suggestion shown by the CLI (stage 4). */
  readonly suggestion: string;
}

/**
 * An author-futile attribute rule (stage 3): authoring any of {@link attrs} on
 * the {@link target} element draws a `managed-aria` **warning** — the
 * controller recomputes the attribute wholesale, so the authored value is dead
 * weight that misleads readers of the markup.
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
 * A conditional cross-controller composition rule (stage 3): when a companion
 * controller is co-located on one of the host's elements, one of the
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
  readonly when?: ValueCondition;
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
 * A required companion controller (stage 3): the {@link target} element must
 * itself declare {@link controller} in its `data-controller`.
 *
 * This is the **absence** counterpart of {@link CompositionRule}. A composition
 * rule guards *how* two controllers are wired once both are present, and stays
 * silent when the companion was never added — correct for optional
 * compositions, useless for the mandatory ones. Where the host delegates a
 * whole interaction (a More wrapper whose menu semantics and keyboard handling
 * belong entirely to the menu controller), dropping the companion leaves markup
 * that renders, passes every forward rule, and simply never opens.
 */
export interface CompanionRequirement {
  /**
   * Target name whose element must declare the companion; the empty string
   * `""` means the controller's own scope element.
   */
  readonly target: string;
  /** Companion controller identifier required in the element's `data-controller`. */
  readonly controller: string;
  /** Human-readable fix suggestion shown by the CLI (stage 4). */
  readonly suggestion: string;
}

/**
 * A reverse-direction target rule (stage 3): inside the controller's scope,
 * every element carrying {@link attr} (with one of {@link values}, when given)
 * must be declared as the {@link target} target.
 *
 * Forward rules ask "does this target carry the ARIA it needs?" and therefore
 * only ever see markup the controller already knows about. The failure this
 * rule exists for is the opposite one: markup that *looks* like part of the
 * pattern to a screen reader — it has the role — but was never wired as a
 * target, so the controller's roving, visible-item search, typeahead, and
 * selection sync all skip it. Nothing in the forward direction can detect that,
 * because the element is absent from every target set the forward rules read.
 *
 * Ownership is resolved by the **nearest** enclosing controller of the same
 * identifier, so nested instances judge only their own elements.
 */
export interface TargetDeclarationRule {
  /** Attribute that marks an element as part of the pattern (e.g. `role`). */
  readonly attr: string;
  /** Attribute values that mark it; omit to match any non-empty value. */
  readonly values?: readonly string[];
  /** Target name the matched element must be declared as. */
  readonly target: string;
  /** Human-readable fix suggestion shown by the CLI (stage 4). */
  readonly suggestion: string;
}

/**
 * A set-level count constraint (stage 3): how many {@link target} elements may
 * live inside {@link within}, optionally narrowed to those carrying
 * {@link attr}.
 *
 * Every other rule family judges elements one at a time, which cannot express
 * the two contracts that matter most in a set: "this wrapper resolves to
 * exactly one control" and "no more than one element is selected". Both fail
 * silently — a hover wrapper holding two triggers always opens the first, and a
 * second authored selection is quietly normalized away at connect, discarding
 * the author's intent with no diagnostic anywhere.
 *
 * Bounds are inclusive and independently optional; a rule with neither is
 * meaningless and rejected by the manifest tests.
 */
export interface CardinalityRule {
  /**
   * Container target whose element bounds the count — each container element is
   * counted separately. The empty string `""` counts across the whole
   * controller scope.
   */
  readonly within: string;
  /** Target name whose elements are counted. */
  readonly target: string;
  /** Count only elements carrying this attribute; omit to count them all. */
  readonly attr?: string;
  /** Restricts {@link attr} to these values; omit to accept any value. */
  readonly values?: readonly string[];
  /** Smallest permitted count (inclusive); omit for no floor. */
  readonly min?: number;
  /** Largest permitted count (inclusive); omit for no ceiling. */
  readonly max?: number;
  /**
   * Restricts the constraint to one configuration of the controller's own
   * value; omit for unconditional constraints. Multiplicity is frequently a
   * *configured* property (a grid whose `selection` value decides whether two
   * selected rows are a bug or the point), so a fixed bound would be wrong in
   * one of the configurations.
   */
  readonly when?: ValueCondition;
  /** Human-readable fix suggestion shown by the CLI (stage 4). */
  readonly suggestion: string;
}

/**
 * An attribute that must **not** be present in a given configuration
 * (stage 3): authoring any of {@link attrs} on the {@link target} element —
 * with one of {@link values}, when given — contradicts the markup around it.
 *
 * Three families speak about an attribute the author might write, and the
 * difference is *why* it should go:
 *
 * - {@link A11yRequirement} — it is missing and the pattern needs it.
 * - {@link ManagedAriaRule} — the **controller** recomputes it, so any authored
 *   value is dead weight in every state.
 * - This rule — the author legitimately owns the attribute, and it is even
 *   required in the *other* configuration; here it simply states something the
 *   surrounding markup contradicts.
 *
 * Reported as a **warning**, not an error, and deliberately so: a static reader
 * sees one file at one instant, and cannot separate a stale declaration from a
 * genuine in-progress one (a menu whose items stream in a chunk at a time is
 * correctly busy *with* items present). The markup may be lying; the page still
 * works either way.
 */
export interface ForbiddenAriaRule {
  /**
   * Target name the rule applies to; the empty string `""` means the
   * controller's own scope element.
   */
  readonly target: string;
  /** Attribute names that must not be present. */
  readonly attrs: readonly string[];
  /** Restricts the rule to these values; omit to forbid the attribute outright. */
  readonly values?: readonly string[];
  /**
   * Restricts the rule to elements holding a given number of a target. Without
   * a condition the rule would forbid the attribute unconditionally, which is
   * {@link ManagedAriaRule}'s job — so in practice every rule here carries one.
   */
  readonly whenContains?: ContentCondition;
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

/**
 * A target requirement that only exists once another *optional* target is
 * present.
 *
 * `requiredTargets` is unconditional, which cannot express the shape two
 * controllers actually have: a feature that is entirely opt-in, but **incomplete
 * without its whole set**. A breadcrumb without any `collapsible` is a valid plain
 * trail; add one and the disclosure (`ellipsis` + `trigger`) becomes mandatory,
 * because without it the collapsed items have no control that can reveal them. A
 * file-dropzone without an `itemTemplate` never renders a list; add one without a
 * `list` and the selected files render nowhere.
 *
 * Both fail the same way: the required targets are *present enough* to pass every
 * other check, the page loads, `stimeo check` is green — and the feature silently
 * does nothing. Making the trigger target unconditionally required is not an
 * option: it would reject the plain spelling, which is the common one.
 */
export interface ConditionalTargetRule {
  /** The optional target whose presence turns the feature on. */
  readonly whenPresent: string;
  /** Targets that become required once {@link whenPresent} appears. */
  readonly require: readonly string[];
  /** Human-readable fix suggestion shown by the CLI (stage 4). */
  readonly suggestion: string;
}

/**
 * A statically checkable numeric contract on one declared Stimulus Value.
 *
 * The Inspector decodes literals like Stimulus (`Number(raw.replace(/_/g,
 * ""))`) before applying these bounds. ERB-generated values are undecidable and
 * skipped rather than guessed.
 */
export interface ValueConstraint {
  /** Value name (camelCase, as declared in `static values`). */
  readonly value: string;
  /** Decoder family. Numeric bounds are the first supported semantic family. */
  readonly type: "number";
  /** Reject `NaN` and infinities when true. */
  readonly finite?: boolean;
  /** Require a decoded number strictly greater than this bound. */
  readonly greaterThan?: number;
  /** Human-readable fix suggestion shown by the CLI (stage 4). */
  readonly suggestion: string;
}

/**
 * A statically checkable relationship between two numeric Stimulus Values.
 *
 * Missing attributes use the controller's public defaults. If either authored
 * value is dynamic, the Inspector skips the relation rather than guessing.
 */
export interface ValueRelation {
  /** Value on the left side of the comparison (camelCase). */
  readonly left: string;
  /** Supported numeric comparison. */
  readonly operator: "less-than-or-equal";
  /** Value on the right side of the comparison (camelCase). */
  readonly right: string;
  /** Effective left value when its attribute is absent. */
  readonly leftDefault: number;
  /** Effective right value when its attribute is absent. */
  readonly rightDefault: number;
  /** Human-readable fix suggestion shown by the CLI (stage 4). */
  readonly suggestion: string;
}

/** Hand-written structure rules, merged into the reflected manifest. */
export type StructureRules = Readonly<
  Record<
    string,
    {
      readonly requiredTargets?: readonly string[];
      readonly conditionalTargets?: readonly ConditionalTargetRule[];
    }
  >
>;

/** Hand-written literal Value constraints, merged into the manifest. */
export type ValueConstraintRules = Readonly<Record<string, readonly ValueConstraint[]>>;

/** Hand-written relationships between literal Values, merged into the manifest. */
export type ValueRelationRules = Readonly<Record<string, readonly ValueRelation[]>>;

/** Hand-written accessibility rules (stage 3), merged into the manifest. */
export type A11yRules = Readonly<Record<string, readonly A11yRequirement[]>>;

/** Hand-written keyboard prerequisites (stage 3), merged into the manifest. */
export type KeyboardRules = Readonly<Record<string, readonly KeyboardRequirement[]>>;

/** Hand-written host-element contracts (stage 3), merged into the manifest. */
export type HostRules = Readonly<Record<string, readonly HostRequirement[]>>;

/** Hand-written author-futile attribute rules, merged into the manifest. */
export type ManagedAriaRules = Readonly<Record<string, readonly ManagedAriaRule[]>>;

/** Hand-written composition rules (stage 3), merged into the manifest. */
export type CompositionRules = Readonly<Record<string, readonly CompositionRule[]>>;

/** Hand-written required-companion rules, merged into the manifest. */
export type CompanionRules = Readonly<Record<string, readonly CompanionRequirement[]>>;

/** Hand-written reverse-direction target rules, merged into the manifest. */
export type TargetDeclarationRules = Readonly<Record<string, readonly TargetDeclarationRule[]>>;

/** Hand-written cardinality rules, merged into the manifest. */
export type CardinalityRules = Readonly<Record<string, readonly CardinalityRule[]>>;

/** Hand-written forbidden-attribute rules, merged into the manifest. */
export type ForbiddenAriaRules = Readonly<Record<string, readonly ForbiddenAriaRule[]>>;

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
  "invalid-value",
  "unknown-action-controller",
  "unknown-action-method",
  "orphan-target",
  "missing-required-target",
  "missing-conditional-target",
  "missing-aria",
  "invalid-aria-value",
  "keyboard-inaccessible",
  "invalid-host",
  "unresolved-idref",
  "managed-aria",
  "composition-mismatch",
  "missing-companion",
  "undeclared-target",
  "cardinality-violation",
  "forbidden-aria",
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
   * instead of guessing a word boundary. Optional so hand-built reports without
   * it stay valid; consumers should fall back to `1`.
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
 * that produced diagnostics; `ok` is true when no error-severity diagnostic was
 * found (mirrors the exit code).
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
