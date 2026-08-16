import { Controller } from "@hotwired/stimulus";
import { setDefaultAttribute } from "../utils/default_attribute";
import { canTakeFocus, firstTabStop, isTabStop } from "../utils/focus_candidate";
import type { FormFieldController } from "./form_field_controller";

/** Native form controls that participate in constraint validation. */
type ValidatableControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/**
 * Maps each `ValidityState` flag (in priority order) to the kebab-case suffix of
 * its per-constraint message-override attribute. The first flag that is `true`
 * wins, so e.g. `valueMissing` is reported before a stale `patternMismatch`.
 */
const CONSTRAINT_MESSAGE_KEYS: ReadonlyArray<readonly [keyof ValidityState, string]> = [
  ["valueMissing", "value-missing"],
  ["typeMismatch", "type-mismatch"],
  ["patternMismatch", "pattern-mismatch"],
  ["tooShort", "too-short"],
  ["tooLong", "too-long"],
  ["rangeUnderflow", "range-underflow"],
  ["rangeOverflow", "range-overflow"],
  ["stepMismatch", "step-mismatch"],
  ["badInput", "bad-input"],
];

/** Attribute prefix for a per-constraint message override, authored on the control. */
const MESSAGE_ATTR_PREFIX = "data-stimeo--form-validation-message-";
/** Attribute for a generic message override applied to any failing constraint. */
const MESSAGE_ATTR_GENERIC = "data-stimeo--form-validation-message";
/** Attribute opting a control into a declarative custom rule (`"whitespace"`). */
const DISALLOW_ATTR = "data-stimeo--form-validation-disallow";
/** Message override dedicated to the declarative whitespace rule. */
const DISALLOW_WHITESPACE_MESSAGE = `${MESSAGE_ATTR_PREFIX}whitespace`;
/** Default message when `disallow="whitespace"` fails and no override is given. */
const DISALLOW_WHITESPACE_DEFAULT = "Please enter a value that is not only whitespace.";

/** Public invalid-state hook owned by `stimeo--form-field`. */
const FORM_FIELD_INVALID_ATTR = "data-stimeo--form-field-invalid";

/** Identity used to collect controls into one validation field. */
type FieldGroupKey = FormFieldController | ValidatableControl | string;

/** A field's validatable controls, grouped so the whole field validates together. */
interface FieldGroup {
  readonly key: FieldGroupKey;
  readonly field: FormFieldController | undefined;
  readonly controls: ValidatableControl[];
}

/** Live form grouping resolved once for a validation operation. */
interface ValidationSnapshot {
  readonly groups: Map<FieldGroupKey, FieldGroup>;
  /** `null` is a deliberate miss key so delegated non-control events need one guard. */
  readonly groupByControl: Map<ValidatableControl | null, FieldGroup>;
}

