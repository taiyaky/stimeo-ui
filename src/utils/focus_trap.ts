import { DetachGate, type DetachGateHost } from "./detach_gate";
import { EscapeLayer } from "./escape_layer";
import {
  canTakeFocus,
  closestInFlatTree,
  deepActiveElement,
  flatTreeChildren,
  flatTreeContains,
  flatTreeParent,
  isRenderedForFocus,
  sequentialTabStops,
  type TabStopElement,
} from "./focus_candidate";
import { MicrotaskCoalescer } from "./microtask_coalescer";
import { queryOpenDescendants } from "./query_open_descendants";
import { sharedRegistry } from "./shared_registry";
import { TabindexLoan } from "./tabindex_loan";

/**
 * Modal focus-trap primitive shared by the modal-overlay controllers
 * (dialog / alert-dialog / confirm / drawer / command-palette / sidebar); the
 * non-modal focus scope (focus) reuses it with the modal side effects opted out.
 *
 * The WAI-ARIA APG modal pattern is more than "cycle Tab inside a box": a modal
 * also locks background scroll, makes the rest of the page `inert` (so assistive
 * technology and pointer/Tab cannot reach it, honoring `aria-modal="true"`),
 * sends focus inside on open, and restores it to the opener on close — and every
 * one of those side effects must be reverted if the element is torn down while
 * open (a Turbo navigation mid-dialog). {@link FocusTrap} owns that whole modal
 * lifecycle so each controller only decides *when* to open/close and *what*
 * "close" means.
 *
 * **Tab.** While active, the trap takes every `Tab` and `Shift+Tab` itself: it
 * cancels the engine's move and focuses the next or previous stop, wrapping at the
 * ends, so where focus goes does not depend on the engine's settings (macOS Safari
 * skips buttons and links by default). The order is HTML's sequential navigation order
 * within the container, as {@link sequentialTabStops} computes it: positive `tabindex`
 * first, ascending, then the rest in tree order; a radio group stops once; open shadow
 * roots are walked in flat-tree order. Focus found outside the container enters at the
 * first stop on `Tab` and at the last on `Shift+Tab`. `Alt+Tab` (Safari's key for
 * moving to every control) is handled like `Tab`; `Ctrl+Tab`, `Meta+Tab`, a key that is
 * part of an IME composition, and a `Tab` an inner handler already consumed are left
 * alone. A move into a text input selects its text, as the engine's own `Tab` does.
 *
 * What the trap does not reach the way the engine does: an iframe is one stop, and
 * inside it the frame's own document moves focus, out of the frame included; a date
 * or time input is one stop, its fields left to the arrow keys; a scrollable region
 * with nothing focusable inside is not a stop unless it carries `tabindex="0"`; content
 * behind a closed shadow root is not reached; a `details` element without a `summary`
 * child is not reached, because script cannot focus the summary the engine generates for
 * it; an `embed` is not a stop.
 *
 * One listener per document resolves each `Tab` to one trap: the most recently
 * activated trap whose container is connected and rendered. A trap whose
 * container is gone or hidden passes the key to the one below it; with none left the
 * key is the engine's. The registry of each document — the stack, the listener, the
 * background and the scroll locks — is one per page (`sharedRegistry`), so the traps of
 * controllers imported from different files share it.
 *
 * **Background `inert` across traps.** The active traps of a document share one background. It
 * takes the shape of the most recently activated isolating trap: the other children of each element
 * from its container up to `body` in the flat tree are `inert` (a container inside an open shadow
 * root makes the rest of that shadow tree and the page around its host `inert`), while that
 * container, the containers of every trap activated after it, and their ancestors are not. A modal
 * opened over another modal it is not nested in (a confirm at the end of `<body>` asked from inside
 * a dialog) is therefore operable, and the modal below it is background until it closes. Releasing
 * a trap, in any order, hands the background to the traps still active. The traps only ever release
 * the `inert` they applied; an element that was `inert` before is neither tracked nor cleared. The
 * scroll lock is shared the same way: the first trap that locks the `body` saves its own
 * `overflow`, and the last one released gives it back to that `body`, also once another `body`
 * has taken its place in the document. A Turbo morph that drops the locked style and the saved
 * value while a trap is active is followed by a lock that saves the `overflow` the morph left.
 *
 * **Focus back across traps.** A release that restores focus tries a way back in order: the element
 * that held focus when the trap activated, then the open shadow hosts around that element,
 * innermost first (one that rendered its content again keeps no element to return to, and a host
 * that delegates focus or carries a `tabindex` still takes it), then `fallbackFocus`, then what
 * traps released before it handed over. A trap activated while focus sat inside another active
 * trap's container is opened from that trap, and when that trap is released first, with or without
 * restoring focus, it hands its way back to the trap opened from it, behind that trap's own.
 * Closing the last of a stack of traps therefore returns focus to where the first was opened from,
 * in whatever order the traps between them closed, unless an element earlier on the last trap's way
 * back, its own opener or its `fallbackFocus`, can still take focus. An element on the way back is
 * tried only while it is connected, can take focus and is rendered, and the next one is tried when
 * `focus()` leaves focus where it was. With nothing left to try, focus goes where activation sends
 * it in the trap that takes `Tab` now, unless that trap's `autoFocus` is off or focus is already
 * inside it. A release leaves focus alone while it sits in a trap activated after the released one
 * that takes `Tab`; focus still inside the released trap's own container counts only for a trap
 * nested inside that container.
 *
 * **Open shadow roots.** Where focus is, is read through open shadow roots, and which
 * container holds an element is read along the flat tree: a slotted element is inside the
 * slot it is assigned to, and an element in a shadow root is inside its host. Content behind
 * a closed shadow root reads as its host.
 *
 * **The Turbo cache.** An active trap keeps every side effect through `turbo:before-cache`,
 * which Turbo also dispatches on pages that stay (a frame navigation promoted to a visit, a
 * `popstate` without Turbo state, a refresh of a cached URL). A page Turbo restores is a copy,
 * taken at some point of the navigation, that can carry the side effects of a trap that was
 * active then. So the traps mark what they change: each element they make `inert` carries
 * `data-stimeo-focus-trap-inert`, a locked `body` carries its saved `overflow` in
 * `data-stimeo-focus-trap-overflow`, and a container they lend a `tabindex` carries
 * `data-stimeo-focus-trap-tabindex-loan`. {@link FocusTrap.connect} and
 * {@link FocusTrap.activate} release the marked `inert` and scroll lock no active trap holds,
 * and {@link FocusTrap.connect} takes back every `tabindex` the traps lent that no trap
 * holds, unless the element holds focus. Turbo's morph keeps only the attributes the
 * server sent, so it drops the marks with what they mark; an element that has lost its mark
 * is no longer the traps', so the next activation, release or refresh makes it `inert` again
 * where it is background and leaves an `inert` the server sent alone. While a trap is
 * active, a morph (`turbo:morph` after a page morph, `turbo:morph-element` for each element
 * any morph renders) is followed, before the next task, by one pass that does so and locks
 * the `body` again: the background of an open modal never stays operable after a morph.
 *
 * **Lifecycle.** A controller calls {@link FocusTrap.connect} from its `connect()` and
 * {@link FocusTrap.disconnect} from its `disconnect()`. A disconnect releases an active trap at
 * once without moving focus. A `tabindex` kept on a container that held focus at a release
 * survives an in-page move (a disconnect the reconnect of the same controller follows in the
 * same mutation batch), and is taken back, once focus is elsewhere, when the controller's
 * element has left the document, its `data-controller` no longer lists the identifier, or no
 * reconnect followed within a microtask.
 *
 * It is intentionally **policy-free about closing**. Escape semantics differ per
 * widget (a plain dialog just closes; an alert-dialog closes *as a cancel* with a
 * reason; a drawer runs an exit transition), so the trap merely forwards Escape
 * to an {@link FocusTrapOptions.onEscape | onEscape} callback and never decides on
 * its own what closing entails.
 *
 * @remarks
 * The container is read through a getter so a controller can hand over a Stimulus
 * target without worrying about when the trap instance is constructed relative to
 * `connect()`.
 */

