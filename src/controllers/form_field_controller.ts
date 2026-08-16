import { Controller } from "@hotwired/stimulus";
import { announce } from "../utils/announce";
import { ensureId } from "../utils/aria_ids";
import { AttributeLease } from "../utils/attribute_lease";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

/** Stimulus action params understood by {@link FormFieldController.setError}. */
interface SetErrorParams {
  /** The error message to display. */
  message?: string;
}

/** An action event carrying Stimulus `data-*-param` values. */
type ActionEvent = Event & { params?: SetErrorParams };

/** Programmatic behavior switches for {@link FormFieldController.setError}. */
export interface FormFieldSetErrorOptions {
  /** Override the `focusOnError` Value for this call. */
  focus?: boolean;
}

/** Detail dispatched with `stimeo--form-field:validate`. */
export interface FormFieldValidateDetail {
  /** Whether the explicit validation action left the field valid. */
  valid: boolean;
  /** The first visible error message, or an empty string when valid/unavailable. */
  message: string;
}

/** Attributes on retained association targets that can change the ARIA graph. */
const OBSERVED_ATTRIBUTES = ["hidden", "id"];

/**
 * Headless, accessible form-field association behavior.
 *
 * Markup contract (identifier: `stimeo--form-field`):
 *   <div data-controller="stimeo--form-field">
 *     <label for="email">Email</label>
 *     <input id="email" type="email" aria-invalid="false"
 *            data-stimeo--form-field-target="control" />
 *     <p data-stimeo--form-field-target="description">We'll send a confirmation.</p>
 *     <p hidden data-stimeo--form-field-target="error"></p>
 *   </div>
 *
 * Not an APG widget pattern — this is the wiring substrate behind form controls:
 * it supports **Name, Role, Value** (WCAG 4.1.2) and **error identification**
 * (3.3.1 / 4.1.3) by composing the control's `aria-describedby`, toggling
 * `aria-invalid`, and pointing `aria-errormessage` at the visual error.
 *
 * `validate` dispatches `{ valid: boolean, message: string }`.
 *
 * @remarks
 * Behavior only — it sets semantic attributes and the `hidden` state of the
 * visual error; it never validates input (the consumer / server decides) and
 * never styles. Runtime errors are handed to a separately seated
 * `stimeo--announcer`, because showing a live region together with its first
 * message is not a reliable announcement primitive.
 *
 * Behavior provided:
 * - Assigns ids to description/error targets and composes the control's
 *   `aria-describedby` from them in DOM order (preserving the control's authored
 *   tokens and removing duplicates).
 * - Reflects server-rendered errors: an error target that is already visible and
 *   non-empty at connect puts the field into the invalid state (progressive
 *   enhancement).
 * - Reconciles added, removed, replaced, and retained/morphed targets without
 *   emitting validation events or announcements.
 * - {@link setError} / {@link clearError} drive the invalid state at runtime and
 *   dispatch `stimeo--form-field:validate`.
 */
export class FormFieldController extends Controller<HTMLElement> {
  static override targets = ["control", "description", "error"];
  static override values = {
    focusOnError: { type: Boolean, default: false },
  };
  static actions = ["clearError", "setError"] as const;
  static events = ["validate"] as const;

  declare readonly controlTarget: HTMLElement;
  declare readonly hasControlTarget: boolean;
  declare readonly descriptionTargets: HTMLElement[];
  declare readonly errorTargets: HTMLElement[];
  declare readonly hasErrorTarget: boolean;
  /** Whether an explicit {@link setError} call moves focus to the current control. */
  declare focusOnErrorValue: boolean;

  /** Root attribute (CSS hook) reflecting the invalid state. */
  static readonly #INVALID_ATTR = "data-stimeo--form-field-invalid";

