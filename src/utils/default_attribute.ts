/**
 * Adds an attribute default without displacing an authored value.
 *
 * Attribute presence — including an authored empty string — is the ownership
 * boundary. The return value lets a caller remember that it supplied the
 * default when that caller must later restore the authored state.
 *
 * @param element - Element that owns the attribute
 * @param name - Attribute name
 * @param value - Value to write only when the attribute is absent
 * @returns Whether this call added the attribute
 */
export function setDefaultAttribute(element: Element, name: string, value: string): boolean {
  if (element.hasAttribute(name)) return false;
  element.setAttribute(name, value);
  return true;
}
