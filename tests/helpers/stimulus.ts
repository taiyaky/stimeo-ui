import type { Application } from "@hotwired/stimulus";

/**
 * Disconnects every controller context before stopping Stimulus.
 *
 * `Application.stop()` only stops root observation and action dispatching; it
 * leaves connected contexts active. Unloading each connected identifier runs
 * the full Stimulus context teardown: the controller `disconnect()` hook plus
 * binding, value, target, and outlet observer cleanup.
 */
export const disconnectAndStopApplication = (application: Application): void => {
  const identifiers = [...new Set(application.controllers.map(({ identifier }) => identifier))];
  if (identifiers.length > 0) application.unload(identifiers);

  application.stop();
};
