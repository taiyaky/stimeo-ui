/**
 * Shared "in-page move vs real detach" discriminator for `disconnect()`.
 *
 * A mid-session `disconnect()` whose element is still in the document is
 * ambiguous. It can be:
 *
 * - an **in-page move** — a consumer (sortable, a teleport) re-inserted the
 *   element; Stimulus reconnects the SAME instance in the same mutation batch
 *   and the controller's runtime state must survive;
 * - a **detach that keeps the element** — `data-controller` no longer lists the
 *   identifier (a Turbo 8 morph), or the element moved outside the observed
 *   root (a scoped `Application.start(root)`, a shadow root); no reconnect will
 *   ever come and the controller must tear down or it leaks its sessions,
 *   document listeners, and moved nodes.
 *
 * Neither available signal decides this alone. A synchronous `data-controller`
 * token check catches the morph case but misses an observed-root exit (the
 * token stays, the reconnect never comes). Deferring teardown one microtask and
 * letting `connect()` cancel it catches the root exit, but leans on Stimulus
 * reconnecting moved elements within the same mutation batch — internal
 * behavior, not a public contract. {@link DetachGate} composes both: the token
 * check is the synchronous fast path (no probe, no reliance on batching), the
 * microtask probe is the fallback for the genuinely ambiguous remainder.
 *
 * An element out of the document is a real detach, with one exception: a
 * `data-turbo-permanent` element, or one inside it, that Turbo carries to the
 * next page. Turbo takes it out of the old `<body>`, which Stimulus answers with
 * a `disconnect()` while it is out of the document, and puts it into the new one
 * a few microtasks later in the same task, where the same instance connects
 * again. Such a disconnect is probed until the next task instead.
 *
 * Policy stays with the consumer; this util owns the discrimination only:
 *
 * - **Probe** ({@link disconnected}) when the teardown must eventually happen —
 *   live drag sessions, document listeners, teleported *content*. Call
 *   {@link cancel} from `connect()` (a reconnect means in-page move) and from
 *   the head of any direct teardown path (see below).
 * - **Keep** (bare {@link DetachGate.isDetached}) when undoing the ambiguous
 *   case would fight the controller's own effect: a controller that moves its
 *   OWN element (portal's no-`content` form) exits a scoped observed root as
 *   its normal job — a probe-driven teardown would restore the element into
 *   the root, reconnect, re-teleport, and disconnect again, forever. Such
 *   controllers keep their state on an ambiguous disconnect and tear down only
 *   on {@link DetachGate.isDetached}.
 *
 * Event convention for probe consumers: teardown into a dead (detached) tree is
 * silent — consumers restore from their own `connect()`; a detach that keeps the
 * tree alive must end an in-flight session with a `cancel` event, or composing
 * consumers strand their session bookkeeping.
 */

/** The slice of a Stimulus controller the gate inspects. */
export interface DetachGateHost {
  readonly element: Element;
  readonly identifier: string;
}

/**
 * Per-controller-instance gate deciding whether a `disconnect()` is a real
 * detach. Hold one per controller (`#gate = new DetachGate()`) — Stimulus
 * reuses the instance across reconnects, so the pending probe state carries
 * over exactly as the protocol needs.
 *
 * @example
 * ```ts
 * #gate = new DetachGate();
 *
 * connect(): void {
 *   this.#gate.cancel(); // a reconnect: the element moved in-page
 *   // …
 * }
 *
 * disconnect(): void {
 *   this.#gate.disconnected(this, () => this.#teardown());
 * }
 *
 * dismiss(): void {
 *   this.#gate.cancel(); // a direct path: disarm a probe a disconnect queued
 *   this.#teardown();
 * }
 *
 * #teardown(): void {
 *   // … (`disconnected` has already disarmed the probe on its own path)
 * }
 * ```
 */
export class DetachGate {
  /** Set while a probe is queued, waiting for a reconnect to cancel it. */
  #pending = false;

  /**
   * True while a probe is queued — the last disconnect was ambiguous and no
   * reconnect has cancelled it yet. Read it from `connect()` to tell the
   * reconnect half of an in-page move from a first connect: a controller whose
   * initialisation restarts a measurement (a min-duration floor, an elapsed
   * counter) must skip it for the move, where nothing actually restarted.
   */
  get pending(): boolean {
    return this.#pending;
  }

  /**
   * True when the disconnect is definitely a real detach — the element left
   * the document, or `data-controller` no longer lists the identifier. False
   * means ambiguous (in-page move or observed-root exit), NOT "alive".
   */
  static isDetached(host: DetachGateHost): boolean {
    return !host.element.isConnected || !DetachGate.#listed(host);
  }

  /**
   * Call from `disconnect()`: runs `teardown` synchronously on a definite
   * detach (fast path), otherwise defers it one microtask — a reconnect
   * ({@link cancel} from `connect()`) keeps the state, no reconnect runs it.
   * One microtask is the whole probe window: Stimulus reconnects a moved
   * element within the same mutation batch, before the checkpoint drains. An
   * element Turbo carries to the next page is probed until the next task, by
   * which time Turbo has put it back.
   */
  disconnected(host: DetachGateHost, teardown: () => void): void {
    const carried = DetachGate.#carried(host);
    if (!carried && DetachGate.isDetached(host)) {
      // Also disarms a probe a previous ambiguous disconnect left queued
      // (defer, element removed, disconnect again) — exactly one teardown.
      this.#pending = false;
      teardown();
      return;
    }
    this.#pending = true;
    const probe = (): void => {
      if (!this.#pending) return;
      this.#pending = false;
      teardown();
    };
    if (carried) setTimeout(probe, 0);
    else queueMicrotask(probe);
  }

  /**
   * Whether `host` is out of the document inside a `data-turbo-permanent` element, its
   * identifier still listed: where Turbo holds an element it carries to the next page.
   */
  static #carried(host: DetachGateHost): boolean {
    const element = host.element;
    return (
      !element.isConnected &&
      element.closest("[data-turbo-permanent]") !== null &&
      DetachGate.#listed(host)
    );
  }

  /** Whether the element's `data-controller` still lists the identifier. */
  static #listed(host: DetachGateHost): boolean {
    const tokens = (host.element.getAttribute("data-controller") ?? "").split(/\s+/);
    return tokens.includes(host.identifier);
  }

  /**
   * Disarms a pending probe. Call from `connect()` (the reconnect that proves
   * an in-page move) and from the head of any teardown path not routed through
   * {@link disconnected} (disabled-toggle, Escape), so an orphaned probe can
   * never run the teardown a second time.
   */
  cancel(): void {
    this.#pending = false;
  }
}
