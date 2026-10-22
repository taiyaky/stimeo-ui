/**
 * Reflects a serialized attribute value only when the current value differs.
 *
 * A same-value `setAttribute` still queues a mutation record for every observer, so an
 * unchanged value writes nothing.
 *
 * @param element - The element whose attribute is reflected.
 * @param name - The attribute name, using the non-namespaced DOM API.
 * @param value - The serialized value, or null to remove the attribute.
 * @param beforeWrite - Called only for a change, before the DOM mutation, so the
 * caller can record ownership or identify its own observer records.
 * @returns Whether an attribute was written or removed.
 */
export function setAttributeIfChanged(
  element: Element,
  name: string,
  value: string | null,
  beforeWrite?: () => void,
): boolean {
  if (element.getAttribute(name) === value) return false;
  beforeWrite?.();
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
  return true;
}
