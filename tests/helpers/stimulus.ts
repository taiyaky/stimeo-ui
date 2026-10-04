import { Application } from "@hotwired/stimulus";
import { tick } from "./timing";

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

/**
 * Puts a deep clone of `<body>`, taken now, in the page's place, as Turbo renders a page it
 * restores from its cache: the clone carries every attribute the controllers have written,
 * and the controllers that connect to it remember nothing of the earlier instances.
 *
 * `application` is disconnected and stopped after the clone is taken, so whatever its
 * controllers do on `disconnect()` reaches the page being left only. Returns a new
 * application, started on the clone with `register` applied, once `settle` (one macrotask
 * by default; a suite on fake timers advances them instead) has let its controllers connect.
 */
export const restoreFromCache = async (
  application: Application,
  register: (restored: Application) => void,
  settle: () => Promise<unknown> = tick,
): Promise<Application> => {
  const snapshot = document.body.cloneNode(true) as HTMLElement;
  disconnectAndStopApplication(application);
  document.body.replaceWith(snapshot);
  const restored = Application.start();
  register(restored);
  await settle();
  return restored;
};
