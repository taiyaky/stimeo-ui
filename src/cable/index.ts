import type { Application } from "@hotwired/stimulus";
import { LiveCounterController } from "./live_counter_controller";
import { PresenceController } from "./presence_controller";
import { TypingIndicatorController } from "./typing_indicator_controller";

export {
  type CableConsumer,
  type CableSubscription,
  type CableSubscriptionMixin,
  type ConfirmedCableSubscription,
  createConfirmedSubscription,
  getCableConsumer,
  setCableConsumer,
} from "./consumer";
export { LiveCounterController, PresenceController, TypingIndicatorController };

/**
 * Opt-in **server-bound** behaviors for Stimeo — controllers whose state lives
 * on an Action Cable / Turbo stream rather than in client memory: presence,
 * typing indicators, live counters.
 *
 * **Why this is a separate entry point.** The core library is zero-runtime-dep:
 * `import "stimeo-ui"` pulls in nothing but `@hotwired/stimulus`. Binding the
 * DOM to a server stream genuinely needs `@rails/actioncable`, so — exactly
 * like `stimeo-ui/positioning` and `@floating-ui/dom` — that cost is opt-in:
 * this module lives at `stimeo-ui/cable`, `@rails/actioncable` is an *optional*
 * peer, and nothing in the core imports it.
 *
 * When the app already owns a consumer (`app/javascript/channels/consumer.js`),
 * hand it over once at boot so no second websocket is opened:
 *
 * ```ts
 * import consumer from "./channels/consumer";
 * import { registerCable, setCableConsumer } from "stimeo-ui/cable";
 *
 * setCableConsumer(consumer);
 * registerCable(application);
 * ```
 */
export const cableControllers = {
  "stimeo--live-counter": LiveCounterController,
  "stimeo--presence": PresenceController,
  "stimeo--typing-indicator": TypingIndicatorController,
} as const;

/**
 * Registers the opt-in server-bound controllers on a Stimulus Application
 * (additive to `registerStimeo`, mirroring `registerPositioning`).
 */
export function registerCable(application: Application): void {
  for (const [identifier, controller] of Object.entries(cableControllers)) {
    application.register(identifier, controller);
  }
}
