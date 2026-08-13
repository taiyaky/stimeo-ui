/**
 * Collapses many Stimulus lifecycle callbacks from one DOM mutation into a
 * single pass.
 *
 * Stimulus fires `<name>TargetConnected` / `Disconnected` once per element and
 * `<name>ValueChanged` once per changed attribute. Replacing a list of N options
 * or morphing several render Values therefore delivers N callbacks — but the
 * useful unit of work is "reconcile against the resulting declarative input",
 * once, after the batch has settled. Every controller with reconcilable targets
 * or render Values needs the same shape: a `queued` flag plus `queueMicrotask`.
 *
 * **A microtask is the right horizon, and the reason is specific.** Stimulus
 * drives these callbacks from a `MutationObserver`, whose own callback already
 * runs as a microtask with the whole batch in hand; scheduling one more lands
 * after the last sibling callback of that batch and still before paint or any
 * event handler. A timer would be later than it needs to be, and reconciling
 * synchronously would run once per element against a half-applied DOM.
 *
 * **The two guards are not the same guard.** Scheduling is refused before the
 * controller connects, and running is refused after it disconnects:
 *
 * - **Before `connect()`** — Stimulus delivers initial target and Value callbacks
 *   ahead of `connect()`. Reconciling there would compute output against a
 *   controller whose own state has not been initialised, and `connect()` is
 *   about to do a full pass anyway.
 * - **After `disconnect()`** — Stimulus fires a callback for **every** target
 *   during teardown, and a microtask queued just before it would otherwise run
 *   against a detached tree. {@link MicrotaskCoalescer.cancel} exists for the
 *   teardown path to drop the pending pass outright.
 *
 * Both guards are part of one contract here rather than something each consumer
 * has to remember separately.
 *
 * Scope is the scheduling only. *What* to reconcile — keep the surviving active
 * option, fall back to the next / previous / first visible one, rebuild derived
 * chips or hidden fields — stays in the controller, because no two consumers
 * answer it the same way.
 *
 * This file's own doc block is dropped from `dist`, but every member comment is
 * inlined into each consumer entry (`tsup` builds with `splitting: false`), so
 * rationale belongs here and only the contract belongs on the members.
 *
 * @example
 * ```ts
 * readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileOptions());
 *
 * connect()    { this.#reconcile.activate(); }
 * disconnect() { this.#reconcile.cancel(); }
 *
 * optionTargetConnected()    { this.#reconcile.schedule(); }
 * optionTargetDisconnected() { this.#reconcile.schedule(); }
 * ```
 */
export class MicrotaskCoalescer {
  readonly #run: () => void;
  #queued = false;
  #active = false;
  #generation = 0;

  /** @param run - the single reconciliation pass, invoked at most once per batch. */
  constructor(run: () => void) {
    this.#run = run;
  }

  /** Opens the window in which {@link schedule} is honoured; call from `connect()`. */
  activate(): void {
    this.#active = true;
  }

  /** Closes the window and drops any pending pass; call from `disconnect()`. */
  cancel(): void {
    this.#active = false;
    this.#queued = false;
    this.#generation += 1;
  }

  /** Requests one pass after the batch settles. Idempotent; inert outside the window. */
  schedule(): void {
    if (!this.#active || this.#queued) return;
    this.#queued = true;
    const generation = this.#generation;
    queueMicrotask(() => {
      // A cancelled callback must not consume a pass queued after reconnect.
      if (generation !== this.#generation || !this.#queued || !this.#active) return;
      this.#queued = false;
      this.#run();
    });
  }
}
