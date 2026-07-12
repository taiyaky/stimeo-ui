import { Controller } from "@hotwired/stimulus";
import { DetachGate } from "../utils/detach_gate";

/** How a drag session was initiated; surfaced in every event detail. */
type DragPointerType = "mouse" | "touch" | "pen" | "keyboard";

/** A pointer drag in flight (from `pointerdown` until up/cancel). */
interface PointerSession {
  pointerId: number;
  handle: HTMLElement;
  originX: number;
  originY: number;
  /** True once the movement passed `threshold` and `start` was dispatched. */
  started: boolean;
  /** Last axis-filtered deltas, reported again by `end`. */
  dx: number;
  dy: number;
  pointerType: DragPointerType;
}

/** A keyboard "grabbed" session (Space/Enter on the handle until drop/cancel). */
interface KeyboardSession {
  handle: HTMLElement;
  /** Cumulative synthetic deltas accumulated by the arrow keys. */
  dx: number;
  dy: number;
}

/**
 * Headless **pointer-drag primitive**: a normalized pointer/touch/mouse drag
 * lifecycle with a built-in keyboard alternative. It deliberately does NOT decide
 * what a drag *means* (reorder, dismiss, resize…) — it only emits a clean,
 * accessibility-friendly drag signal that higher-level behaviors (sortable,
 * swipe-actions, bottom-sheet, split-pane…) compose from. No dedicated APG
 * pattern exists for drag-and-drop; the keyboard model below is the accepted
 * alternative-input technique (WCAG 2.1.1 / 2.5.7 Dragging Movements). Core
 * (zero dependencies).
 *
 * Markup contract (identifier: `stimeo--pointer-drag`):
 *   <li data-controller="stimeo--pointer-drag"
 *       data-stimeo--pointer-drag-axis-value="y">
 *     <button data-stimeo--pointer-drag-target="handle" aria-label="Reorder">⠿</button>
 *   </li>
 *
 * The `handle` target is optional — without one, the controller element itself
 * is the handle. Pointer flow: `pointerdown` on a handle arms the drag; once the
 * axis-filtered movement exceeds `threshold`, `start` fires, every subsequent
 * movement fires `move` (deltas cumulative from the origin), and release fires
 * `end` (`pointercancel` → `cancel`). Keyboard flow: Space/Enter on the handle
 * grabs (`start`, `data-grabbed`), the arrow keys emit synthetic `move` events of
 * `keyboardStep` px each, Space/Enter drops (`end`) and Escape cancels — so every
 * consumer gets a keyboard path for free.
 *
 * @remarks
 * Behavior only: consumers own all visuals (ghost, placeholder, transforms) by
 * reacting to the events and the `data-dragging` / `data-grabbed` hooks. The one
 * deliberate exception is the opt-in `follow` value for the "just move the
 * element" case: it applies the in-flight deltas to the element's CSS
 * `translate` (a property independent of `transform`, so authored transforms
 * survive), commits the offset on drop and restores it on cancel — the exact
 * boilerplate every simple consumer would otherwise re-write. With `follow` the
 * element's inline `translate` belongs to this controller (`connect()` re-reads
 * a previously committed `<x>px <y>px` offset, so Turbo restores stay
 * consistent). ARIA
 * 1.1 deprecated `aria-grabbed`/`aria-dropeffect`, so the grabbed state is
 * published as `data-grabbed` and the *meaning* of a drag must be announced by
 * the consumer (pair with `stimeo--announcer`). `touch-action` on the handles is
 * derived from `axis` (marker-guarded, authored values win) so the page does not
 * pan mid-drag. Deltas are physical (client coordinates): RTL semantics belong
 * to the consumer. `disconnect()` (Turbo navigation included) tears down any
 * active session — except across an in-page move, which the session survives
 * (the full lifecycle contract lives on `disconnect()`); `connect()` clears
 * stale hooks a Turbo cache restore may have preserved (a drag cannot survive
 * a navigation).
 */
export class PointerDragController extends Controller<HTMLElement> {
  static override targets = ["handle"];
  static override values = {
    axis: { type: String, default: "both" },
    threshold: { type: Number, default: 3 },
    keyboardStep: { type: Number, default: 10 },
    disabled: { type: Boolean, default: false },
    follow: { type: Boolean, default: false },
  };
  static events = ["start", "move", "end", "cancel"] as const;

  declare readonly handleTargets: HTMLElement[];
  declare readonly hasHandleTarget: boolean;
  declare axisValue: string;
  declare thresholdValue: number;
  declare keyboardStepValue: number;
  declare disabledValue: boolean;
  declare followValue: boolean;

