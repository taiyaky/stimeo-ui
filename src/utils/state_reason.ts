/**
 * Why a component's public open/closed state moved, carried as `detail.reason`
 * on the state event that reports the move.
 *
 * The attribute a component publishes (`aria-expanded`, `hidden`, `data-state`)
 * only says *what* the state is now. A subscriber that mirrors the state
 * elsewhere, or reports it, needs *why*: closing on `Escape` and closing because
 * the consumer called the action are the same attribute write and different
 * events to the page around it.
 *
 * `"api"` is the one every subscriber has to look at. A close the consumer asked
 * for arrives back at their own listener, so a listener that closes something
 * else on `close` loops unless it ignores its own calls.
 *
 * | Reason | The state moved because |
 * | --- | --- |
 * | `"user"` | a control of this component was operated |
 * | `"select"` | an item inside it was activated |
 * | `"escape"` | `Escape` was pressed and this layer owned it |
 * | `"outside"` | a pointer landed outside it, or on its backdrop |
 * | `"focus"` | focus entered or left it |
 * | `"pointer"` | the pointer entered or left it |
 * | `"scroll"` | a tracked scroll container scrolled |
 * | `"api"` | a public action was called with no DOM event |
 */
export type StateReason =
  | "user"
  | "select"
  | "escape"
  | "outside"
  | "focus"
  | "pointer"
  | "scroll"
  | "api";

/** Focus modality: the events a focus move delivers to an action. */
const FOCUS_EVENTS = new Set(["blur", "focus", "focusin", "focusout"]);

/** Pointer modality: the crossing events an action is bound to for hover. */
const POINTER_EVENTS = new Set(["mouseenter", "mouseleave", "pointerenter", "pointerleave"]);

/**
 * Reads the interaction behind a **public action** from the DOM event it was
 * handed.
 *
 * Stimulus always passes the event to an action it invoked from `data-action`,
 * and a consumer calling the method themselves passes nothing — which is what
 * separates `"api"` from the rest.
 *
 * Only an action entry may resolve a reason this way. Inside the component the
 * event type no longer identifies the interaction: one `click` is the trigger
 * being pressed, the page outside being pressed, and an item being activated,
 * and those paths pass their own reason instead.
 *
 * @param event - The event the action received, if any.
 * @returns `"api"` with no event, else the modality the event type names, else
 *   `"user"`.
 *
 * @example
 * ```ts
 * toggle(event?: Event): void {
 *   this.#apply(!this.#isOpen, stateReasonFor(event));
 * }
 * ```
 */
export function stateReasonFor(event?: Event | null): "user" | "focus" | "pointer" | "api" {
  if (!event) return "api";
  if (FOCUS_EVENTS.has(event.type)) return "focus";
  if (POINTER_EVENTS.has(event.type)) return "pointer";
  return "user";
}
