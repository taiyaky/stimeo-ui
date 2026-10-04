/**
 * Identifies the latest reported state transition of one owner.
 *
 * Record a transition after its state is written and before invoking external
 * code. Check the returned token before each later report: a synchronous
 * transition made by a listener supersedes reports that have not been sent.
 * Reading state or committing an unchanged state must not advance the counter.
 * Reports stay in the caller so their ordering remains explicit.
 */
export class MoveCounter {
  #sequence = 0;

  /** Records a state transition and returns its report token. */
  record(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  /** Whether no later state transition has superseded this report token. */
  isLatest(token: number): boolean {
    return token === this.#sequence;
  }
}