  /** Marker attribute recording that this controller set the touch-action. */
  static readonly #TOUCH_ACTION_MARKER = "data-pointer-drag-touch-action";
  /** Marker attribute recording that this controller set `tabindex`. */
  static readonly #TABINDEX_MARKER = "data-pointer-drag-tabindex";

  #pointer: PointerSession | null = null;
  #keyboard: KeyboardSession | null = null;
  /** Committed follow offset from past drops; a new drag's deltas add onto it. */
  #followBase = { x: 0, y: 0 };
  /** Aborts in-progress pointer-drag listeners on drag end / teardown. */
  #dragAbort: AbortController | null = null;
  /** Decides whether a mid-session disconnect() is an in-page move or a detach. */
  readonly #gate = new DetachGate();

  override connect(): void {
    // A reconnect disarms the probe a mid-session disconnect() armed — the
    // element was moved in-page and the session survives (see disconnect).
    this.#gate.cancel();
    // Transient drag state cannot survive a navigation: clear hooks a Turbo
    // cache restore may have snapshotted mid-drag (idempotent reconnect). But a
    // session preserved across an in-page move keeps its hooks.
    if (!this.#pointer) this.element.removeAttribute("data-dragging");
    if (!this.#keyboard) this.element.removeAttribute("data-grabbed");
    // Follow mode owns the element's inline `translate`: re-read a committed
    // offset so reconnects (Turbo cache restore included) keep accumulating from
    // where the element visually sits. A session surviving an in-page move keeps
    // its base — mid-drag inline state must not be committed as a new base.
    if (this.followValue && !this.#pointer && !this.#keyboard) {
      this.#followBase = this.#parseFollowBase();
    }
    // Delegated on the container so dynamically added handles need no per-element
    // data-action (stimulus-lifecycle-turbo Rule A′).
    this.element.addEventListener("pointerdown", this.#onPointerDown);
    this.element.addEventListener("keydown", this.#onKeydown);
    if (!this.hasHandleTarget) this.#prepareHandle(this.element);
  }

  override disconnect(): void {
    this.element.removeEventListener("pointerdown", this.#onPointerDown);
    this.element.removeEventListener("keydown", this.#onKeydown);
    // A mid-session disconnect on a STILL-connected element is ambiguous: an
    // in-page move (a consumer like sortable re-inserts the item mid-grab —
    // Stimulus reconnects the same instance in the same mutation batch, and
    // the session must survive) vs a real detach that keeps the element
    // (`data-controller` removed, Turbo morph, element moved outside the
    // observed root). DetachGate discriminates: the token check is the
    // synchronous fast path (a morph's teardown — and its `cancel` — fires in
    // the same tick), the one-microtask probe cancelled by connect() covers
    // the rest — a detached-in-place controller never leaks its session or
    // document listeners. Probe only while a session needs protecting; an
    // idle controller tears down synchronously either way.
    if (this.#pointer || this.#keyboard) {
      this.#gate.disconnected(this, () => this.#teardown());
      return;
    }
    this.#teardown();
  }

  /** Prepares handles added at runtime (touch-action + focusability). */
  handleTargetConnected(handle: HTMLElement): void {
    this.#prepareHandle(handle);
  }

  handleTargetDisconnected(handle: HTMLElement): void {
    // A handle REMOVED mid-session can never deliver its keydown (the delegated
    // listener sits on the container it left), so the session would leak — and
    // the one-session guard would then reject every future pointerdown. End it
    // silently: the DOM is changing under the user, same as disconnect. But
    // target callbacks ALSO fire when the CONTROLLER disconnects (Stimulus
    // stops the target observer — including the in-page move a live session
    // must survive): a handle still inside the element was not removed, so
    // that case is left to disconnect()'s deferred probe.
    if (!this.element.contains(handle)) {
      if (this.#pointer?.handle === handle) this.#endPointerSession();
      if (this.#keyboard?.handle === handle) this.#clearKeyboardSession();
    }
    this.#restoreHandle(handle);
  }

  /** Re-derives the handles' touch-action when the axis changes. */
  axisValueChanged(): void {
    for (const handle of this.#handles()) {
      if (handle.hasAttribute(PointerDragController.#TOUCH_ACTION_MARKER)) {
        handle.style.touchAction = this.#touchActionForAxis();
      }
    }
  }

  /** Cancels any in-flight session when the controller is disabled mid-drag. */
  disabledValueChanged(): void {
    if (!this.disabledValue) return;
    if (this.#pointer?.started || this.#keyboard) {
      this.#dispatchCancel(this.#keyboard ? "keyboard" : (this.#pointer?.pointerType ?? "mouse"));
    }
    this.#teardownSessions();
  }

  /** Arms a pointer drag on a handle; `start` waits for the threshold. */
  readonly #onPointerDown = (event: PointerEvent): void => {
    // One session at a time: ignore a second pointerdown (multi-touch, an
    // errant tap, a grabbed keyboard session) so an in-flight drag is never
    // silently overwritten and its captured pointer orphaned.
    if (this.disabledValue || this.#pointer || this.#keyboard || event.button !== 0) return;
    const handle = this.#handleFor(event.target);
    if (!handle) return;

    // Suppress text selection / native image drag; restore the focus the
    // suppressed default would have given, so Escape and the keyboard path
    // stay reachable right after a pointer interaction (WCAG 2.1.1).
    event.preventDefault();
    handle.focus();

    this.#pointer = {
      pointerId: event.pointerId,
      handle,
      originX: event.clientX,
      originY: event.clientY,
      started: false,
      dx: 0,
      dy: 0,
      pointerType: this.#pointerTypeOf(event),
    };

    // Pointer capture keeps fast drags delivering to the handle even when the
    // pointer strays outside it — but a consumer may re-insert the dragged
    // element mid-drag (sortable's live reorder), which silently releases the
    // capture. Tracking listeners therefore live on the DOCUMENT (captured
    // events bubble there; uncaptured ones fire there anyway), and the
    // AbortController releases them on drag end and disconnect() (Turbo included).
    handle.setPointerCapture(event.pointerId);
    this.#dragAbort?.abort();
    const abort = new AbortController();
    this.#dragAbort = abort;
    document.addEventListener("pointermove", this.#onPointerMove, { signal: abort.signal });
    document.addEventListener("pointerup", this.#onPointerUp, { signal: abort.signal });
    document.addEventListener("pointercancel", this.#onPointerCancel, { signal: abort.signal });
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    const session = this.#pointer;
    if (!session || event.pointerId !== session.pointerId) return;

    const [dx, dy] = this.#filterAxis(
      event.clientX - session.originX,
      event.clientY - session.originY,
    );
    if (!session.started) {
      if (Math.hypot(dx, dy) < this.thresholdValue) return;
      session.started = true;
      this.element.setAttribute("data-dragging", "true");
      this.dispatch("start", {
        detail: { x: event.clientX, y: event.clientY, pointerType: session.pointerType },
      });
    }

    session.dx = dx;
    session.dy = dy;
    this.#followMove(dx, dy);
    this.dispatch("move", {
      detail: { dx, dy, x: event.clientX, y: event.clientY, pointerType: session.pointerType },
    });
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    const session = this.#pointer;
    if (!session || event.pointerId !== session.pointerId) return;
    const { started, dx, dy, pointerType } = session;
    this.#endPointerSession();
    // Below the threshold the gesture was a plain click, not a drag: stay silent.
    if (!started) return;
    this.#followCommit(dx, dy);
    this.dispatch("end", { detail: { dx, dy, pointerType } });
  };

  /** OS gesture / scroll takeover interrupted the drag: cancel, don't drop. */
  readonly #onPointerCancel = (event: PointerEvent): void => {
    const session = this.#pointer;
    if (!session || event.pointerId !== session.pointerId) return;
    const { started, pointerType } = session;
    this.#endPointerSession();
    if (started) this.#dispatchCancel(pointerType);
  };

  /** Keyboard alternative: Space/Enter grab & drop, arrows move, Escape cancels. */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (this.disabledValue) return;
    const handle = this.#handleFor(event.target);
    if (!handle) return;

    // Escape cancels whichever session is live (pointer drag or keyboard grab).
    if (event.key === "Escape") {
      if (this.#pointer?.started) {
        const { pointerType } = this.#pointer;
        this.#teardownSessions();
        event.preventDefault();
        this.#dispatchCancel(pointerType);
      } else if (this.#keyboard) {
        this.#teardownSessions();
        event.preventDefault();
        this.#dispatchCancel("keyboard");
      }
      return;
    }

    if (event.key === " " || event.key === "Enter") {
      // A live pointer drag owns the session: pressing Space mid-drag (the
      // pointerdown focused the handle) must not start a parallel grab.
      if (this.#pointer) return;
      event.preventDefault();
      if (this.#keyboard) this.#dropKeyboard();
      else this.#grabKeyboard(handle);
      return;
    }

    if (!this.#keyboard) return;
    const step = this.#keyboardDelta(event.key);
    if (!step) return;
    // Consume every arrow while grabbed (even on a locked axis) so the page
    // never scrolls mid-grab; only allowed-axis arrows emit a move.
    event.preventDefault();
    const [dx, dy] = this.#filterAxis(step[0], step[1]);
    if (dx === 0 && dy === 0) return;
    this.#keyboard.dx += dx;
    this.#keyboard.dy += dy;
    this.#followMove(this.#keyboard.dx, this.#keyboard.dy);
    this.dispatch("move", {
      detail: {
        dx: this.#keyboard.dx,
        dy: this.#keyboard.dy,
        x: this.#keyboard.dx,
        y: this.#keyboard.dy,
        pointerType: "keyboard",
      },
    });
  };

  /** Enters the grabbed mode: `data-grabbed` on element + handle, then `start`. */
  #grabKeyboard(handle: HTMLElement): void {
    this.#keyboard = { handle, dx: 0, dy: 0 };
    this.element.setAttribute("data-grabbed", "true");
    handle.setAttribute("data-grabbed", "true");
    this.dispatch("start", { detail: { x: 0, y: 0, pointerType: "keyboard" } });
  }

  #dropKeyboard(): void {
    const session = this.#keyboard;
    if (!session) return;
    this.#clearKeyboardSession();
    this.#followCommit(session.dx, session.dy);
    this.dispatch("end", { detail: { dx: session.dx, dy: session.dy, pointerType: "keyboard" } });
  }

  /** Maps an arrow key to a raw (unfiltered) `keyboardStep` delta. */
  #keyboardDelta(key: string): [number, number] | null {
    const step = this.keyboardStepValue;
    switch (key) {
      case "ArrowRight":
        return [step, 0];
      case "ArrowLeft":
        return [-step, 0];
      case "ArrowDown":
        return [0, step];
      case "ArrowUp":
        return [0, -step];
      default:
        return null;
    }
  }

  /** Zeroes the delta on the locked axis (`axis` = x | y | both). */
  #filterAxis(dx: number, dy: number): [number, number] {
    if (this.axisValue === "x") return [dx, 0];
    if (this.axisValue === "y") return [0, dy];
    return [dx, dy];
  }

  /** Releases capture + listeners and clears the pointer session and its hook. */
  #endPointerSession(): void {
    this.#releasePointerCapture();
    this.#pointer = null;
    this.#dragAbort?.abort();
    this.#dragAbort = null;
    this.element.removeAttribute("data-dragging");
  }

  /** Releases the pointer capture the active session set (idempotent, safe). */
  #releasePointerCapture(): void {
    const session = this.#pointer;
    if (session?.handle.hasPointerCapture(session.pointerId)) {
      session.handle.releasePointerCapture(session.pointerId);
    }
  }

  #clearKeyboardSession(): void {
    this.#keyboard?.handle.removeAttribute("data-grabbed");
    this.#keyboard = null;
    this.element.removeAttribute("data-grabbed");
  }

  /**
   * Full teardown for a controller whose element is going away or lost its
   * controller. Into a dead (detached) tree it is silent — consumers restore
   * from their own `connect()`, not from a cancel event. But a detach that
   * KEEPS the element (Turbo morph, `data-controller` removed) leaves the
   * consumers alive and listening: an in-flight session must end in `cancel`
   * there, or a composer like sortable strands its one-at-a-time session
   * bookkeeping forever.
   */
  #teardown(): void {
    // Disarm any probe still queued: without this, an immediate teardown
    // (element removed right after a deferring disconnect) would let the
    // orphaned probe run #teardown a second time — a double cancel.
    this.#gate.cancel();
    const interrupted = this.#pointer?.started
      ? this.#pointer.pointerType
      : this.#keyboard
        ? ("keyboard" as const)
        : null;
    this.#teardownSessions();
    for (const handle of this.#handles()) this.#restoreHandle(handle);
    if (interrupted && this.element.isConnected) this.#dispatchCancel(interrupted);
  }

  /**
   * Silently tears down whatever session is live (disconnect / disabled /
   * Escape). Composed from the two single-session teardowns so a cleanup step
   * added to one path can never be missed on the other (the bug-shape behind
   * the capture-release fix).
   */
  #teardownSessions(): void {
    this.#endPointerSession();
    this.#clearKeyboardSession();
  }

  #dispatchCancel(pointerType: DragPointerType): void {
    // Every cancel path funnels here, so follow's snap-back can never be missed
    // (Escape, pointercancel, mid-session disable, detach-that-keeps-the-element).
    this.#followReset();
    this.dispatch("cancel", { detail: { pointerType } });
  }

  /** Applies the in-flight offset to the element's `translate` (follow only). */
  #followMove(dx: number, dy: number): void {
    if (!this.followValue) return;
    this.#applyFollow(this.#followBase.x + dx, this.#followBase.y + dy);
  }

  /** Folds a drop's deltas into the committed base offset (follow only). */
  #followCommit(dx: number, dy: number): void {
    if (!this.followValue) return;
    this.#followBase = { x: this.#followBase.x + dx, y: this.#followBase.y + dy };
    this.#applyFollow(this.#followBase.x, this.#followBase.y);
  }