/**
 * Headless, accessible **form-validation orchestration**.
 *
 * Markup contract (identifier: `stimeo--form-validation`):
 *   <form data-controller="stimeo--form-validation"
 *         data-stimeo--form-validation-stimeo--form-field-outlet="[data-controller~='stimeo--form-field']">
 *     <div data-controller="stimeo--form-field">
 *       <label for="email">Email</label>
 *       <input id="email" type="email" required
 *              data-stimeo--form-field-target="control" />
 *       <p hidden data-stimeo--form-field-target="error"></p>
 *     </div>
 *     <button type="submit">Save</button>
 *   </form>
 *
 * Not an APG widget pattern — this is the *timing* layer for **error
 * identification** (WCAG 3.3.1) and **error suggestion** (3.3.3): it decides
 * *when* each control is checked and routes the browser's native
 * `validationMessage` into the field's {@link FormFieldController} error region.
 * The per-field ARIA wiring (`aria-invalid` / `aria-errormessage` /
 * `aria-describedby`) therefore lives in exactly one place — `stimeo--form-field`,
 * reached through a Stimulus **outlet** — and is never re-implemented here.
 *
 * `valid` dispatches `{}`; `invalid` dispatches `{ invalid: HTMLElement[] }`.
 *
 * @remarks
 * Behavior only — validation **rules** stay in the markup (native HTML
 * constraints: `required`, `type`, `pattern`, `min`/`max`, …) or in the consumer's
 * own `setCustomValidity()` calls, which `checkValidity()` surfaces transparently.
 * It sets the form's `novalidate` so it can replace the browser's default error
 * bubbles with accessible in-page visual errors plus the shared Announcer, and
 * restores the attribute on disconnect.
 *
 * Two declarative escape hatches let a field **exceed** native validation with no
 * consumer JS (author them on the control):
 * - **Per-constraint messages** — `data-stimeo--form-validation-message-<constraint>`
 *   (`value-missing`, `too-short`, `too-long`, `pattern-mismatch`, `type-mismatch`,
 *   `range-overflow`, `range-underflow`, `step-mismatch`, `bad-input`), or a generic
 *   `data-stimeo--form-validation-message` fallback, override the shown text per failing
 *   `ValidityState` flag — controlled, localizable wording that also fixes headless
 *   browsers returning an empty native `validationMessage`. Falls back to native.
 * - **`data-stimeo--form-validation-disallow="whitespace"`** — a built-in custom rule
 *   rejecting a value that is blank after trimming (which slips past `required` /
 *   `minlength`), wired through `setCustomValidity` so it blocks submit like any
 *   native constraint.
 *
 * Behavior provided:
 * - On connect, suppresses native bubbles (`novalidate`, restored on disconnect)
 *   and intercepts the form's `submit` in the **capture phase** so an invalid form
 *   is cancelled before any other submit handler (e.g. `stimeo--submit-once`)
 *   reacts to a submission that will never happen.
 * - On submit, validates every control; if any is invalid it blocks submission,
 *   moves focus to the first invalid control (unless `focusInvalid` is `false`),
 *   and dispatches `stimeo--form-validation:invalid`. An all-valid form dispatches
 *   `:valid` and submits normally.
 * - Validates a field on blur once it has been interacted with (`validateOnBlur`),
 *   and re-validates it on input while it is already touched
 *   (`revalidateOnInput`) so a shown message clears the moment the value becomes
 *   valid — but a pristine field is never eagerly flagged mid-typing.
 *
 * A control with no owning `stimeo--form-field` outlet is still validated (it can
 * block submit and receive focus) but renders no message.
 *
 * Radio groups work unchanged: point the field's `control` target at the
 * `role="radiogroup"` container so the invalid state lands on the group, and the
 * group is reported as a single invalid entry (not one per radio).
 *
 * Rich widgets (listbox, time-picker, …) that keep their committed value in a
 * hidden holder participate by making that holder a **validatable mirror**:
 * `<input type="text" hidden required>` — the `hidden` *attribute*, not
 * `type="hidden"`, which is barred from constraint validation. Native
 * constraints then govern the widget's value with no extra JavaScript. The
 * widget dispatches a bubbling `change` on the mirror when a value is committed
 * (a completed interaction, so it validates immediately), and focus for an
 * invalid mirror is delegated to the field's visible `control` target — the
 * target itself when focusable, else its first focusable descendant.
 *
 * No-JS caveat: a `required` mirror also gates the browser's own pre-Stimulus
 * validation, which cannot surface UI on an invisible control. When the no-JS
 * fallback matters, author `novalidate` on the form (this controller preserves
 * an author-set attribute) so the submission reaches the server's validation.
 */
export class FormValidationController extends Controller<HTMLFormElement> {
  static override outlets = ["stimeo--form-field"];
  static override values = {
    validateOnBlur: { type: Boolean, default: true },
    validateOnChange: { type: Boolean, default: true },
    revalidateOnInput: { type: Boolean, default: true },
    focusInvalid: { type: Boolean, default: true },
  };
  static actions = ["validate"] as const;
  static events = ["valid", "invalid"] as const;

  declare readonly stimeoFormFieldOutlets: FormFieldController[];
  declare readonly stimeoFormFieldOutletElements: HTMLElement[];

  declare validateOnBlurValue: boolean;
  declare validateOnChangeValue: boolean;
  declare revalidateOnInputValue: boolean;
  declare focusInvalidValue: boolean;

  /** Marker recording that we added `novalidate`, so we only remove our own. */
  static readonly #NOVALIDATE_MARKER = "data-stimeo--form-validation-novalidate";

  /** Object-backed groups already interacted with — the input revalidation gate. */
  readonly #touchedGroups = new WeakSet<FormFieldController | ValidatableControl>();

  /** String-backed fallback radio groups already interacted with. */
  readonly #touchedRadioGroups = new Set<string>();

  /**
   * Last message this controller wrote through `setCustomValidity`, kept as a
   * two-layer ownership ledger: a value is cleared only while the live message
   * still equals the recorded write. Iterable so disconnect can release every
   * surviving loan without touching a consumer's later custom error.
   */
  readonly #ownedCustomErrors = new Map<ValidatableControl, string>();

