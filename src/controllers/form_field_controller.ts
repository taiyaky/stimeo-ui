import { Controller } from "@hotwired/stimulus";
import { ensureId } from "../utils/aria_ids";

/** Stimulus action params understood by {@link FormFieldController.setError}. */
interface SetErrorParams {
  /** The error message to display. */
  message?: string;
}

/** An action event carrying Stimulus `data-*-param` values. */
type ActionEvent = Event & { params?: SetErrorParams };

/**
 * Headless, accessible form-field association behavior.
 *
 * Markup contract (identifier: `stimeo--form-field`):
 *   <div data-controller="stimeo--form-field">
 *     <label for="email">Email</label>
 *     <input id="email" type="email" aria-invalid="false"
 *            data-stimeo--form-field-target="control" />
 *     <p data-stimeo--form-field-target="description">We'll send a confirmation.</p>
 *     <p role="alert" hidden data-stimeo--form-field-target="error"></p>
 *   </div>
 *
 * Not an APG widget pattern — this is the wiring substrate behind form controls:
 * it supports **Name, Role, Value** (WCAG 4.1.2) and **error identification**
 * (3.3.1 / 4.1.3) by composing the control's `aria-describedby`, toggling
 * `aria-invalid`, and pointing `aria-errormessage` at the live error region.
 *
 * @remarks
 * Behavior only — it sets semantic attributes and the `hidden` state of the
 * error region; it never validates input (the consumer / server decides) and
 * never styles. The error target should carry `role="alert"` (or an
 * `aria-live` region) so a newly shown message is announced without moving focus.
 *
 * Behavior provided:
 * - On connect, assigns ids to description/error targets and composes the
 *   control's `aria-describedby` from them (preserving any pre-existing tokens).
 * - Reflects server-rendered errors: an error target that is already visible and
 *   non-empty at connect puts the field into the invalid state (progressive
 *   enhancement).
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
  declare focusOnErrorValue: boolean;

  /** Root attribute (CSS hook) reflecting the invalid state. */
  static readonly #INVALID_ATTR = "data-stimeo--form-field-invalid";

  /**
   * `aria-describedby` tokens the consumer set on the control that the
   * controller does not own. Captured once so composition never clobbers them.
   */
  #baseDescribedBy: string[] = [];

  /** Wires ids, captures consumer tokens, and reflects any initial error state. */
  override connect(): void {
    for (const description of this.descriptionTargets) {
      ensureId(description, "stimeo--form-field-desc");
    }
    for (const error of this.errorTargets) {
      ensureId(error, "stimeo--form-field-error");
    }
    this.#baseDescribedBy = this.#externalDescribedByTokens();
    this.#reflect();
  }

  /**
   * Marks the field invalid and shows the error message. Bound via `data-action`
   * (`#setError`) or callable directly.
   *
   * @param arg - Either the message string, or the action event whose
   *   `data-stimeo--form-field-message-param` supplies it. When no message is
   *   resolvable, any already-populated error targets are simply (re)shown.
   */
  setError(arg?: string | ActionEvent): void {
    const message = this.#resolveMessage(arg);
    if (message !== null && this.hasErrorTarget) {
      this.errorTargets[0]?.replaceChildren(document.createTextNode(message));
    }
    for (const error of this.errorTargets) {
      error.hidden = (error.textContent ?? "").trim() === "";
    }
    // setError is an explicit invalid request: mark invalid even when the field
    // has no error region (structure rules require only `control`), so the DOM
    // invalid state never disagrees with the dispatched `valid: false`.
    this.#reflect(true);
    this.dispatch("validate", { detail: { valid: false, message: this.#shownMessage() } });
    if (this.focusOnErrorValue && this.hasControlTarget) {
      this.controlTarget.focus();
    }
  }

  /**
   * Clears the error: empties and hides every error target and marks the field
   * valid. Bound via `data-action` (`#clearError`) or callable directly.
   */
  clearError(): void {
    for (const error of this.errorTargets) {
      error.replaceChildren();
      error.hidden = true;
    }
    this.#reflect();
    this.dispatch("validate", { detail: { valid: true, message: "" } });
  }

  /**
   * Synchronizes the control's ARIA wiring and the root CSS hook from the current
   * error targets. Idempotent, so it is safe to call on connect and after any
   * change (and survives Turbo morphing).
   *
   * @param force - When `true`, the field is marked invalid regardless of whether
   *   a (visible, non-empty) error region exists. {@link setError} passes this so
   *   the invalid state holds even with no error target; derivation from the DOM
   *   (connect / {@link clearError}) leaves it `false`.
   */
  #reflect(force = false): void {
    const shown = this.#shownErrors();
    const invalid = force || shown.length > 0;

    if (invalid) {
      this.element.setAttribute(FormFieldController.#INVALID_ATTR, "");
    } else {
      this.element.removeAttribute(FormFieldController.#INVALID_ATTR);
    }

    if (!this.hasControlTarget) return;
    const control = this.controlTarget;
    control.setAttribute("aria-invalid", invalid ? "true" : "false");

    const errorIds = shown.map((error) => error.id);
    // aria-errormessage references a single error element (the widely-supported
    // IDREF form); any additional errors stay in aria-describedby below.
    const primaryErrorId = errorIds[0];
    if (primaryErrorId) {
      control.setAttribute("aria-errormessage", primaryErrorId);
    } else {
      control.removeAttribute("aria-errormessage");
    }

    // Compose describedby: consumer tokens, then descriptions, then shown errors
    // (so legacy AT that ignore aria-errormessage still read the error).
    const describedBy = [
      ...this.#baseDescribedBy,
      ...this.descriptionTargets.map((description) => description.id),
      ...errorIds,
    ];
    if (describedBy.length > 0) {
      control.setAttribute("aria-describedby", describedBy.join(" "));
    } else {
      control.removeAttribute("aria-describedby");
    }
  }

  /** Error targets currently visible and non-empty. */
  #shownErrors(): HTMLElement[] {
    return this.errorTargets.filter(
      (error) => !error.hidden && (error.textContent ?? "").trim() !== "",
    );
  }

  /** Text of the first shown error, for the `validate` event detail. */
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
   * Tokens already in the control's `aria-describedby` that are not ids of this
   * controller's own description/error targets.
   */
  #externalDescribedByTokens(): string[] {
    if (!this.hasControlTarget) return [];
    const owned = new Set([
      ...this.descriptionTargets.map((description) => description.id),
      ...this.errorTargets.map((error) => error.id),
    ]);
    const existing = this.controlTarget.getAttribute("aria-describedby") ?? "";
    return existing.split(/\s+/).filter((token) => token.length > 0 && !owned.has(token));
  }
}
