import { stateReasonFor } from "./state_reason";

/** The DOM binding and origin of a public action, or its explicit API element. */
export interface ActionSource {
  readonly event: Event | null;
  readonly host: Element | null;
  readonly origin: Element | null;
  readonly reason: ReturnType<typeof stateReasonFor>;
}

/**
 * Normalizes an action's DOM event or explicit element without choosing an owned target.
 *
 * Event hosts and origins stay separate so consumers can yield to nested controls.
 * An explicit element supplies both, with no DOM event and an `"api"` reason.
 * Consumers resolve current targets and enforce their own scope and interaction rules.
 *
 * @param source - The DOM event, explicit element, or absent optional argument.
 * @returns The source elements, original event and public interaction reason.
 */
export function actionSource(source?: Event | HTMLElement): ActionSource {
  if (source instanceof HTMLElement) {
    return { event: null, host: source, origin: source, reason: "api" };
  }
  const event = source ?? null;
  return {
    event,
    host: event?.currentTarget instanceof Element ? event.currentTarget : null,
    origin: event?.target instanceof Element ? event.target : null,
    reason: stateReasonFor(event),
  };
}
