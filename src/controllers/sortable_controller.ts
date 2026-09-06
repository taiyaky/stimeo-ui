import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { isRtl } from "../utils/logical_scroll";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

/** The four steps a consumer can give wording to. */
type AnnounceKey = "grabbed" | "moved" | "dropped" | "canceled";

/** A reorder in flight: one item picked up by pointer or keyboard. */
interface SortSession {
  item: HTMLElement;
  /**
   * The item that followed it at pickup, and the one that preceded it.
   *
   * The pickup slot is remembered as nodes rather than as an index because the
   * list can change underneath a live drag — a broadcast board inserts and
   * deletes rows while someone is holding one — and an index taken at pickup
   * stops pointing at that place the moment a row appears above it.
   */
  anchor: HTMLElement | null;
  predecessor: HTMLElement | null;
  /** Last primary-axis cumulative delta consumed by keyboard stepping. */
  lastPrimary: number;
}

/**
 * Headless, accessible **sortable** (single-list reorder) — the a11y-first
 * drag-and-drop that is the flagship consumer of the
 * `stimeo--pointer-drag` primitive. The composition is markup-level and each
 * layer keeps its job: `pointer-drag` (on every item) emits the normalized drag
 * signal with its built-in keyboard alternative, `roving` (on the list) keeps
 * the handles a single Tab stop, and this controller interprets the signal —
 * live-reordering the DOM, handing each step to the page's shared announcer,
 * and reporting the final `reorder`. No dedicated APG pattern exists for
 * drag-and-drop; the keyboard model (grab → arrows → drop / Escape) comes from
 * `pointer-drag` and the announcements make it non-visually trackable
 * (WCAG 2.1.1 / 2.5.7 / 4.1.3). Core (zero dependencies).
 *
 * Markup contract (identifier: `stimeo--sortable`):
 *   <div data-controller="stimeo--sortable">
 *     <ul data-stimeo--sortable-target="list" data-controller="stimeo--roving"
 *         data-stimeo--roving-orientation-value="vertical">
 *       <li data-stimeo--sortable-target="item" data-stimeo--sortable-name="Card A"
 *           data-controller="stimeo--pointer-drag"
 *           data-stimeo--pointer-drag-axis-value="y">
 *         <span>Card A</span>
 *         <button type="button" aria-label="Reorder Card A"
 *                 data-stimeo--pointer-drag-target="handle"
 *                 data-stimeo--roving-target="item">⠿</button>
 *       </li>
 *       …
 *     </ul>
 *   </div>
 *
 * The composed values must follow the sort axis: roving's `orientation`
 * (which defaults to `horizontal`, so a vertical list has to author
 * `vertical`) and pointer-drag's `axis`. `stimeo check` enforces both
 * alignments as composition rules (`composition-mismatch`).
 *
 * Pointer flow: dragging an item live-moves it whenever the pointer crosses a
 * sibling's midpoint (per `orientation`). Keyboard flow: each synthetic
 * `pointer-drag` move steps the item one position. A horizontal list under
 * `dir="rtl"` reverses both, since DOM order then runs right-to-left while
 * `pointer-drag` reports physical coordinates. Dropping dispatches
 * `reorder` (`{ item, from, to }`, zero-based) when the position changed;
 * Escape / `pointercancel` restores the pickup position. Every step is handed to
 * the page's shared `stimeo--announcer` as the consumer's own wording —
 * `announceGrabbedText` / `announceMovedText` / `announceDroppedText` /
 * `announceCanceledText`, with `{name}` / `{position}` / `{total}` placeholders —
 * and an unset one announces nothing.
 *
 * @remarks
 * Behavior only — the ghost/placeholder/drop-hint visuals are the consumer's
 * CSS, keyed off `pointer-drag`'s `data-dragging`/`data-grabbed` on the item
 * and this controller's `data-sortable-dragging` on the root. Persistence is
 * the consumer's `reorder` listener (post the new position; a Turbo Stream
 * broadcast makes the board collaborative). The DOM order is the single source
 * of truth: items are read live on every event, so rows appended by Turbo need
 * no rewiring, and a Turbo cache restore reconnects idempotently (`connect()`
 * clears the transient root hook; a drag cannot survive a navigation). Only the
 * event listeners are held, and they are removed on `disconnect()`. Multi-list
 * / kanban, nested DnD, auto-scroll at the edges, and virtualized lists are
 * deliberately out of this single-list scope.
 */
export class SortableController extends Controller<HTMLElement> {
  static override targets = ["list", "item"];
  static override values = {
    orientation: { type: String, default: "vertical" },
    announceGrabbedText: { type: String, default: "" },
    announceMovedText: { type: String, default: "" },
    announceDroppedText: { type: String, default: "" },
    announceCanceledText: { type: String, default: "" },
  };
  static events = ["reorder"] as const;

