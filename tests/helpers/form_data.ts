/**
 * Constructs data and synchronously delivers the formdata event missing in happy-dom.
 * The event carries the same FormData object that this function returns.
 */
export function dispatchFormData(form: HTMLFormElement): FormData {
  const data = new FormData(form);
  const event = new Event("formdata", { bubbles: true });
  Object.defineProperty(event, "formData", { value: data });
  form.dispatchEvent(event);
  return data;
}