/** Names the records the traps leave on the elements they change. */
const FOCUS_TRAP_OWNER = "stimeo-focus-trap";
/** Marks an element a trap made `inert`. */
const INERT_MARK = `data-${FOCUS_TRAP_OWNER}-inert`;
/** Holds, on a `body` a trap locked, the inline `overflow` it had before. */
const OVERFLOW_MARK = `data-${FOCUS_TRAP_OWNER}-overflow`;

/** Behavior hooks a controller supplies when constructing a {@link FocusTrap}. */
export interface FocusTrapOptions {
  /**
   * Called when `Escape` is pressed while the trap is active. When omitted,
   * `Escape` is left alone (the trap never joins the Escape stack). Dismissal
   * is resolved by the shared {@link EscapeLayer}: an Escape already consumed
   * by an inner handler is ignored, and among active layers the most recently
   * activated claiming one owns the press. The resolver consumes the event
   * before invoking the callback.
   */
  onEscape?: () => void;
  /**
   * Returns the element to focus when the trap activates. When it returns `null`
   * (or is omitted), the first stop of the trap's order is used, falling back to the
   * container itself. A container without a `tabindex` is lent `tabindex="-1"` for that,
   * taken back on release and when the trap moves onto another container, except while the
   * container holds focus: then the loan stays until a later release or move of the trap, or
   * the controller's detach, finds focus elsewhere; an in-page move of the controller keeps it.
   */
  initialFocus?: () => HTMLElement | null;
  /**
   * Returns the element to focus on deactivation (e.g. the trigger) when nothing was
   * focused before the trap opened, or the element focused before opening cannot take
   * focus at deactivation. The element focused before opening takes precedence while it
   * can.
   */
  fallbackFocus?: () => HTMLElement | null;
  /**
   * Lock background scroll (`body` overflow) while active. Defaults to `true` for
   * the modal overlays; a lighter focus scope passes `false`. Read on `activate`.
   */
  lockScroll?: boolean | (() => boolean);
  /**
   * Make background siblings `inert` while active (the `aria-modal` isolation).
   * Defaults to `true` for the modal overlays; a soft focus scope can opt out so
   * the background stays reachable while `Tab` still cycles inside. Read on `activate`,
   * and again on {@link FocusTrap.refreshIsolation}.
   */
  isolate?: boolean | (() => boolean);
  /**
   * Move focus inside on `activate`. Defaults to `true`; a focus scope that only
   * wants the `Tab` handling (no focus move) passes `false`. Read on `activate`, and
   * again on {@link FocusTrap.refreshContainer}.
   */
  autoFocus?: boolean | (() => boolean);
}