  /** Snaps back to the committed position (follow only) — the cancel contract. */
  #followReset(): void {
    if (!this.followValue) return;
    this.#applyFollow(this.#followBase.x, this.#followBase.y);
  }

  /**
   * Writes the offset as the standalone CSS `translate` property — independent
   * of `transform`, so an authored transform (scale, rotate…) is never
   * clobbered. At the origin the property is removed to keep the DOM clean.
   */
  #applyFollow(x: number, y: number): void {
    if (x === 0 && y === 0) this.element.style.removeProperty("translate");
    else this.element.style.setProperty("translate", `${x}px ${y}px`);
  }

  /**
   * Reads a committed follow offset back from the inline `translate`. Only the
   * controller's own `<x>px <y>px` shape is recognized; anything else (an
   * authored percentage, `none`, an empty string) starts the base at 0 — follow
   * mode owns this property, per the class contract.
   */
  #parseFollowBase(): { x: number; y: number } {
    const raw = this.element.style.getPropertyValue("translate").trim();
    const match = /^(-?\d+(?:\.\d+)?)px(?:\s+(-?\d+(?:\.\d+)?)px)?$/.exec(raw);
    if (!match) return { x: 0, y: 0 };
    return { x: Number(match[1]), y: Number(match[2] ?? "0") };
  }

  /** The active handles: the `handle` targets, else the element itself. */
  #handles(): HTMLElement[] {
    return this.hasHandleTarget ? this.handleTargets : [this.element];
  }

  /** Resolves the handle owning an event target (the handle or a descendant). */
  #handleFor(target: EventTarget | null): HTMLElement | null {
    const node = target as Node | null;
    if (!node) return null;
    return this.#handles().find((handle) => handle === node || handle.contains(node)) ?? null;
  }

  #pointerTypeOf(event: PointerEvent): DragPointerType {
    const type = event.pointerType;
    if (type === "touch" || type === "pen") return type;
    return "mouse";
  }

  /** `touch-action` that lets the page keep panning on the locked axis only. */
  #touchActionForAxis(): string {
    if (this.axisValue === "x") return "pan-y";
    if (this.axisValue === "y") return "pan-x";
    return "none";
  }

  /**
   * Establishes the handle contract: a `touch-action` derived from `axis`
   * (marker-guarded so an authored inline value wins and reconnects stay
   * idempotent) and focusability for the keyboard path (`tabindex="0"` only when
   * the author supplied none — prefer a real `<button>` handle). Both additions
   * are marker-owned so `#restoreHandle` reverts them symmetrically on teardown.
   */
  #prepareHandle(handle: HTMLElement): void {
    if (
      handle.style.touchAction === "" ||
      handle.hasAttribute(PointerDragController.#TOUCH_ACTION_MARKER)
    ) {
      handle.style.touchAction = this.#touchActionForAxis();
      handle.setAttribute(PointerDragController.#TOUCH_ACTION_MARKER, "true");
    }
    if (handle.tabIndex < 0 && !handle.hasAttribute("tabindex")) {
      handle.setAttribute("tabindex", "0");
      handle.setAttribute(PointerDragController.#TABINDEX_MARKER, "true");
    }
  }

  /** Reverts the marker-owned touch-action + tabindex (authored values untouched). */
  #restoreHandle(handle: HTMLElement): void {
    if (handle.hasAttribute(PointerDragController.#TOUCH_ACTION_MARKER)) {
      handle.style.touchAction = "";
      handle.removeAttribute(PointerDragController.#TOUCH_ACTION_MARKER);
    }
    if (handle.hasAttribute(PointerDragController.#TABINDEX_MARKER)) {
      handle.removeAttribute(PointerDragController.#TABINDEX_MARKER);
      // Only remove what is verifiably still ours and safe to remove: another
      // owner (e.g. a roving list) may have rewritten the value since, and
      // stripping tabindex off the focused element would blur it to <body>
      // (losing the user's place — worse than leaking one tab stop).
      if (handle.getAttribute("tabindex") === "0" && document.activeElement !== handle) {
        handle.removeAttribute("tabindex");
      }
    }
  }
}
