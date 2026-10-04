import { ListenerSet } from "./listener_set";
import { MicrotaskCoalescer } from "./microtask_coalescer";

/**
 * Coalesces retained-element morphs and explicit lifecycle requests into one pass.
 *
 * Observe the controller's element after its initial state is settled. Morphs on
 * that element and bubbling morphs on its descendants share the same microtask
 * as {@link schedule}. The callback repairs derived output; the controller owns
 * any logical transition reporting. {@link disconnect} releases the listener and
 * cancels pending work, including work from an earlier connected lifetime.
 */
export class MorphRenderWatcher {
  readonly #listeners = new ListenerSet();
  readonly #pass: MicrotaskCoalescer;
  #element: Element | null = null;
  readonly #onMorph = (): void => this.#pass.schedule();

  /** @param run - the single pass that repairs the settled controller's output. */
  constructor(run: () => void) {
    this.#pass = new MicrotaskCoalescer(run);
  }

  /** Opens observation; observing the same element again preserves queued work. */
  observe(element: Element): void {
    if (this.#element === element) return;
    this.disconnect();
    this.#element = element;
    this.#pass.activate();
    this.#listeners.add(element, "turbo:morph-element", this.#onMorph);
  }

  /** Requests one pass; requests outside an observed lifetime are ignored. */
  schedule(): void {
    this.#pass.schedule();
  }

  /** Releases observation and pending work synchronously; safe to repeat. */
  disconnect(): void {
    this.#listeners.dispose();
    this.#pass.cancel();
    this.#element = null;
  }
}
