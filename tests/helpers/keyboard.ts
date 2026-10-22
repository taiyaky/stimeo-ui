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
 *   nothing. Helpers default it to true and return the dispatched event so that
 *   `defaultPrevented` is assertable. Explicit init overrides are preserved.
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
 * Focuses `element`, checks that it holds focus, then dispatches the key event.
 * String keys create a cancelable `keydown`; prepared events retain their phase,
 * flags and any prior cancellation. Create a fresh event for each separate press.
 *
 * @param element - the element that should hold focus when the key arrives
 * @param key - the key value or an event prepared with {@link keyEvent}
 * @param init - extra fields for a string key, typically modifiers (`{ altKey: true }`)
 * @returns the dispatched event, so `defaultPrevented` can be asserted
 * @throws if the element cannot hold focus when dispatch would start
 */
export function press(
  element: HTMLElement,
  key: string | KeyboardEvent,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  element.focus();
  const root = element.getRootNode();
  if (!("activeElement" in root) || root.activeElement !== element) {
    throw new Error("press() requires a connected element that can hold focus");
  }
  return typeKey(element, key, init);
}

/**
 * Dispatches a key event **without** moving focus first.
 * String keys create a cancelable `keydown`; prepared events are dispatched intact.
 *
 * For the cases where the press deliberately comes from somewhere else — a
 * document-level shortcut, a key aimed at an element that must *not* be focused,
 * or a widget whose focus is virtual (`aria-activedescendant`). Reach for
 * {@link press} unless the test is about one of those.
 *
 * @param target - the event target (an element or `document`)
 * @param key - the key value or an event prepared with {@link keyEvent}
 * @param init - extra fields for a string key, typically modifiers
 * @returns the dispatched event, so `defaultPrevented` can be asserted
 */
export function typeKey(
  target: EventTarget,
  key: string | KeyboardEvent,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = typeof key === "string" ? keyEvent(key, init) : key;
  target.dispatchEvent(event);
  return event;
}

/**
 * Creates a keyboard event without focusing or dispatching it.
 *
 * Use this for a pure event predicate, a direct action invocation, or an event
 * that must be claimed before dispatch. DOM keyboard interactions use
 * {@link press}; deliberately unfocused dispatches use {@link typeKey}.
 *
 * @param key - the `KeyboardEvent.key` value
 * @param init - event fields; bubbling and cancellation default to true
 * @param type - the keyboard event phase
 * @returns a fresh, undispatched event
 */
export function keyEvent(
  key: string,
  init: KeyboardEventInit = {},
  type: "keydown" | "keyup" = "keydown",
): KeyboardEvent {
  return new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init });
}
