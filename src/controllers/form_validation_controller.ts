import { Controller } from "@hotwired/stimulus";
import { FOCUSABLE } from "../utils/focus_trap";
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
const MESSAGE_ATTR_PREFIX = "data-stimeo--form-field-message-";
/** Attribute for a generic message override applied to any failing constraint. */
const MESSAGE_ATTR_GENERIC = "data-stimeo--form-field-message";
/** Attribute opting a control into a declarative custom rule (`"whitespace"`). */
const DISALLOW_ATTR = "data-stimeo--form-field-disallow";
/** Default message when `disallow="whitespace"` fails and no override is given. */
const DISALLOW_WHITESPACE_DEFAULT = "Please enter a value that is not only whitespace.";

/** A field's validatable controls, grouped so the whole field validates together. */
interface FieldGroup {
  readonly field: FormFieldController | undefined;
  readonly controls: ValidatableControl[];
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
 *       <p role="alert" hidden data-stimeo--form-field-target="error"></p>
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
 * @remarks
 * Behavior only — validation **rules** stay in the markup (native HTML
 * constraints: `required`, `type`, `pattern`, `min`/`max`, …) or in the consumer's
 * own `setCustomValidity()` calls, which `checkValidity()` surfaces transparently.
 * It sets the form's `novalidate` so it can replace the browser's default error
 * bubbles with the accessible, in-page `role="alert"` regions, and restores the
 * attribute on disconnect.
 *
 * Two declarative escape hatches let a field **exceed** native validation with no
 * consumer JS (author them on the control):
 * - **Per-constraint messages** — `data-stimeo--form-field-message-<constraint>`
 *   (`value-missing`, `too-short`, `too-long`, `pattern-mismatch`, `type-mismatch`,
 *   `range-overflow`, `range-underflow`, `step-mismatch`, `bad-input`), or a generic
 *   `data-stimeo--form-field-message` fallback, override the shown text per failing
 *   `ValidityState` flag — controlled, localizable wording that also fixes headless
 *   browsers returning an empty native `validationMessage`. Falls back to native.
 * - **`data-stimeo--form-field-disallow="whitespace"`** — a built-in custom rule
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

  /** Controls already interacted with — the gate for blur / input (re)validation. */
  readonly #touched = new WeakSet<ValidatableControl>();

