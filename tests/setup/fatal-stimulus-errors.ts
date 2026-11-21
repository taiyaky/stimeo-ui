import { Application } from "@hotwired/stimulus";
import { afterAll, afterEach } from "vitest";

/** What a test fails with when a Stimulus application caught an error from a controller. */
class StimulusCaughtError extends Error {
  override name = "StimulusCaughtError";
}

/** An error a Stimulus application caught, with what Stimulus said it was doing. */
interface CaughtError {
  readonly error: unknown;
  readonly during: string;
}

/** The errors caught since the last check, oldest first. */
const caught: CaughtError[] = [];

/**
 * Records an error a Stimulus application caught from a controller, in place of
 * Stimulus's own `Application#handleError`.
 *
 * Stimulus catches what a controller throws from `initialize`, `connect`,
 * `disconnect` or an action, hands it to `handleError` and carries on. Its own
 * handler logs the error and calls `window.onerror`, so a test of a throwing
 * controller passes unless an assertion happens to observe the difference. That
 * log also formats the controller and its element with `%o`, which under happy-dom
 * walks into the window's interface prototypes, where Node's `util.inspect` reads
 * an `href` getter that throws, and that error then reaches the test in place of
 * the controller's.
 *
 * This records the error and the identifier Stimulus names, formats nothing else
 * and calls no `window.onerror`: the test's failure is the report. After the
 * test's own `afterEach` hooks, the test fails with a {@link StimulusCaughtError}
 * whose cause is the first error recorded since the previous test's check — in
 * the test, in its hooks, or before it in the file; one recorded after the last
 * test fails the file. A test that expects a caught error assigns or spies on
 * `handleError` of its own application, which shadows this one.
 */
function recordCaughtError(
  error: unknown,
  message: string,
  detail?: { readonly identifier?: unknown },
): void {
  const identifier = detail?.identifier;
  const during = typeof identifier === "string" ? `${message} [${identifier}]` : message;
  caught.push({ error, during });
}

Application.prototype.handleError = recordCaughtError;

/** Throws for the first error recorded since the last check, and forgets every one of them. */
const failOnCaughtError = (): void => {
  const [first, ...rest] = caught.splice(0);
  if (first === undefined) return;
  const { error, during } = first;
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const count = rest.length > 0 ? ` (first of ${rest.length + 1})` : "";
  throw new StimulusCaughtError(`${during}${count}: ${text}`, { cause: error });
};

afterEach(failOnCaughtError);
afterAll(failOnCaughtError);
