/**
 * Drops the transient state hooks a connection inherited, so the cycle it opens
 * starts from a DOM that claims nothing.
 *
 * A transient hook is an attribute a controller writes to say "this is happening
 * right now" — a drag in progress, a form with unsaved edits, a refused
 * subscription. Its lifetime belongs to the interaction, not to the element, and
 * the two come apart whenever the element outlives the instance that wrote it: a
 * Turbo cache snapshot taken mid-interaction restores the hook with the markup,
 * and an element re-inserted elsewhere in the page carries it along. Nothing
 * takes such a hook off, because the instance that owned it is gone; consumer
 * CSS then keeps claiming a state no one is in.
 *
 * **`turbo:before-cache` cannot do this job**, which is why the pass belongs in
 * `connect()`: that event fires for a navigation only, so an in-page move — the
 * other half of the population — never reaches it, and a hook that arrived with
 * a moved element would survive. `connect()` covers both, because both end in a
 * connection.
 *
 * Scope is the **drop** only. What the fresh cycle should say instead is the
 * consumer's: a value re-read from the live DOM, a roster refilled by the
 * stream, a measurement retaken from the current scroll position, a slot emptied
 * of the last result. Those answers differ per consumer and none of them is a
 * hook removal, so the pass stops where every consumer agrees.
 *
 * A declaration names one group of hooks and carries no per-instance state, so
 * it belongs at module scope, shared by every instance the page connects. A
 * consumer writes as many as it has groups — hooks it drops under different
 * conditions cannot share one. The exception is a hook whose name is only known
 * at runtime, such as one built from the registered identifier: that
 * declaration is a field, because the name is.
 *
 * **A drop is not always right.** The population splits on one question: can the
 * state a hook describes outlive the instance that wrote it? Where it cannot — a
 * drag ends with the pointer, a subscription dies with its socket — dropping on
 * every connection is correct. Where it can — a submission in flight is not
 * interrupted by an in-page move — only a connection that follows a real restore
 * may drop, and the consumer answers "did a session survive?" with the signal it
 * already holds for its own teardown (a live-session field, a `DetachGate`
 * probe). The drop then sits behind that answer, as the second example shows.
 *
 * @example Unconditional — the state cannot outlive the instance.
 * ```ts
 * const TRANSIENT = new TransientHooks({ attributes: ["data-sortable-dragging"] });
 *
 * connect(): void {
 *   TRANSIENT.reset(this.element);
 * }
 * ```
 *
 * @example Gated — an in-page move must not drop a live state.
 * ```ts
 * const TRANSIENT = new TransientHooks({ attributes: ["data-optimistic"] });
 *
 * connect(): void {
 *   const restored = !this.#connected && !this.#gate.pending;
 *   this.#gate.cancel();
 *   this.#connected = true;
 *   if (restored) TRANSIENT.reset(this.element);
 * }
 * ```
 */

/** What a consumer declares once about the hooks its interaction owns. */
export interface TransientHooksOptions {
  /**
   * The attribute names a connection may find written by an earlier one. Hooks
   * a consumer drops under different conditions belong to different
   * declarations, so each one can be reset on its own.
   */
  readonly attributes: readonly string[];
}

/**
 * One consumer's declaration of the hooks its interaction owns, dropped from an
 * element by {@link TransientHooks.reset}.
 *
 * Every member comment inside this class body is inlined into each consumer
 * bundle (`tsup` builds with `splitting: false`), so rationale belongs in this
 * file's own block, which `dist` drops, and only the contract belongs inside.
 */
export class TransientHooks {
  readonly #attributes: readonly string[];

  constructor(options: TransientHooksOptions) {
    this.#attributes = options.attributes;
  }

  /** Drops the declared hooks from `element`; what it carries besides stays. */
  reset(element: Element): void {
    for (const attribute of this.#attributes) element.removeAttribute(attribute);
  }
}
