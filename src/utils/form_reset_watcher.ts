/**
 * Runs a controller's reconciliation pass after a native form reset has
 * restored the form's own controls.
 *
 * **A microtask alone is not "after the reset", and the reason is where the
 * dispatch came from.** `form.reset()` fires the event and restores the
 * controls inside one script frame, so a microtask queued from a listener lands
 * after both. A reset the user triggers — activating a `reset` button — is
 * dispatched by the browser with an empty script stack, so the microtask
 * checkpoint runs the moment the listener returns: still inside the dispatch,
 * before the controls are restored and before a later listener has had its
 * chance to cancel. Reconciling there reads the pre-reset values and treats a
 * cancelled reset as a real one.
 *
 * The event itself tells the two origins apart. `eventPhase` returns to
 * `Event.NONE` at the end of dispatch, so a microtask that sees `NONE` is
 * already past the default action and settles on the spot — that is the
 * scripted path, and its timing is exactly a microtask. A microtask
 * that still sees a dispatch phase is the browser-driven path and settles on
 * the next animation frame instead: the default action completes before that
 * frame, and `defaultPrevented` has reached its final value. A frame is only
 * ever reached from a real user interaction, which requires a rendered
 * document, so the frame cannot starve.
 *
 * Pending frames are held per handle rather than collapsed into one slot: a set
 * needs no branch to stay accurate, and every handle in it is cancellable at
 * teardown.
 *
 * Scope is the timing and the ownership test only. *What* to reconcile — an
 * aggregate, a visibility pass, a re-read of every field — stays in the
 * controller, because no two consumers answer it the same way. Ownership stays
 * there too: a control associated through `form=` is reached by the consumer's
 * own `control.form` read.
 *
 * This file's own doc block is dropped from `dist`, but every member comment is
 * inlined into each consumer entry (`tsup` builds with `splitting: false`), so
 * rationale belongs here and only the contract belongs on the members.
 *
 * @example
 * ```ts
 * readonly #formReset = new FormResetWatcher(
 *   (form) => this.fieldTargets.some((field) => field.form === form),
 *   () => this.#reconcile.schedule(),
 * );
 *
 * connect()    { this.#formReset.observe(); }
 * disconnect() { this.#formReset.disconnect(); }
 * ```
 */
export class FormResetWatcher {
  readonly #owns: (form: HTMLFormElement) => boolean;
  readonly #onReset: () => void;
  readonly #frames = new Set<number>();
  #generation = 0;

  /**
   * @param owns - whether `form` owns a control this controller derives from.
   * @param onReset - the reconciliation pass, run once per honoured reset.
   */
  constructor(owns: (form: HTMLFormElement) => boolean, onReset: () => void) {
    this.#owns = owns;
    this.#onReset = onReset;
  }

  /** Subscribes to `reset` at the document; call from `connect()`. Idempotent. */
  observe(): void {
    document.addEventListener("reset", this.#handleReset, true);
  }

  /** Unsubscribes and drops every pending pass; call from `disconnect()`. */
  disconnect(): void {
    document.removeEventListener("reset", this.#handleReset, true);
    this.#generation += 1;
    for (const frame of this.#frames) cancelAnimationFrame(frame);
    this.#frames.clear();
  }

  readonly #handleReset = (event: Event): void => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !this.#owns(form)) return;
    const generation = this.#generation;
    queueMicrotask(() => {
      // A pass queued before teardown must not reach a disconnected controller.
      if (generation !== this.#generation) return;
      if (event.eventPhase === Event.NONE) {
        this.#settle(event);
        return;
      }
      const frame = requestAnimationFrame(() => {
        this.#frames.delete(frame);
        this.#settle(event);
      });
      this.#frames.add(frame);
    });
  };

  /** Runs the pass unless a listener cancelled the reset before it landed. */
  #settle(event: Event): void {
    if (!event.defaultPrevented) this.#onReset();
  }
}
