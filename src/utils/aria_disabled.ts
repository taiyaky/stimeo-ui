/**
 * Whether `element` or one of its ancestors carries `aria-disabled="true"`.
 *
 * WAI-ARIA defines the state for an element and all of its focusable descendants
 * (https://www.w3.org/TR/wai-aria-1.2/#aria-disabled), so an element inside one
 * that carries it is disabled whatever it carries itself — `aria-disabled="false"`
 * on the element does not lift it. Only the value `"true"` disables. The walk
 * follows parent elements to the top of the element's tree, the document element
 * for an element in a document.
 *
 * `aria-disabled` keeps an element focusable and reachable, so this answers whether
 * it may be *activated*, not whether it may take focus.
 */
export function isAriaDisabled(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.getAttribute("aria-disabled") === "true") return true;
  }
  return false;
}