  /**
   * Controls whose `customError` *we* set via the `disallow` rule. Tracked so we
   * only ever clear our own custom validity — a consumer's `setCustomValidity` on
   * the same control survives once our rule passes (don't-clobber-authored-state).
   */
  readonly #ownedCustomError = new WeakSet<ValidatableControl>();

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
    const control = this.#controlFrom(event.target);
    if (!control) return;
    // Focus moving *within* the same field (e.g. between members of a radio
    // group) is not leaving it — defer validation until focus actually exits.
    const field = this.#fieldFor(control);
    const related = event.relatedTarget;
    if (field && related instanceof Node && field.element.contains(related)) return;
    this.#touched.add(control);
    this.#validateControl(control);
  };

  readonly #onInput = (event: Event): void => {
    if (!this.revalidateOnInputValue) return;
    const control = this.#controlFrom(event.target);
    // Only re-validate a field the user has already left once, so the first
    // keystroke never eagerly flags a control they are still filling in.
    if (!control || !this.#touched.has(control)) return;
    this.#validateControl(control);
  };

  readonly #onChange = (event: Event): void => {
    if (!this.validateOnChangeValue) return;
    const control = this.#controlFrom(event.target);
    if (!control) return;
    // change marks a *committed* interaction (a picked option, a toggled box, a
    // widget writing its mirror), so unlike input it both touches and validates.
    this.#touched.add(control);
    this.#validateControl(control);
  };

  /** Suppresses native bubbles and binds the submit / blur / input listeners. */
  override connect(): void {
    if (!this.element.hasAttribute("novalidate")) {
      this.element.setAttribute("novalidate", "");
      this.element.setAttribute(FormValidationController.#NOVALIDATE_MARKER, "");
    }
    // Capture phase on the document so we run before any submit listener bound to
    // the form itself (Stimulus actions, submit-once), whose relative order in the
    // target phase would otherwise be unpredictable.
    document.addEventListener("submit", this.#onSubmit, true);
    this.element.addEventListener("focusout", this.#onFocusOut);
    this.element.addEventListener("input", this.#onInput);
    this.element.addEventListener("change", this.#onChange);
  }

  /** Tears down listeners and restores `novalidate` if we added it. */
  override disconnect(): void {
    document.removeEventListener("submit", this.#onSubmit, true);
    this.element.removeEventListener("focusout", this.#onFocusOut);
    this.element.removeEventListener("input", this.#onInput);
    this.element.removeEventListener("change", this.#onChange);
    if (this.element.hasAttribute(FormValidationController.#NOVALIDATE_MARKER)) {
      this.element.removeAttribute("novalidate");
      this.element.removeAttribute(FormValidationController.#NOVALIDATE_MARKER);
    }
  }

  /**
   * Validates every control now, rendering or clearing each field's message, and
   * returns whether the whole form is valid. Marks every control touched so a
   * later input re-validates it. Bound via `data-action`
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
    const groups = new Map<unknown, FieldGroup>();
    for (const control of this.#controls) {
      this.#touched.add(control);
      const field = this.#fieldFor(control);
      const key = this.#keyFor(control, field);
      const group = groups.get(key);
      if (group) {
        group.controls.push(control);
      } else {
        groups.set(key, { field, controls: [control] });
      }
    }

    const invalid: ValidatableControl[] = [];
    for (const group of groups.values()) {
      const firstInvalid = this.#applyGroup(group);
      if (firstInvalid) invalid.push(firstInvalid);
    }
    return invalid;
  }

  /** Re-validates the whole field a single control belongs to (or that control). */
  #validateControl(control: ValidatableControl): void {
    const field = this.#fieldFor(control);
    const key = this.#keyFor(control, field);
    const controls = this.#controls.filter(
      (other) => this.#keyFor(other, this.#fieldFor(other)) === key,
    );
    this.#applyGroup({ field, controls });
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
        group.field.setError(this.#messageFor(firstInvalid));
      } else {
        group.field.clearError();
      }
    }
    return firstInvalid;
  }

  /**
   * Resolves the message to show for an invalid control: a per-constraint
   * override (`data-stimeo--form-field-message-<constraint>`) for the first failing
   * `ValidityState` flag, then a generic `data-stimeo--form-field-message`
   * override, then the browser's native `validationMessage`. Authoring an override
   * gives controlled, localizable, theme-able wording with **no consumer JS** —
   * and sidesteps headless browsers that return an empty native message.
   */
  #messageFor(control: ValidatableControl): string {
    for (const [flag, key] of CONSTRAINT_MESSAGE_KEYS) {
      if (control.validity[flag]) {
        return (
          control.getAttribute(`${MESSAGE_ATTR_PREFIX}${key}`) ??
          control.getAttribute(MESSAGE_ATTR_GENERIC) ??
          control.validationMessage
        );
      }
    }
    // customError (our `disallow` rule, or a consumer's setCustomValidity): for our
    // rule the message was already resolved with per-constraint > generic > default
    // precedence when set, and a consumer error carries its own text — so return the
    // live validationMessage as-is, falling back to the generic override then "".
    return control.validationMessage || control.getAttribute(MESSAGE_ATTR_GENERIC) || "";
  }

  /**
   * Applies (or clears) a declarative custom constraint via `setCustomValidity`,
   * for controls that opt in with `data-stimeo--form-field-disallow`. The one
   * supported rule today is `"whitespace"` — a value that is non-empty but blank
   * after trimming (which slips past `required` / `minlength`); its message follows
   * the per-constraint (`value-missing`) → generic → default chain.
   *
   * Don't-clobber-authored-state: an unknown/absent rule is never touched, and a
   * custom error is only cleared when *we* set it (tracked in {@link #ownedCustomError}),
   * so a consumer's own `setCustomValidity` on the same control survives.
   */
  #syncCustomValidity(control: ValidatableControl): void {
    const violates =
      control.getAttribute(DISALLOW_ATTR) === "whitespace" &&
      control.value.length > 0 &&
      control.value.trim() === "";
    if (violates) {
      control.setCustomValidity(
        control.getAttribute(`${MESSAGE_ATTR_PREFIX}value-missing`) ??
          control.getAttribute(MESSAGE_ATTR_GENERIC) ??
          DISALLOW_WHITESPACE_DEFAULT,
      );
      this.#ownedCustomError.add(control);
    } else if (this.#ownedCustomError.has(control)) {
      // Only clear the custom error we previously set; leave a consumer's intact.
      this.#ownedCustomError.delete(control);
      control.setCustomValidity("");
    }
  }

  /**
   * A grouping key that collects controls belonging to the same field: the owning
   * `stimeo--form-field` when present, else a radio group's shared `name`, else
   * the control itself (always distinct).
   */
  #keyFor(control: ValidatableControl, field: FormFieldController | undefined): unknown {
    if (field) return field;
    if (control instanceof HTMLInputElement && control.type === "radio" && control.name) {
      return `radio:${control.name}`;
    }
    return control;
  }

  /**
   * Where focus should land for an invalid control. A visible control is focused
   * directly (status quo for native fields and radios). A validatable mirror
   * (the `hidden` attribute) cannot receive focus, so focus is delegated to the
   * visible widget: the owning field's `control` target when it is itself
   * focusable, else its first focusable descendant (e.g. a roving-tabindex
   * member). Resolved structurally — never by probing `focus()` — so behavior
   * is deterministic and CSS-independent.
   */
  #focusTargetFor(control: ValidatableControl): HTMLElement | null {
    if (!control.hidden) return control;
    const field = this.#fieldFor(control);
    if (!field?.hasControlTarget) return null;
    const root = field.controlTarget;
    if (root.matches(FOCUSABLE)) return root;
    return root.querySelector<HTMLElement>(FOCUSABLE);
  }

  /** The `stimeo--form-field` outlet whose element contains `control`, if any. */
  #fieldFor(control: ValidatableControl): FormFieldController | undefined {
    const elements = this.stimeoFormFieldOutletElements;
    for (let index = 0; index < elements.length; index++) {
      if (elements[index]?.contains(control)) return this.stimeoFormFieldOutlets[index];
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
    return target instanceof Element && this.#isValidatable(target) ? target : null;
  }

  #isValidatable(element: Element): element is ValidatableControl {
    return (
      (element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement) &&
      // `willValidate` already excludes disabled, read-only, hidden, and button
      // controls — the exact set barred from constraint validation.
      element.willValidate
    );
  }
}
