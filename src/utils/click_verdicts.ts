/**
 * The activation verdict a click took as it started, kept for every action that
 * click goes on to reach.
 *
 * A consumer handler on an entry can run before the action bound there, and may
 * change the entry while the click runs — mark it `disabled` or `aria-disabled` while
 * the command it starts is in flight. Judging the entry again when the action runs
 * would then take back the activation the click started. So a controller judges a
 * click once, in a capture listener on its own element that runs before the handlers
 * inside that element, records the verdict here with every entry that held
 * the click's target, and each action that click reaches reads the verdict back for
 * the entry it resolved.
 *
 * A verdict is read back only for an entry it was recorded with. An action that
 * resolves another entry — a handler moved the target into one — reads `undefined`
 * and judges that entry when it runs, as it does every event that is not a click.
 * Records are keyed by the event and are released with it.
 */
export class ClickVerdicts {
  readonly #verdicts = new WeakMap<
    Event,
    { readonly entries: readonly Element[]; readonly refused: boolean }
  >();

  /**
   * Records whether `event` is refused, with the `entries` that held its target as it
   * started. A later record of the same event replaces this one, and a record with no
   * entries matches no entry.
   */
  record(event: Event, entries: readonly Element[], refused: boolean): void {
    this.#verdicts.set(event, { entries, refused });
  }

  /**
   * The verdict recorded for `event` when `entry` is one of the entries it was
   * recorded with; `undefined` when there is no event, the event was never recorded,
   * or it was recorded without `entry`.
   */
  for(event: Event | null | undefined, entry: Element): boolean | undefined {
    const verdict = event && this.#verdicts.get(event);
    if (!verdict?.entries.includes(entry)) return undefined;
    return verdict.refused;
  }
}
