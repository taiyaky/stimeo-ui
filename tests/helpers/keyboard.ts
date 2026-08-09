/**
 * Shared keyboard helpers for tests.
 *
 * The rule they exist to make cheap: a keyboard test focuses the element
 * **before** pressing. Dispatching a key at an element that never held focus
 * (a) skips any implementation path that reads `document.activeElement`,
 * (b) makes the *result* of a focus move unassertable, and (c) diverges from a
 * real browser in exactly the direction that hides bugs.
 *
 * Two details are easy to get wrong by hand, which is why they live here rather
 * than in per-suite wrappers:
 *
 * - **`cancelable: true`.** `new KeyboardEvent("keydown", { bubbles: true })`
 *   defaults `cancelable` to `false`, so a child's `preventDefault()` never sets
 *   `defaultPrevented` and a case meant to exercise a yielding guard exercises
 *   nothing. Every helper here sets it, and returns the event so that
 *   `defaultPrevented` is assertable.
 * - **Modifiers are ordinary init fields.** Passing them through keeps
 *   "`Alt+ArrowRight` is left to the browser" writable without a second helper.
 *
 * These wrap the DOM directly rather than driving a Stimulus action, so they work
 * whether the controller binds per-element or delegates from a container.
 *
 * @example
 * ```ts
 * const event = press(byId("item-2"), "ArrowDown");
 * expect(event.defaultPrevented).toBe(true);
 * expect(document.activeElement).toBe(byId("item-3"));
 * ```
 */

/**
 * Focuses `element`, then dispatches a cancelable `keydown` on it.
 *
 * @param element - the element that should hold focus when the key arrives
 * @param key - the `KeyboardEvent.key` value (`"ArrowDown"`, `"Enter"`, `"a"`, …)
 * @param init - extra event fields, typically modifiers (`{ altKey: true }`)
 * @returns the dispatched event, so `defaultPrevented` can be asserted
 */
export function press(
  element: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  element.focus();
  return typeKey(element, key, init);
}

/**
 * Dispatches a cancelable `keydown` **without** moving focus first.
 *
 * For the cases where the press deliberately comes from somewhere else — a
 * document-level shortcut, a key aimed at an element that must *not* be focused,
 * or a widget whose focus is virtual (`aria-activedescendant`). Reach for
 * {@link press} unless the test is about one of those.
 *
 * @param target - the event target (an element or `document`)
 * @param key - the `KeyboardEvent.key` value
 * @param init - extra event fields, typically modifiers
 * @returns the dispatched event, so `defaultPrevented` can be asserted
 */
export function typeKey(
  target: EventTarget,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}