/** An active trap as its document's registry holds it, read and set through its fields alone. */
interface TrapEntry {
  /** The container, or `null` when it cannot be read. */
  readonly container: () => HTMLElement | null;
  /** Focuses the next stop, or the previous one when `backward`. */
  readonly moveFocus: (backward: boolean) => void;
  /** Focuses where activation does, unless `autoFocus` is off or focus is already inside. */
  readonly refocus: () => void;
  /**
   * `isolate` as read on activation or on the last refresh, kept apart from the `inert` the
   * traps applied, which is empty when every background element was already `inert`.
   */
  isolated: boolean;
  /** The `body` it locked, while it holds a scroll lock. */
  lockedBody: HTMLElement | null;
  /**
   * The most recently activated trap whose container held the opener when this trap
   * activated, while that trap is active: the one that hands this trap its way back if
   * released first.
   */
  openedFrom: TrapEntry | null;
  /** The way back handed over by traps released before it. */
  handedBack: HTMLElement[];
}

/**
 * A document's active traps, most recently activated last, its one `Tab` listener, its one
 * morph listener, the background elements the traps have made `inert`, and the active traps
 * that lock scroll.
 */
interface TrapRegistry {
  readonly stack: TrapEntry[];
  readonly onKeydown: (event: KeyboardEvent) => void;
  readonly onMorph: () => void;
  readonly inerted: Set<HTMLElement>;
  readonly scrollLocks: Set<TrapEntry>;
}

/**
 * Owns the modal side effects (scroll lock, background `inert`, `Tab` handling, focus
 * restore) for a single container, applied on {@link activate} and reverted on
 * {@link deactivate}.
 */