  /** Collapses one target/morph batch into one silent ARIA reconciliation. */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileDom());
  /** ARIA ownership is scoped to the current singular control target. */
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());
  readonly #ariaDescribedBy = new AttributeLease<HTMLElement>("aria-describedby");
  readonly #ariaErrorMessage = new AttributeLease<HTMLElement>("aria-errormessage");
  readonly #ariaInvalid = new AttributeLease<HTMLElement>("aria-invalid");
  /** Watches retained target ids, error visibility, and error content. */
  readonly #observer = new MutationObserver((records) => {
    if (records.some((record) => this.#isRelevantMutation(record))) {
      this.#reconcile.schedule();
    }
  });

  #activeControl: HTMLElement | null = null;
  #baseDescribedBy: string[] = [];
  #explicitInvalid = false;
  #initialized = false;

  /** Wires the initial graph and starts retained-target reconciliation. */
  override connect(): void {
    this.#reconcile.activate();
    this.#ensureAssociationIds();
    this.#beforeCache.activate();

    // A restored DOM can contain the invalid hook with no surviving visual
    // message. Treat that one shape as the persisted explicit setError state;
    // visible server errors remain derived and can clear when their DOM clears.
    if (!this.#initialized) {
      this.#explicitInvalid =
        this.element.hasAttribute(FormFieldController.#INVALID_ATTR) &&
        this.#shownErrors().length === 0;
      this.#initialized = true;
    }

    this.#reconcileDom();
    this.#observer.observe(this.element, {
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  /** Releases observers, queued work, and ARIA borrowed on the current control. */
  override disconnect(): void {
    this.#reconcile.cancel();
    this.#observer.disconnect();
    this.#beforeCache.deactivate();
    this.#activeControl && this.#releaseControl(this.#activeControl);
  }

  /** Reconciles a control inserted or replaced at runtime. */
  controlTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Schedules restoration of authored ARIA when a control leaves this field. */
  controlTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Reconciles a description inserted or replaced at runtime. */
  descriptionTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Removes a departed description from the control's association graph. */
  descriptionTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Reconciles an error region inserted or replaced at runtime. */
  errorTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Removes a departed error from invalid state and the association graph. */
  errorTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /**
   * Marks the field invalid and shows the error message. Bound via `data-action`
   * (`#setError`) or callable directly.
   *
   * A non-empty shown message is announced exactly once through the shared
   * assertive announcer. Initial/server reconciliation is deliberately silent.
   *
   * @param arg - Either the message string, or the action event whose
   *   `data-stimeo--form-field-message-param` supplies it. When no message is
   *   resolvable, any already-populated error targets are simply (re)shown.
   * @param options - Programmatic overrides. Stimulus actions use the Values.
   */
  setError(arg?: string | ActionEvent, options: FormFieldSetErrorOptions = {}): void {
    const message = this.#resolveMessage(arg);
    if (message !== null && this.hasErrorTarget) {
      this.errorTargets[0]?.replaceChildren(document.createTextNode(message));
    }
    for (const error of this.errorTargets) {
      error.hidden = (error.textContent ?? "").trim() === "";
    }

    // setError is an explicit invalid request: it remains invalid even if an
    // error target is absent or replaced before clearError is called.
    this.#explicitInvalid = true;
    this.#reconcileDom();
    const shownMessage = this.#shownMessage();
    const detail: FormFieldValidateDetail = { valid: false, message: shownMessage };
    this.dispatch("validate", { detail });
    announce(shownMessage, { assertive: true });

    if (options.focus ?? this.focusOnErrorValue) this.#activeControl?.focus();
  }

  /**
   * Clears the error: empties and hides every error target and marks the field
   * valid. Bound via `data-action` (`#clearError`) or callable directly.
   *
   * Clearing is silent: the visual/ARIA state and validation event are sufficient,
   * while success wording remains an explicit consumer announcement.
   */
  clearError(): void {
    for (const error of this.errorTargets) {
      error.replaceChildren();
      error.hidden = true;
    }
    this.#explicitInvalid = false;
    this.#reconcileDom();
    const detail: FormFieldValidateDetail = { valid: true, message: "" };
    this.dispatch("validate", { detail });
  }

  /**
   * Rebuilds ids and derived ARIA from the settled target graph without reporting
   * a user validation action.
   */
  #reconcileDom(): void {
    this.#ensureAssociationIds();
    this.#adoptCurrentControl();

    const shown = this.#shownErrors();
    const invalid = this.#explicitInvalid || shown.length > 0;
    this.element.toggleAttribute(FormFieldController.#INVALID_ATTR, invalid);

    const control = this.#activeControl;
    if (!control) return;

    this.#ariaInvalid.write(control, invalid ? "true" : "false");

    const primaryErrorId = shown[0]?.id ?? null;
    this.#ariaErrorMessage.write(control, primaryErrorId);

    const associationIds = this.#orderedElements([...this.descriptionTargets, ...shown]).map(
      (element) => element.id,
    );
    const describedBy = this.#uniqueTokens([...this.#baseDescribedBy, ...associationIds]);
    this.#ariaDescribedBy.write(control, describedBy.length > 0 ? describedBy.join(" ") : null);
  }

  /** Assigns stable ids before either capture or reflection uses them. */
  #ensureAssociationIds(): void {
    for (const description of this.descriptionTargets) {
      ensureId(description, "stimeo--form-field-desc");
    }
    for (const error of this.errorTargets) {
      ensureId(error, "stimeo--form-field-error");
    }
  }

  /** Switches ARIA ownership when the singular current control target changes. */
  #adoptCurrentControl(): void {
    const next = this.hasControlTarget ? this.controlTarget : null;
    if (next === this.#activeControl) return;
    this.#activeControl && this.#releaseControl(this.#activeControl);
    this.#activeControl = next;
    this.#baseDescribedBy = next ? this.#externalDescribedByTokens(next) : [];
  }

  /** Restores one departed control without overwriting later consumer edits. */
  #releaseControl(control: HTMLElement): void {
    this.#ariaDescribedBy.return(control);
    this.#ariaErrorMessage.return(control);
    this.#ariaInvalid.return(control);
    if (control === this.#activeControl) {
      this.#activeControl = null;
      this.#baseDescribedBy = [];
    }
  }

  /** Error targets currently visible and non-empty, in document order. */
  #shownErrors(): HTMLElement[] {
    return this.#orderedElements(
      this.errorTargets.filter((error) => !error.hidden && (error.textContent ?? "").trim() !== ""),
    );
  }

  /** Text of the first shown error, for validation detail and announcement. */
  #shownMessage(): string {
    return (this.#shownErrors()[0]?.textContent ?? "").trim();
  }

  /** Resolves a message from a string argument or an action event's params. */
  #resolveMessage(arg?: string | ActionEvent): string | null {
    if (typeof arg === "string") return arg;
    const message = arg?.params?.message;
    return typeof message === "string" ? message : null;
  }

  /**
   * Tokens authored on a newly adopted control, excluding ids this controller
   * owns through its current description/error targets.
   */
  #externalDescribedByTokens(control: HTMLElement): string[] {
    const owned = new Set([
      ...this.descriptionTargets.map((description) => description.id),
      ...this.errorTargets.map((error) => error.id),
    ]);
    const existing = control.getAttribute("aria-describedby") ?? "";
    return this.#uniqueTokens(
      existing.split(/\s+/).filter((token) => token.length > 0 && !owned.has(token)),
    );
  }

  /** Deduplicates ARIA tokens without disturbing their first occurrence. */
  #uniqueTokens(tokens: string[]): string[] {
    const seen = new Set<string>();
    return tokens.filter((token) => {
      if (token.length === 0 || seen.has(token)) return false;
      seen.add(token);
      return true;
    });
  }

  /** Returns unique current targets in DOM order before serializing IDREF lists. */
  #orderedElements(elements: HTMLElement[]): HTMLElement[] {
    const candidates = new Set(elements);
    return [this.element, ...this.element.querySelectorAll<HTMLElement>("*")].filter((element) =>
      candidates.has(element),
    );
  }

  /** Whether one retained-node mutation can alter this controller's derived state. */
  #isRelevantMutation(record: MutationRecord): boolean {
    const target = record.target;
    if (record.type === "attributes") {
      if (record.attributeName === "hidden")
        return this.errorTargets.includes(target as HTMLElement);
      return (
        record.attributeName === "id" &&
        [...this.descriptionTargets, ...this.errorTargets].includes(target as HTMLElement)
      );
    }

    return this.errorTargets.some((error) => error === target || error.contains(target));
  }
  /** Returns borrowed control ARIA before Turbo snapshots the page. */
  #rewindForCache(): void {
    this.#ariaDescribedBy.returnAll();
    this.#ariaErrorMessage.returnAll();
    this.#ariaInvalid.returnAll();
  }
}
