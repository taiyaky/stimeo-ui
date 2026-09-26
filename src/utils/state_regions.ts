/** What a consumer declares once about the regions one boolean state reveals. */
export interface StateRegionsOptions {
  /** Returns the declared regions shown while the state holds. */
  readonly whenTrue: () => readonly HTMLElement[];
  /**
   * Returns the declared regions shown while the state does not hold. Omitted by a
   * state whose other side has nothing of its own to show.
   */
  readonly whenFalse?: () => readonly HTMLElement[];
}

/**
 * Owns `hidden` on the regions a boolean state reveals.
 *
 * A region is a **declared** target, so the consumer decides whether one exists at
 * all; where it does, which side is shown is a pure function of the state and the
 * controller writes it unconditionally. An authored `hidden` is therefore not read
 * back — the first reflection after a connection settles it, and a restored DOM
 * cannot leave a region contradicting the state it belongs to.
 *
 * The regions arrive as the caller's own target arrays, which Stimulus has already
 * scoped to this instance: a nested controller registered under the same identifier
 * keeps its own regions. `host` narrows that set further, to the regions inside one
 * trigger or item, so a widget with several of them reflects each independently.
 *
 * **Two sides are a pair.** Where the state has a `whenFalse` side and only one half
 * sits inside `host`, the half that is there is left in view: hiding it would take
 * the only label with it, and the static check names the missing one instead. What
 * the author wrote on a lone half is theirs and stays — only a half this instance
 * took out of view is given back, which is what a pair losing one side at runtime
 * leaves behind.
 *
 * `hidden` moves only when it changes, so a consumer watching its own subtree for
 * attribute mutations sees one record per transition rather than one per reflection.
 *
 * @example
 * ```ts
 * readonly #labels = new StateRegions({
 *   whenTrue: () => this.expandedLabelTargets,
 *   whenFalse: () => this.collapsedLabelTargets,
 * });
 *
 * #reflect(): void {
 *   this.#labels.reflect(this.triggerTarget, this.#expanded);
 * }
 * ```
 */
export class StateRegions {
  readonly #whenTrue: () => readonly HTMLElement[];
  readonly #whenFalse: (() => readonly HTMLElement[]) | null;
  readonly #taken = new WeakSet<HTMLElement>();

  constructor(options: StateRegionsOptions) {
    this.#whenTrue = options.whenTrue;
    this.#whenFalse = options.whenFalse ?? null;
  }

  /** Shows the regions inside `host` that belong to `isTrue` and hides the others. */
  reflect(host: Element, isTrue: boolean): void {
    const shown = this.#inside(host, this.#whenTrue());
    if (!this.#whenFalse) {
      for (const region of shown) this.#write(region, !isTrue);
      return;
    }
    const hiddenSide = this.#inside(host, this.#whenFalse());
    if (shown.length === 0 || hiddenSide.length === 0) {
      for (const region of shown) this.#give(region);
      for (const region of hiddenSide) this.#give(region);
      return;
    }
    for (const region of shown) this.#write(region, !isTrue);
    for (const region of hiddenSide) this.#write(region, isTrue);
  }

  /** Writes `hidden` where it moves, noting which regions it takes out of view. */
  #write(region: HTMLElement, hidden: boolean): void {
    if (hidden) this.#taken.add(region);
    else this.#taken.delete(region);
    if (region.hidden !== hidden) region.hidden = hidden;
  }

  /** Returns a region this instance hid; one it never hid keeps what it carries. */
  #give(region: HTMLElement): void {
    if (this.#taken.delete(region)) region.hidden = false;
  }

  /** The declared regions that sit within `host`, which may be the host itself. */
  #inside(host: Element, regions: readonly HTMLElement[]): HTMLElement[] {
    return regions.filter((region) => host.contains(region));
  }
}