  declare readonly hasListTarget: boolean;
  declare readonly listTarget: HTMLElement;
  declare readonly itemTargets: HTMLElement[];
  declare orientationValue: string;
  declare announceGrabbedTextValue: string;
  declare announceMovedTextValue: string;
  declare announceDroppedTextValue: string;
  declare announceCanceledTextValue: string;

  #session: SortSession | null = null;
  /** Defers the lost-item check to after the mutation batch (see below). */
  readonly #settle = new MicrotaskCoalescer(() => this.#dropLostSession());

  override connect(): void {
    // A drag cannot survive a navigation: drop the hook a Turbo cache snapshot
    // may have preserved mid-drag (idempotent reconnect).
    this.element.removeAttribute("data-sortable-dragging");
    this.#settle.activate();
    this.element.addEventListener("stimeo--pointer-drag:start", this.#onDragStart);
    this.element.addEventListener("stimeo--pointer-drag:move", this.#onDragMove);
    this.element.addEventListener("stimeo--pointer-drag:end", this.#onDragEnd);
    this.element.addEventListener("stimeo--pointer-drag:cancel", this.#onDragCancel);
  }

  override disconnect(): void {
    this.element.removeEventListener("stimeo--pointer-drag:start", this.#onDragStart);
    this.element.removeEventListener("stimeo--pointer-drag:move", this.#onDragMove);
    this.element.removeEventListener("stimeo--pointer-drag:end", this.#onDragEnd);
    this.element.removeEventListener("stimeo--pointer-drag:cancel", this.#onDragCancel);
    this.#settle.cancel();
    this.#session = null;
    this.element.removeAttribute("data-sortable-dragging");
  }

  /**
   * Ends a session whose item left the item set.
   *
   * The controller's own reorder detaches and reattaches the item inside one
   * mutation batch, so the loss is only real once the batch has settled — the
   * check therefore runs a microtask later and asks whether the item is a target
   * again. Without it a deleted row (a broadcast that drops it from the board)
   * or a morph that strips the item's target attribute would hold the
   * one-at-a-time session for the rest of the page's life, with the root hook
   * stuck on and every later grab refused with no way out.
   */
  itemTargetDisconnected(item: HTMLElement): void {
    if (this.#session?.item !== item) return;
    this.#settle.schedule();
  }

  #dropLostSession(): void {
    const session = this.#session;
    if (!session) return;
    const items = this.#items();
    if (items.includes(session.item)) return;
    this.#session = null;
    this.element.removeAttribute("data-sortable-dragging");
    // An element that is still in the document (a morph took only its target
    // attribute) goes back where it was picked up. Nothing is announced either
    // way: the row is no longer one of the items, so there is no position to
    // read out — what matters is that the next grab is not refused.
    if (session.item.isConnected) this.#restore(session, items);
  }

  /** Picks the item up: remembers its neighbours and announces the grab. */
  readonly #onDragStart = (event: Event): void => {
    // One reorder at a time: a start from another item (each item has its own
    // pointer-drag instance) must not clobber the live session — its pickup
    // slot and cancel restore would be lost.
    if (this.#session) return;
    const items = this.#items();
    const item = this.#itemFor(event.target, items);
    if (!item) return;
    const index = items.indexOf(item);
    this.#session = {
      item,
      anchor: items[index + 1] ?? null,
      predecessor: items[index - 1] ?? null,
      lastPrimary: 0,
    };
    this.element.setAttribute("data-sortable-dragging", "true");
    this.#announce("grabbed", item);
  };

  readonly #onDragMove = (event: Event): void => {
    const session = this.#session;
    if (!session) return;
    const items = this.#items();
    if (this.#itemFor(event.target, items) !== session.item) return;

    const detail = (event as CustomEvent<Record<string, number | string>>).detail;
    if (detail.pointerType === "keyboard") {
      this.#stepFromKeyboard(session, detail, items);
    } else {
      this.#followPointer(session, detail, items);
    }
  };

  /** Drops the item: announces, then reports `reorder` if the position changed. */
  readonly #onDragEnd = (event: Event): void => {
    const session = this.#session;
    if (!session) return;
    const items = this.#items();
    if (this.#itemFor(event.target, items) !== session.item) return;
    this.#session = null;
    this.element.removeAttribute("data-sortable-dragging");
    this.#announce("dropped", session.item);
    const to = items.indexOf(session.item);
    const from = this.#pickupSlot(session, items) ?? to;
    if (to !== from) {
      this.dispatch("reorder", { detail: { item: session.item, from, to } });
    }
  };

  /** Restores the pickup position (Escape / OS `pointercancel`). */
  readonly #onDragCancel = (event: Event): void => {
    const session = this.#session;
    if (!session) return;
    const items = this.#items();
    if (this.#itemFor(event.target, items) !== session.item) return;
    this.#session = null;
    this.element.removeAttribute("data-sortable-dragging");
    this.#restore(session, items);
    this.#announce("canceled", session.item);
  };

  /**
   * The slot the item was picked up from, read back through the neighbours it
   * had then — `null` when neither survives and the item itself is gone.
   *
   * The anchor is the item that followed it, so restoring means "before that one
   * again". When the anchor was deleted mid-drag the predecessor answers the
   * same question from the other side. With both gone the item's current slot is
   * the honest answer: nothing is known to have moved, so no reorder is reported
   * and a cancel leaves the item where it is.
   */
  #pickupSlot(session: SortSession, items: HTMLElement[]): number | null {
    const others = items.filter((candidate) => candidate !== session.item);
    if (session.anchor) {
      const at = others.indexOf(session.anchor);
      if (at !== -1) return at;
    }
    if (session.predecessor) {
      const at = others.indexOf(session.predecessor);
      if (at !== -1) return at + 1;
    }
    const here = items.indexOf(session.item);
    return here === -1 ? null : here;
  }

  /** Puts the item back where it was picked up from. */
  #restore(session: SortSession, items: HTMLElement[]): void {
    const slot = this.#pickupSlot(session, items);
    if (slot === null) return;
    this.#insertAt(
      session.item,
      items.filter((candidate) => candidate !== session.item),
      slot,
    );
  }

  /**
   * Keyboard stepping: `pointer-drag` reports *cumulative* synthetic deltas, so
   * the difference from the last consumed value is one arrow press — its sign is
   * the direction. Cross-axis arrows never change the primary delta (no move).
   *
   * The sign is physical (`ArrowRight` is always `+dx`), so a right-to-left row
   * has to invert it: there, moving the item rightward means moving it *earlier*
   * in the DOM. Skipping this would also split the two halves of one keypress —
   * `roving` already moves focus logically, so the same arrow would send the
   * focus and the grabbed item opposite ways.
   */
  #stepFromKeyboard(
    session: SortSession,
    detail: Record<string, number | string>,
    items: HTMLElement[],
  ): void {
    const primary = Number(this.#isVertical ? detail.dy : detail.dx) || 0;
    const delta = primary - session.lastPrimary;
    session.lastPrimary = primary;
    if (delta === 0) return;

    const index = items.indexOf(session.item);
    const step = (delta > 0 ? 1 : -1) * (this.#isReversed ? -1 : 1);
    const next = Math.max(0, Math.min(index + step, items.length - 1));
    if (next === index) return;
    this.#insertAt(
      session.item,
      items.filter((candidate) => candidate !== session.item),
      next,
    );
    this.#announce("moved", session.item);
  }

  /**
   * Pointer following: the item moves to the slot whose siblings' midpoints the
   * pointer has passed (per `orientation`).
   *
   * Only siblings that occupy space take part. A row with no layout box — a
   * filtered-out item, a `display: none` ancestor, a collapsed `<details>` — is
   * reported with an empty rect at the document origin, and its midpoint of `0`
   * sits below every pointer position: counted, it would read as passed on the
   * very first move and send the item across a slot the pointer never crossed.
   * With no laid-out sibling at all there is nothing to compare against and the
   * move is skipped entirely.
   */
  #followPointer(
    session: SortSession,
    detail: Record<string, number | string>,
    items: HTMLElement[],
  ): void {
    const pointer = Number(this.#isVertical ? detail.y : detail.x) || 0;
    const vertical = this.#isVertical;
    // `target` counts the siblings that precede the pointer *in DOM order*, and
    // the two agree only while DOM order runs the same way as the coordinate. In
    // a right-to-left row it runs the other way, so the comparison flips;
    // leaving it physical would mix two orderings into one number and drop the
    // item at a slot the pointer never crossed. Resolved once: it cannot change
    // mid-loop, and reading it per sibling would re-run `getComputedStyle` on
    // every pointermove.
    const reversed = this.#isReversed;
    const here = items.indexOf(session.item);
    const laidOut: HTMLElement[] = [];
    let target = 0;
    // `current` is the item's own slot in that same laid-out space: the number
    // of laid-out siblings that come before it in DOM order.
    let current = 0;
    items.forEach((item, index) => {
      if (item === session.item) return;
      const rect = item.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      if (index < here) current += 1;
      laidOut.push(item);
      const midpoint = vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
      if (reversed ? pointer < midpoint : pointer > midpoint) target += 1;
    });
    if (laidOut.length === 0 || target === current) return;

    this.#insertAt(session.item, laidOut, target);
    this.#announce("moved", session.item);
  }

  /**
   * Reinserts `item` at `index` among `scope`, relative to the sibling already
   * standing there.
   *
   * The reorder is defined against the items, not against a container: the
   * neighbour's own parent is where the item belongs. A `list` target that is
   * not the items' parent — or none at all, which the markup contract allows —
   * therefore still lands the move in the right place instead of throwing, and
   * the last slot is *after the last item* rather than after whatever else the
   * container holds (a live region, a footer), which would put the row outside
   * the reading order the list publishes.
   */
  #insertAt(item: HTMLElement, scope: HTMLElement[], index: number): void {
    const clamped = Math.max(0, Math.min(index, scope.length));
    const ahead = scope[clamped] ?? null;
    const behind = ahead ? null : (scope[scope.length - 1] ?? null);
    const neighbour = ahead ?? behind;
    if (!neighbour) return;
    const parent = neighbour.parentNode;
    if (!parent) return;
    // Real browsers drop focus when the focused node is re-inserted (the move
    // is a remove+insert), which would strand the keyboard grab after one
    // arrow press — restore it so focus rides the moved item.
    const active = document.activeElement;
    const hadFocus = active instanceof HTMLElement && item.contains(active);
    parent.insertBefore(item, ahead ?? neighbour.nextSibling);
    if (hadFocus) active.focus();
  }

  /**
   * Hands one step to the page's shared announcer.
   *
   * The library carries no live region and no English copy: the wording is the
   * consumer's, written into `announceGrabbedText` / `announceMovedText` /
   * `announceDroppedText` / `announceCanceledText` with `{name}` / `{position}` /
   * `{total}` placeholders, and an unset one announces nothing.
   *
   * Only transitions reach here — the pickup, a step that actually changed the
   * landing slot, and the single end of the session — so a pointer crossing the
   * same slot twice or an arrow clamped at an end stays silent.
   */
  #announce(key: AnnounceKey, item: HTMLElement): void {
    const template = this.#announceTemplate(key);
    if (template.length === 0) return;
    const items = this.#items();
    announce(
      fillTemplate(template, {
        name: this.#nameOf(item),
        position: items.indexOf(item) + 1,
        total: items.length,
      }),
    );
  }

  /** The consumer's wording for one step, or `""` when they authored none. */
  #announceTemplate(key: AnnounceKey): string {
    switch (key) {
      case "grabbed":
        return this.announceGrabbedTextValue;
      case "moved":
        return this.announceMovedTextValue;
      case "dropped":
        return this.announceDroppedTextValue;
      case "canceled":
        return this.announceCanceledTextValue;
    }
  }

  /** The announced item name: the authored override, else its collapsed text. */
  #nameOf(item: HTMLElement): string {
    const authored = item.getAttribute("data-stimeo--sortable-name");
    if (authored) return authored;
    return (item.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  /**
   * Resolves the sortable item owning a bubbled `pointer-drag` event.
   *
   * `pointer-drag` dispatches on its own element, and the markup contract puts
   * one on each item, so the owner is the item that **is** the target. Matching
   * an ancestor instead would make a card's own inner draggable — a knob, a
   * split pane, anything the primitive is composed into — drive the card.
   */
  #itemFor(target: EventTarget | null, items: HTMLElement[]): HTMLElement | null {
    if (!target) return null;
    return items.find((item) => item === target) ?? null;
  }

  /** The items in live DOM order (targets re-query the DOM on every access). */
  #items(): HTMLElement[] {
    return this.itemTargets;
  }

  /** The reorder container: the `list` target when present, else the element. */
  get #list(): HTMLElement {
    return this.hasListTarget ? this.listTarget : this.element;
  }

  get #isVertical(): boolean {
    return this.orientationValue !== "horizontal";
  }

  /**
   * Whether DOM order runs opposite to the primary coordinate — true only for a
   * horizontal row under `dir="rtl"`, where the first item sits at the largest
   * `x`. Both drag paths reach this controller in physical terms (`pointer-drag`
   * documents its deltas as physical and hands RTL to its consumer, which is
   * this controller), so both have to be mapped back onto DOM order here.
   *
   * Read from the list, the element that lays the items out — never from the
   * dragged item, which may carry its own `dir`. The list inherits the computed
   * direction, so authoring `dir` on the root works too. A vertical list is
   * unaffected: writing direction does not mirror the block axis.
   */
  get #isReversed(): boolean {
    return !this.#isVertical && isRtl(this.#list);
  }
}