  /** Last invalid message routed to each field, suppressing duplicate reports. */
  readonly #reportedErrors = new WeakMap<FormFieldController, string>();

  /** Exact document that owns the delegated listeners for this connection. */
  #listenerDocument: Document | null = null;

  readonly #onSubmit = (event: SubmitEvent): void => {
    if (event.target !== this.element) return;
    const invalid = this.#validateAll();
    if (invalid.length === 0) {
      this.dispatch("valid", { detail: {} });
      return;
    }
    // Cancel the whole submit: preventDefault stops native/Turbo navigation;
    // stopImmediatePropagation keeps later submit handlers (e.g. submit-once's
    // busy state) from acting on a submission that will never happen.
    event.preventDefault();
    event.stopImmediatePropagation();
    const first = invalid[0];
    if (this.focusInvalidValue && first) this.#focusTargetFor(first)?.focus();
    this.dispatch("invalid", { detail: { invalid } });
  };

  readonly #onFocusOut = (event: FocusEvent): void => {
    if (!this.validateOnBlurValue) return;
    const snapshot = this.#snapshot();
    const group = snapshot.groupByControl.get(this.#controlFrom(event.target));
    if (!group) return;
    // Focus moving *within* the same field (e.g. between members of a radio
    // group) is not leaving it — defer validation until focus actually exits.
    const related = event.relatedTarget;
    if (group.field && related instanceof Node && group.field.element.contains(related)) return;
    if (snapshot.groupByControl.get(this.#controlFrom(related))?.key === group.key) return;
    this.#markTouched(group.key);
    this.#applyGroup(group);
  };

  readonly #onInput = (event: Event): void => {
    if (!this.revalidateOnInputValue) return;
    const group = this.#snapshot().groupByControl.get(this.#controlFrom(event.target));
    // Only re-validate a field the user has already left once, so the first
    // keystroke never eagerly flags a control they are still filling in.
    if (!group || !this.#isTouched(group.key)) return;
    this.#applyGroup(group);
  };

  readonly #onChange = (event: Event): void => {
    if (!this.validateOnChangeValue) return;
    const group = this.#snapshot().groupByControl.get(this.#controlFrom(event.target));
    if (!group) return;
    // change marks a *committed* interaction (a picked option, a toggled box, a
    // widget writing its mirror), so unlike input it both touches and validates.
    this.#markTouched(group.key);
    this.#applyGroup(group);
  };

  /** Suppresses native bubbles and binds the submit / blur / input listeners. */
  override connect(): void {
    if (setDefaultAttribute(this.element, "novalidate", "")) {
      this.element.setAttribute(FormValidationController.#NOVALIDATE_MARKER, "");
    }
    // Capture submit before form-bound actions. The other bubbling events live on
    // the same document so controls associated through `form="id"` participate too;
    // #controlFrom rejects every control owned by a different form.
    this.#listenerDocument = this.element.ownerDocument;
    this.#listenerDocument.addEventListener("submit", this.#onSubmit, true);
    this.#listenerDocument.addEventListener("focusout", this.#onFocusOut);
    this.#listenerDocument.addEventListener("input", this.#onInput);
    this.#listenerDocument.addEventListener("change", this.#onChange);
  }

  /** Tears down listeners and restores `novalidate` if we added it. */
  override disconnect(): void {
    this.#listenerDocument?.removeEventListener("submit", this.#onSubmit, true);
    this.#listenerDocument?.removeEventListener("focusout", this.#onFocusOut);
    this.#listenerDocument?.removeEventListener("input", this.#onInput);
    this.#listenerDocument?.removeEventListener("change", this.#onChange);
    this.#listenerDocument = null;
    for (const [control, message] of this.#ownedCustomErrors) {
      if (control.validationMessage === message) control.setCustomValidity("");
    }
    this.#ownedCustomErrors.clear();
    this.#touchedRadioGroups.clear();
    if (this.element.hasAttribute(FormValidationController.#NOVALIDATE_MARKER)) {
      this.element.removeAttribute("novalidate");
      this.element.removeAttribute(FormValidationController.#NOVALIDATE_MARKER);
    }
  }

  /**
   * Validates every control now, rendering or clearing each field's message, and
   * returns whether the whole form is valid. Marks every field/group touched so
   * a later input from any sibling re-validates it. Bound via `data-action`
   * (`#validate`) or callable directly (e.g. before a programmatic submit).
   */
  validate(): boolean {
    return this.#validateAll().length === 0;
  }

  /**
   * Validates every control and returns one invalid control per field. Controls
   * are grouped by field first (see {@link #keyFor}) so a field with several
   * controls — a radio group, or a mirror plus its visible control — reflects
   * *all* of them: a valid sibling must never clear an invalid one's message.
   * Each group's first invalid control supplies the message and the focus target.
   */
  #validateAll(): ValidatableControl[] {
    const invalid: ValidatableControl[] = [];
    for (const group of this.#snapshot().groups.values()) {
      this.#markTouched(group.key);
      const firstInvalid = this.#applyGroup(group);
      if (firstInvalid) invalid.push(firstInvalid);
    }
    return invalid;
  }

  /** Builds the current field table in one pass over form controls and DOM depth. */
  #snapshot(): ValidationSnapshot {
    const fields = this.#fieldOutlets();
    const groups = new Map<FieldGroupKey, FieldGroup>();
    const groupByControl = new Map<ValidatableControl | null, FieldGroup>();

    for (const control of this.#controls) {
      const field = this.#fieldFor(control, fields);
      const key = this.#keyFor(control, field);
      let group = groups.get(key);
      if (!group) {
        group = { key, field, controls: [] };
        groups.set(key, group);
      }
      group.controls.push(control);
      groupByControl.set(control, group);
    }

    return { groups, groupByControl };
  }

  /** Records that a whole field/group, rather than one sibling control, was visited. */
  #markTouched(key: FieldGroupKey): void {
    if (typeof key === "string") {
      this.#touchedRadioGroups.add(key);
    } else {
      this.#touchedGroups.add(key);
    }
  }

  #isTouched(key: FieldGroupKey): boolean {
    return typeof key === "string"
      ? this.#touchedRadioGroups.has(key)
      : this.#touchedGroups.has(key);
  }

  /**
   * Runs native constraint validation across a field's controls and routes the
   * result to its `stimeo--form-field` outlet: the first invalid control's
   * `validationMessage` is shown, an all-valid field is cleared. Returns the
   * first invalid control (for the invalid list / focus), or `null` when valid.
   * Routing goes through the outlet, so the ARIA wiring is never duplicated here.
   */
  #applyGroup(group: FieldGroup): ValidatableControl | null {
    // Apply declarative custom rules (e.g. disallow="whitespace") before reading
    // validity so they participate in checkValidity() like a native constraint.
    for (const control of group.controls) this.#syncCustomValidity(control);
    const firstInvalid = group.controls.find((control) => !control.checkValidity()) ?? null;
    if (group.field) {
      if (firstInvalid) {
        const message = this.#messageFor(firstInvalid);
        const alreadyReported =
          group.field.element.hasAttribute(FORM_FIELD_INVALID_ATTR) &&
          this.#reportedErrors.get(group.field) === message;
        if (!alreadyReported) group.field.setError(message, { focus: false });
        this.#reportedErrors.set(group.field, message);
      } else if (
        group.field.element.hasAttribute(FORM_FIELD_INVALID_ATTR) ||
        this.#reportedErrors.has(group.field)
      ) {
        group.field.clearError();
        this.#reportedErrors.delete(group.field);
      }
    }
    return firstInvalid;
  }

  /**
   * Resolves the message to show for an invalid control: a per-constraint
   * override (`data-stimeo--form-validation-message-<constraint>`) for the first failing
   * `ValidityState` flag, then a generic `data-stimeo--form-validation-message`
   * override, then the browser's native `validationMessage`. Authoring an override
   * gives controlled, localizable, theme-able wording with **no consumer JS** —
   * and sidesteps headless browsers that return an empty native message.
   */
  #messageFor(control: ValidatableControl): string {
    // `setCustomValidity()` owns its wording. In particular, a consumer's custom
    // error must not be replaced by a simultaneous native-constraint override.
    if (control.validity.customError) return control.validationMessage;
    for (const [flag, key] of CONSTRAINT_MESSAGE_KEYS) {
      if (control.validity[flag]) {
        return (
          this.#authoredMessage(control, `${MESSAGE_ATTR_PREFIX}${key}`) ??
          this.#authoredMessage(control, MESSAGE_ATTR_GENERIC) ??
          control.validationMessage
        );
      }
    }
    return control.validationMessage || this.#authoredMessage(control, MESSAGE_ATTR_GENERIC) || "";
  }

  /**
   * Applies (or clears) a declarative custom constraint via `setCustomValidity`,
   * for controls that opt in with `data-stimeo--form-validation-disallow`. The supported
   * rule is `"whitespace"` — a value that is non-empty but blank
   * after trimming (which slips past `required` / `minlength`); its message follows
   * the whitespace-specific → generic → default chain.
   *
   * Don't-clobber-authored-state: an unknown/absent rule is never written, an
   * existing consumer custom error wins, and a controller error is only cleared
   * while the live message still equals the recorded controller write.
   */
  #syncCustomValidity(control: ValidatableControl): void {
    const recorded = this.#ownedCustomErrors.get(control);
    const ownsCurrent = recorded !== undefined && control.validationMessage === recorded;

    const violates =
      control.getAttribute(DISALLOW_ATTR) === "whitespace" &&
      control.value.length > 0 &&
      control.value.trim() === "";
    if (!violates) {
      if (ownsCurrent) control.setCustomValidity("");
      this.#ownedCustomErrors.delete(control);
      return;
    }

    // One custom-validity slot exists per control. Preserve a consumer's live
    // entry; once they clear it, the next validation applies the declarative rule.
    if (control.validity.customError && !ownsCurrent) return;

    const message =
      this.#authoredMessage(control, DISALLOW_WHITESPACE_MESSAGE) ??
      this.#authoredMessage(control, MESSAGE_ATTR_GENERIC) ??
      DISALLOW_WHITESPACE_DEFAULT;
    if (!ownsCurrent || recorded !== message) control.setCustomValidity(message);
    this.#ownedCustomErrors.set(control, message);
  }

  /** Returns a non-blank authored message, otherwise falls through to a fallback. */
  #authoredMessage(control: ValidatableControl, attribute: string): string | null {
    const message = control.getAttribute(attribute);
    return message && message.trim().length > 0 ? message : null;
  }

  /**
   * A grouping key that collects controls belonging to the same field: the owning
   * `stimeo--form-field` when present, else a radio group's shared `name`, else
   * the control itself (always distinct).
   */
  #keyFor(control: ValidatableControl, field: FormFieldController | undefined): FieldGroupKey {
    if (field) return field;
    if (control instanceof HTMLInputElement && control.type === "radio" && control.name) {
      return `radio:${control.name}`;
    }
    return control;
  }

  /**
   * Where focus should land for an invalid control. A visible control is focused
   * directly — the case for native fields and radios. A validatable mirror
   * (the `hidden` attribute) cannot receive focus, so focus is delegated to the
   * visible widget: the owning field's `control` target when it is itself
   * focusable, else its first focusable descendant (e.g. a roving-tabindex
   * member). Resolved structurally — never by probing `focus()` — so behavior
   * is deterministic and CSS-independent.
   */
  #focusTargetFor(control: ValidatableControl): HTMLElement | null {
    if (canTakeFocus(control)) return control;
    const field = this.#fieldFor(control, this.#fieldOutlets());
    if (!field?.hasControlTarget) return null;
    const root = field.controlTarget;
    if (isTabStop(root)) return root;
    return firstTabStop(root);
  }

  /** Pairs each live outlet element with its controller once per operation. */
  #fieldOutlets(): Map<HTMLElement, FormFieldController> {
    const fields = new Map<HTMLElement, FormFieldController>();
    const elements = this.stimeoFormFieldOutletElements;
    const outlets = this.stimeoFormFieldOutlets;
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index];
      const outlet = outlets[index];
      if (element && outlet) fields.set(element, outlet);
    }
    return fields;
  }

  /** The nearest configured field ancestor of `control`, if any. */
  #fieldFor(
    control: ValidatableControl,
    fields: ReadonlyMap<HTMLElement, FormFieldController>,
  ): FormFieldController | undefined {
    let ancestor: HTMLElement | null = control;
    while (ancestor) {
      const field = fields.get(ancestor);
      if (field) return field;
      ancestor = ancestor.parentElement;
    }
    return undefined;
  }

  /** This form's native controls that participate in constraint validation. */
  get #controls(): ValidatableControl[] {
    const controls: ValidatableControl[] = [];
    for (const element of Array.from(this.element.elements)) {
      if (this.#isValidatable(element)) controls.push(element);
    }
    return controls;
  }

  /** Narrows an event target to a validatable control. */
  #controlFrom(target: EventTarget | null): ValidatableControl | null {
    return target instanceof Element && this.#isValidatable(target) && target.form === this.element
      ? target
      : null;
  }

  #isValidatable(element: Element): element is ValidatableControl {
    return (
      (element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement) &&
      // `willValidate` already excludes disabled, read-only, input[type=hidden],
      // and button-type controls. The `hidden` attribute intentionally does not
      // bar a text mirror from constraint validation.
      element.willValidate
    );
  }
}
