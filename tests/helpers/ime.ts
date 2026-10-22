/**
 * Shared IME helpers for tests.
 *
 * An IME writes its draft into the composing field and the engine reports each
 * write with an `input` that names the composition: `inputType`
 * `insertCompositionText`, `isComposing: true`. `CompositionTracker` follows
 * the field's text from those inputs, so a test that writes a draft and reports
 * it with a bare `input` models a script's write instead, and the composition
 * ends there. A test that means the IME uses {@link composeDraft}.
 */

/** A field an IME composes in. */
type ComposingField = HTMLInputElement | HTMLTextAreaElement;

/** Writes the IME's `draft` into `field` and dispatches the `input` the engine sends for it. */
export function composeDraft(field: ComposingField, draft: string): InputEvent {
  field.value = draft;
  const event = new InputEvent("input", {
    bubbles: true,
    inputType: "insertCompositionText",
    isComposing: true,
    data: draft,
  });
  field.dispatchEvent(event);
  return event;
}