export class FocusTrap {
  /** Each document's trap registry; a WeakMap keeps documents collectible. */
  static readonly #registries = sharedRegistry(
    "stimeo-ui.focus-trap.registry.v2",
    () => new WeakMap<Document, TrapRegistry>(),
  );
  /** Input types whose text a move into the field selects. */
  static readonly #TEXT_ENTRY_TYPES = new Set([
    "text",
    "search",
    "email",
    "url",
    "tel",
    "password",
    "number",
  ]);

  /**
   * The element focused before activation and the open shadow hosts around it, innermost
   * first: the start of the way back.
   */
  #openers: HTMLElement[] = [];
  /** This trap as its document's registry holds it. */
  readonly #entry: TrapEntry;
  /** The `tabindex` lent to each container that had no stop to focus, by container. */
  readonly #tabindexLoans = new Map<HTMLElement, TabindexLoan>();
  /** Whether the modal side effects are currently applied. */
  #activeState = false;
  /** Registers the trap on the shared Escape stack while active (see {@link EscapeLayer}). */
  readonly #escapeLayer = new EscapeLayer();
  /** Tells an in-page move of the controller from its detach, for a kept `tabindex`. */
  readonly #gate = new DetachGate();

  /** Returns the trapped element; called on every operation for the live target. */
  readonly #getContainer: () => HTMLElement;
  /** Closing/focus hooks; see {@link FocusTrapOptions}. */
  readonly #options: FocusTrapOptions;

  /**
   * @param getContainer - Returns the trapped element. Called on every operation
   *   so the live target is always used.
   * @param options - Closing/focus hooks; see {@link FocusTrapOptions}.
   */
  constructor(getContainer: () => HTMLElement, options: FocusTrapOptions = {}) {
    this.#getContainer = getContainer;
    this.#options = options;
    this.#entry = {
      container: () => this.#readContainer(),
      moveFocus: (backward) => this.#moveFocus(backward),
      refocus: () => this.#refocus(),
      isolated: false,
      lockedBody: null,
      openedFrom: null,
      handedBack: [],
    };
  }

  /** Whether the trap is currently active. */
  get active(): boolean {
    return this.#activeState;
  }

  /**
   * Applies the trap: releases the marked `inert` and scroll lock no active trap holds,
   * records the current focus and the active trap it sits in, optionally locks background
   * scroll and makes background siblings `inert`, takes the top of the document's `Tab`
   * resolver, joins the Escape stack when `onEscape` is given, and (unless `autoFocus` is off)
   * moves focus inside. No-ops if already active.
   */
  activate(): void {
    if (this.#activeState) return;
    FocusTrap.#sweep();
    this.#activeState = true;
    this.#openers = FocusTrap.#focusPath();
    this.#entry.openedFrom = FocusTrap.#trapHolding(this.#openers[0] ?? null);
    if (this.#flag(this.#options.lockScroll, true)) this.#lockScroll();
    this.#entry.isolated = this.#flag(this.#options.isolate, true);
    this.#joinStack();
    FocusTrap.#reconcileBackground(document);
    const onEscape = this.#options.onEscape;
    if (onEscape) this.#escapeLayer.activate(document, { onDismiss: () => onEscape() });
    if (this.#flag(this.#options.autoFocus, true)) this.#focusInitial();
  }

  /**
   * Reverts every side effect applied by {@link activate}, hands the way back to each active
   * trap opened from this one, and, once focus has moved, takes back the `tabindex` lent to a
   * container that does not hold focus. While inactive it only takes back a `tabindex` kept on
   * a container that no longer holds focus, so a controller can call it defensively from
   * `close()`. A controller's `disconnect()` calls {@link disconnect} instead.
   *
   * @param restoreFocus - Move focus back along the way back (default `true`): the opener,
   *   `fallbackFocus`, then what was handed over. Pass `false` where yanking focus is
   *   undesirable; the way back is handed over either way.
   */
  deactivate({ restoreFocus = true }: { restoreFocus?: boolean } = {}): void {
    if (!this.#activeState) {
      this.#returnTabindexes();
      return;
    }
    this.#activeState = false;
    this.#escapeLayer.deactivate();
    const above = this.#leaveStack();
    this.#unlockScroll();
    FocusTrap.#reconcileBackground(document);
    const wayBack = this.#handOver(above);
    if (restoreFocus) this.#restore(wayBack, above);
    this.#returnTabindexes();
  }

  /**
   * Call from the controller's `connect()`: a reconnect that follows {@link disconnect} in the
   * same mutation batch is an in-page move, and a `tabindex` kept on a container that held
   * focus at a release stays lent. Releases the marked `inert` and scroll lock no active trap
   * holds, and takes back every `tabindex` the traps lent that no trap holds, unless the
   * element holds focus: what a page restored from Turbo's cache carries, on the container
   * and on one a trap moved off.
   */
  connect(): void {
    this.#gate.cancel();
    FocusTrap.#sweep();
    new TabindexLoan("-1", FOCUS_TRAP_OWNER).reclaimWithin(document);
  }

  /**
   * Call from the controller's `disconnect()`, passing the controller. An active trap is
   * released at once without moving focus, as {@link deactivate} with `restoreFocus: false`
   * does. Then a `tabindex` kept on a container that no longer holds focus is taken back at
   * once when the controller's element has left the document or its `data-controller` no
   * longer lists the identifier, and otherwise a microtask later unless {@link connect} came
   * first.
   *
   * @param host - The controller: its `element` and `identifier` tell a detach from an
   *   in-page move.
   */
  disconnect(host: DetachGateHost): void {
    if (this.#activeState) this.deactivate({ restoreFocus: false });
    this.#gate.disconnected(host, () => this.#returnTabindexes());
  }

  /**
   * Re-reads `isolate` while active and applies the difference in place: the shared
   * background is brought in line with the traps' new state, so it is made `inert` when
   * this trap's isolation turned on and released when it turned off — only ever the
   * `inert` the traps applied. The recorded opener, the Escape layer, the place in the
   * trap stack and the scroll lock are left as they are. No-op while inactive or when
   * the option reads as it did.
   *
   * Focus moves only when isolating would strand it: an element in the background this
   * call just made `inert` loses focus to `<body>`, so focus goes where activation sends
   * it — the initial target, the first stop, the container. Focus already inside, on
   * `<body>`, or anywhere a release reaches stays where it is.
   */
  refreshIsolation(): void {
    if (!this.#activeState) return;
    const isolate = this.#flag(this.#options.isolate, true);
    if (isolate === this.#entry.isolated) return;
    this.#entry.isolated = isolate;
    const stranded = FocusTrap.#reconcileBackground(document);
    const active = deepActiveElement(document);
    if (stranded.some((element) => flatTreeContains(element, active))) this.#focusInitial();
  }

  /**
   * Moves the active trap onto the container its getter returns now, keeping its place in the
   * trap stack, the way back (the recorded opener, what was handed over and the trap it was
   * opened from), the Escape layer and the scroll lock, brings the shared background in line
   * with the new container, and takes back the `tabindex` lent to the old one unless it holds
   * focus; that loan stays until a later release or move of the trap, or the controller's
   * detach, finds focus elsewhere. Focus moves where activation sends it only when `Tab`
   * resolves to this trap, `autoFocus` is on and focus is outside the new container. No-op
   * while inactive.
   */
  refreshContainer(): void {
    if (!this.#activeState) return;
    FocusTrap.#reconcileBackground(document);
    this.#returnTabindexes();
    if (this.#ownsTab()) this.#refocus();
  }

  /** Resolves a boolean-or-getter option, defaulting when it was not provided. */
  #flag(option: boolean | (() => boolean) | undefined, fallback: boolean): boolean {
    if (option === undefined) return fallback;
    return typeof option === "function" ? option() : option;
  }

  /**
   * Puts this trap on top of the document's stack; the first trap installs the `Tab` listener
   * and the morph listener.
   */
  #joinStack(): void {
    const registry = FocusTrap.#registry(document);
    if (registry.stack.length === 0) {
      document.addEventListener("keydown", registry.onKeydown);
      document.addEventListener("turbo:morph", registry.onMorph);
      document.addEventListener("turbo:morph-element", registry.onMorph);
    }
    registry.stack.push(this.#entry);
  }

  /**
   * Takes this trap off the document's stack and returns the traps activated after it; the last
   * trap removes the `Tab` listener and the morph listener. A pass a morph scheduled before
   * then finds no trap and changes nothing.
   */
  #leaveStack(): TrapEntry[] {
    const registry = FocusTrap.#registry(document);
    const index = registry.stack.indexOf(this.#entry);
    const above = registry.stack.slice(index + 1);
    registry.stack.splice(index, 1);
    if (registry.stack.length === 0) {
      document.removeEventListener("keydown", registry.onKeydown);
      document.removeEventListener("turbo:morph", registry.onMorph);
      document.removeEventListener("turbo:morph-element", registry.onMorph);
    }
    return above;
  }

  /**
   * The element that holds focus, then the open shadow hosts around it, innermost first. Empty
   * when nothing holds focus: `<body>`, the default active element, is treated as nothing, so
   * the way back starts at the fallback target, typically the trigger.
   */
  static #focusPath(): HTMLElement[] {
    const path: HTMLElement[] = [];
    for (
      let active = document.activeElement;
      active;
      active = active.shadowRoot?.activeElement ?? null
    ) {
      if (active instanceof HTMLElement && active !== document.body) path.unshift(active);
    }
    return path;
  }

  /**
   * The most recently activated trap on the document's stack whose container holds `element`
   * in the flat tree.
   */
  static #trapHolding(element: HTMLElement | null): TrapEntry | null {
    for (const trap of [...FocusTrap.#registry(document).stack].reverse()) {
      const container = trap.container();
      if (container && flatTreeContains(container, element)) return trap;
    }
    return null;
  }

  /**
   * Ends this activation's way back: the opener and the shadow hosts around it, `fallbackFocus` and
   * what was handed over, in that order. Each trap in `above` opened from this one gets it behind
   * its own and is pointed at the trap this one was opened from, so the links only ever lead to
   * traps activated earlier. The record is cleared before anything moves focus, so an activation a
   * focus listener starts keeps its own.
   */
  #handOver(above: TrapEntry[]): HTMLElement[] {
    const entry = this.#entry;
    const wayBack = [
      ...this.#openers,
      this.#options.fallbackFocus?.() ?? null,
      ...entry.handedBack,
    ].filter((element): element is HTMLElement => element !== null);
    for (const trap of above) {
      if (trap.openedFrom !== entry) continue;
      trap.handedBack = [...trap.handedBack, ...wayBack];
      trap.openedFrom = entry.openedFrom;
    }
    this.#openers = [];
    entry.openedFrom = null;
    entry.handedBack = [];
    return wayBack;
  }

  /**
   * Moves focus back after a release, unless focus sits in a trap of `above` that takes `Tab`
   * (focus inside this trap's own container counts only for a trap nested inside it): to the
   * first element of `wayBack` that is connected, can take focus and is rendered, and that
   * `focus()` moves focus to (or that a focus listener sends elsewhere); with none, where
   * activation sends it in the trap that takes `Tab` now, unless that trap's `autoFocus` is off
   * or focus is already inside it. A focus listener that activates this trap again ends it.
   */
  #restore(wayBack: HTMLElement[], above: TrapEntry[]): void {
    const active = deepActiveElement(document);
    const released = this.#readContainer();
    const holds = (trap: TrapEntry): boolean => {
      const container = trap.container();
      if (!container || !FocusTrap.#takesTab(trap) || !flatTreeContains(container, active)) {
        return false;
      }
      return (
        !released || !flatTreeContains(released, active) || flatTreeContains(released, container)
      );
    };
    if (above.some(holds)) return;
    for (const element of wayBack) {
      if (this.#activeState) return;
      if (!element.isConnected || !canTakeFocus(element) || !isRenderedForFocus(element)) continue;
      const before = deepActiveElement(document);
      element.focus();
      const after = deepActiveElement(document);
      if (after === element || after !== before) return;
    }
    FocusTrap.#tabOwner(FocusTrap.#registry(document).stack)?.refocus();
  }

  /** Focuses where activation does, unless `autoFocus` is off or focus is already inside. */
  #refocus(): void {
    if (!this.#flag(this.#options.autoFocus, true)) return;
    if (flatTreeContains(this.#getContainer(), deepActiveElement(document))) return;
    this.#focusInitial();
  }

  /** Lends `container` `tabindex="-1"` so it can take focus; no-op when it carries a `tabindex`. */
  #lendTabindex(container: HTMLElement): void {
    const loan = this.#tabindexLoans.get(container) ?? new TabindexLoan("-1", FOCUS_TRAP_OWNER);
    loan.lend(container);
    this.#tabindexLoans.set(container, loan);
  }

  /**
   * Takes back each lent `tabindex` except the one on the element that holds focus: removing
   * it there drops focus to `<body>`, and that element can be where the next trap returns
   * focus to. That loan stays until a later release or move of this trap, or the controller's
   * detach, finds focus elsewhere.
   */
  #returnTabindexes(): void {
    const focused = deepActiveElement(document);
    for (const [element, loan] of [...this.#tabindexLoans]) {
      if (element === focused) continue;
      loan.returnAll();
      this.#tabindexLoans.delete(element);
    }
  }

  /**
   * Locks the `body`'s scroll for this trap. A lock on a `body` that carries no saved
   * `overflow` saves its inline one on it: the first lock does, and so does a lock taken
   * after a Turbo morph dropped the saved value along with the locked style, while a lock
   * taken over another one does not save the locked value as the page's own.
   */
  #lockScroll(): void {
    const registry = FocusTrap.#registry(document);
    const body = document.body;
    if (!body.hasAttribute(OVERFLOW_MARK)) body.setAttribute(OVERFLOW_MARK, body.style.overflow);
    registry.scrollLocks.add(this.#entry);
    this.#entry.lockedBody = body;
    body.style.overflow = "hidden";
  }

  /**
   * Releases this trap's scroll lock, if it holds one. The last lock on the `body` it locked,
   * released in whatever order, gives that `body` its saved `overflow` back, while the `body`
   * still carries it.
   */
  #unlockScroll(): void {
    const registry = FocusTrap.#registry(document);
    const body = this.#entry.lockedBody;
    this.#entry.lockedBody = null;
    if (!registry.scrollLocks.delete(this.#entry) || !body) return;
    if (!FocusTrap.#isLocked(registry, body)) FocusTrap.#unlock(body);
  }

  /** Whether an active trap holds a scroll lock on `body`. */
  static #isLocked(registry: TrapRegistry, body: HTMLElement): boolean {
    return [...registry.scrollLocks].some((trap) => trap.lockedBody === body);
  }

  /** Gives `body` the `overflow` its mark saved and drops the mark; no mark, no change. */
  static #unlock(body: HTMLElement): void {
    const saved = body.getAttribute(OVERFLOW_MARK);
    if (saved === null) return;
    body.removeAttribute(OVERFLOW_MARK);
    body.style.overflow = saved;
  }

  /**
   * Releases the marked side effects no active trap holds: the `inert` of each marked
   * element the traps do not track, and the scroll lock of a marked `body` no trap locked.
   */
  static #sweep(): void {
    const registry = FocusTrap.#registry(document);
    for (const element of queryOpenDescendants<HTMLElement>(document, `[${INERT_MARK}]`)) {
      if (registry.inerted.has(element)) continue;
      element.removeAttribute(INERT_MARK);
      element.inert = false;
    }
    if (!FocusTrap.#isLocked(registry, document.body)) FocusTrap.#unlock(document.body);
  }

  /** The document's trap registry, created on first use. */
  static #registry(ownerDocument: Document): TrapRegistry {
    const existing = FocusTrap.#registries.get(ownerDocument);
    if (existing) return existing;
    const morphs = new MicrotaskCoalescer(() => FocusTrap.#reapply(registry));
    morphs.activate();
    const registry: TrapRegistry = {
      stack: [],
      onKeydown: (event) => FocusTrap.#resolveTab(registry.stack, event),
      onMorph: () => morphs.schedule(),
      inerted: new Set(),
      scrollLocks: new Set(),
    };
    FocusTrap.#registries.set(ownerDocument, registry);
    return registry;
  }

  /**
   * Puts back what a Turbo morph took from the active traps, which keeps only the attributes
   * the server sent: the background's `inert` and marks, and a locked `body`'s `overflow`
   * with its saved value, saving the `overflow` the morph left.
   */
  static #reapply(registry: TrapRegistry): void {
    FocusTrap.#reconcileBackground(document);
    const body = document.body;
    if (!FocusTrap.#isLocked(registry, body)) return;
    if (!body.hasAttribute(OVERFLOW_MARK)) body.setAttribute(OVERFLOW_MARK, body.style.overflow);
    body.style.overflow = "hidden";
  }

  /**
   * Brings the document's background `inert` in line with its stack of active traps, as
   * `#backgroundOf` computes it: an element the traps made `inert` that is no longer
   * background is released, and background that is not `inert` yet is made so, marked and
   * tracked. A tracked element that has lost its mark is no longer the traps' — a Turbo
   * morph keeps only the attributes the server sent, taking the mark with the `inert`, or
   * keeping an `inert` of the server's own — so it is forgotten first and judged like any
   * other element. Returns the elements this call made `inert`.
   */
  static #reconcileBackground(ownerDocument: Document): HTMLElement[] {
    const registry = FocusTrap.#registry(ownerDocument);
    for (const element of registry.inerted) {
      if (!element.hasAttribute(INERT_MARK)) registry.inerted.delete(element);
    }
    const background = FocusTrap.#backgroundOf(registry);
    for (const element of registry.inerted) {
      if (background.has(element)) continue;
      element.removeAttribute(INERT_MARK);
      element.inert = false;
      registry.inerted.delete(element);
    }
    const added: HTMLElement[] = [];
    for (const element of background) {
      if (registry.inerted.has(element)) continue;
      element.setAttribute(INERT_MARK, "");
      element.inert = true;
      registry.inerted.add(element);
      added.push(element);
    }
    return added;
  }

  /**
   * The elements the stack wants `inert`. Without an isolating trap, none. Otherwise the shape of
   * the most recently activated isolating trap: its container and the container's ancestors below
   * `body` are kept, and every other child of their parents is background, all in the flat tree.
   * Scanning only `body`'s children would miss the branch a container sits in, and a nested
   * container is the ordinary case. A trap activated after it that sits in that background is
   * carved out of it the same way, down its own branch; one inside the kept part adds nothing, so a
   * trap that does not isolate never makes more of the page `inert`. An element that is `inert`
   * without the traps having made it so is left out, so it is neither tracked, lifted nor released.
   * A trap whose container cannot be read counts as neither isolating nor kept.
   */
  static #backgroundOf(registry: TrapRegistry): Set<HTMLElement> {
    const containers = registry.stack.map((trap) => trap.container());
    let top = -1;
    registry.stack.forEach((trap, index) => {
      if (trap.isolated && containers[index]) top = index;
    });
    const background = new Set<HTMLElement>();
    if (top < 0) return background;
    const kept = new Set<Element>();
    const keep = (path: Element[]): void => {
      for (const node of path) {
        kept.add(node);
        background.delete(node as HTMLElement);
      }
      for (const node of path) {
        const parent = flatTreeParent(node);
        for (const sibling of parent ? flatTreeChildren(parent) : []) {
          if (!(sibling instanceof HTMLElement) || kept.has(sibling)) continue;
          if (sibling.inert && !registry.inerted.has(sibling)) continue;
          background.add(sibling);
        }
      }
    };
    containers.slice(top).forEach((container, index) => {
      const path: Element[] = [];
      for (
        let node: Element | null = container;
        node && node !== document.body && !kept.has(node);
      ) {
        path.push(node);
        node = flatTreeParent(node);
      }
      if (index === 0 || path.some((node) => background.has(node as HTMLElement))) keep(path);
    });
    return background;
  }

  /**
   * The container, or `null` when the getter throws (a controller whose target has left
   * the page). The shared stack reads every trap's container; one that cannot be read
   * must not break `Tab` or the background for the others.
   */
  #readContainer(): HTMLElement | null {
    try {
      return this.#getContainer();
    } catch {
      return null;
    }
  }

  /**
   * Hands a keydown to the trap that takes it. The shared listener runs in the document
   * bubble phase, after element-level handlers, so a `Tab` an inner widget consumed is
   * left to that widget.
   */
  static #resolveTab(stack: TrapEntry[], event: KeyboardEvent): void {
    if (event.key !== "Tab" || event.defaultPrevented) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (event.ctrlKey || event.metaKey) return;
    const owner = FocusTrap.#tabOwner(stack);
    if (!owner) return;
    event.preventDefault();
    owner.moveFocus(event.shiftKey);
  }

  /** The most recently activated trap whose container can take `Tab`, or `null`. */
  static #tabOwner(stack: TrapEntry[]): TrapEntry | null {
    for (const trap of [...stack].reverse()) {
      if (FocusTrap.#takesTab(trap)) return trap;
    }
    return null;
  }

  /**
   * Whether the trap's container can be read, is connected and is rendered (no `hidden` on it
   * or on a flat-tree ancestor), so the trap can take `Tab`.
   */
  static #takesTab(trap: TrapEntry): boolean {
    const container = trap.container();
    if (!container) return false;
    return (
      container.isConnected &&
      !closestInFlatTree(container, "[hidden]") &&
      isRenderedForFocus(container)
    );
  }

  /** Whether this trap is the one its document's `Tab` resolves to. */
  #ownsTab(): boolean {
    return FocusTrap.#tabOwner(FocusTrap.#registry(document).stack) === this.#entry;
  }

  /**
   * Focuses the next stop from where focus is (the previous one when `backward`),
   * wrapping at the ends. The stops are checked before focusing, and a `focus()` that
   * still leaves focus where it was (an engine without `checkVisibility` cannot see a
   * stop hidden by CSS) moves on to the following stop, each stop tried at most once.
   * Focus and blur listeners run inside `focus()` and can release this trap or activate
   * another one, so every attempt first checks that this trap still owns `Tab`. A
   * listener that sends focus elsewhere is left to do so.
   */
  #moveFocus(backward: boolean): void {
    const from = deepActiveElement(document);
    for (const stop of sequentialTabStops(this.#getContainer(), from, backward)) {
      if (!this.#ownsTab()) return;
      const before = deepActiveElement(document);
      stop.focus();
      const after = deepActiveElement(document);
      if (after === before) continue;
      if (after === stop) FocusTrap.#selectOnEntry(stop);
      return;
    }
  }

  /** Selects the text of an input that focus moved into, as the engine's own `Tab` does. */
  static #selectOnEntry(stop: TabStopElement): void {
    if (stop instanceof HTMLInputElement && FocusTrap.#TEXT_ENTRY_TYPES.has(stop.type)) {
      stop.select();
    }
  }

  /** Moves focus to the initial target, the first stop of the trap's order, or the container. */
  #focusInitial(): void {
    const preferred = this.#options.initialFocus?.();
    if (preferred) {
      preferred.focus();
      return;
    }
    const container = this.#getContainer();
    const [first] = sequentialTabStops(container);
    if (first) {
      first.focus();
      return;
    }
    this.#lendTabindex(container);
    container.focus();
  }
}
