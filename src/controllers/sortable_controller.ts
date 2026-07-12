import { Controller } from "@hotwired/stimulus";

/** A reorder in flight: one item picked up by pointer or keyboard. */
interface SortSession {
  item: HTMLElement;
  /** Index at pickup, for the `reorder` detail and the cancel restore. */
  from: number;
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
 * live-reordering the DOM, announcing each step through a `status` live region,
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
 *     <span role="status" data-stimeo--sortable-target="status"></span>
 *   </div>
 *
 * The composed values must follow the sort axis: roving's `orientation`
 * (which defaults to `horizontal`, so a vertical list has to author
 * `vertical`) and pointer-drag's `axis`. `stimeo check` enforces both
 * alignments as composition rules (`composition-mismatch`).
 *
 * Pointer flow: dragging an item live-moves it whenever the pointer crosses a
 * sibling's midpoint (per `orientation`). Keyboard flow: each synthetic
 * `pointer-drag` move steps the item one position. Dropping dispatches
 * `reorder` (`{ item, from, to }`, zero-based) when the position changed;
 * Escape / `pointercancel` restores the pickup position. Every step is mirrored
 * into the `status` live region (localizable via `data-grabbed` / `data-moved`
 * / `data-dropped` / `data-canceled` templates with `%{name}` / `%{position}` /
 * `%{total}` placeholders; terse English is the fallback).
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
 * / kanban, nested DnD, auto-scroll at the edges, and virtualized lists are the
 * premium tier — deliberately out of this free single-list scope.
 */
export class SortableController extends Controller<HTMLElement> {
  static override targets = ["list", "item", "status"];
  static override values = {
    orientation: { type: String, default: "vertical" },
  };
  static events = ["reorder"] as const;

  declare readonly hasListTarget: boolean;
  declare readonly listTarget: HTMLElement;
  declare readonly itemTargets: HTMLElement[];
  declare readonly hasStatusTarget: boolean;
  declare readonly statusTarget: HTMLElement;
  declare orientationValue: string;

  #session: SortSession | null = null;

  override connect(): void {
    // A drag cannot survive a navigation: drop the hook a Turbo cache snapshot
    // may have preserved mid-drag (idempotent reconnect).
    this.element.removeAttribute("data-sortable-dragging");
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
    this.#session = null;
    this.element.removeAttribute("data-sortable-dragging");
  }

  /** Picks the item up: remembers its origin and announces the grab. */
  readonly #onDragStart = (event: Event): void => {
    // One reorder at a time: a start from another item (each item has its own
    // pointer-drag instance) must not clobber the live session — its from
    // index and cancel restore would be lost.
    if (this.#session) return;
    const item = this.#itemFor(event.target);
    if (!item) return;
    this.#session = { item, from: this.#items().indexOf(item), lastPrimary: 0 };
    this.element.setAttribute("data-sortable-dragging", "true");
    this.#announce("grabbed", item);
  };

  readonly #onDragMove = (event: Event): void => {
    const session = this.#session;
    const detail = (event as CustomEvent<Record<string, number | string>>).detail;
    if (!session || this.#itemFor(event.target) !== session.item) return;

    if (detail.pointerType === "keyboard") {
      this.#stepFromKeyboard(session, detail);
    } else {
      this.#followPointer(session, detail);
    }
  };

  /** Drops the item: announces, then reports `reorder` if the position changed. */
  readonly #onDragEnd = (event: Event): void => {
    const session = this.#session;
    if (!session || this.#itemFor(event.target) !== session.item) return;
    this.#session = null;
    this.element.removeAttribute("data-sortable-dragging");
    this.#announce("dropped", session.item);
    const to = this.#items().indexOf(session.item);
    if (to !== session.from) {
      this.dispatch("reorder", { detail: { item: session.item, from: session.from, to } });
    }
  };

  /** Restores the pickup position (Escape / OS `pointercancel`). */
  readonly #onDragCancel = (event: Event): void => {
    const session = this.#session;
    if (!session || this.#itemFor(event.target) !== session.item) return;
    this.#session = null;
    this.element.removeAttribute("data-sortable-dragging");
    this.#moveTo(session.item, session.from);
    this.#announce("canceled", session.item);
  };

  /**
   * Keyboard stepping: `pointer-drag` reports *cumulative* synthetic deltas, so
   * the difference from the last consumed value is one arrow press — its sign is
   * the direction. Cross-axis arrows never change the primary delta (no move).
   */
  #stepFromKeyboard(session: SortSession, detail: Record<string, number | string>): void {
    const primary = Number(this.#isVertical ? detail.dy : detail.dx) || 0;
    const delta = primary - session.lastPrimary;
    session.lastPrimary = primary;
    if (delta === 0) return;

    const items = this.#items();
    const index = items.indexOf(session.item);
    const next = Math.max(0, Math.min(index + (delta > 0 ? 1 : -1), items.length - 1));
    if (next === index) return;
    this.#moveTo(session.item, next);
    this.#announce("moved", session.item);
  }

  /**
   * Pointer following: the item moves to the slot whose siblings' midpoints the
   * pointer has passed (per `orientation`). Skipped when the list has no layout
   * geometry (every rect is zero — nothing meaningful to compare against).
   */
  #followPointer(session: SortSession, detail: Record<string, number | string>): void {
    const pointer = Number(this.#isVertical ? detail.y : detail.x) || 0;
    const others = this.#items().filter((item) => item !== session.item);
    if (others.length === 0) return;

    let laidOut = false;
    let target = 0;
    for (const other of others) {
      const rect = other.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) laidOut = true;
      const midpoint = this.#isVertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
      if (pointer > midpoint) target += 1;
    }
    if (!laidOut) return;

    // The item's index among all items equals the count of others before it,
    // so it doubles as the current insertion slot in others-space.
    const current = this.#items().indexOf(session.item);
    if (target !== current) {
      this.#moveTo(session.item, target);
      this.#announce("moved", session.item);
    }
  }

  /** Reinserts `item` so it lands at `index` among the list's items. */
  #moveTo(item: HTMLElement, index: number): void {
    const others = this.#items().filter((candidate) => candidate !== item);
    const clamped = Math.max(0, Math.min(index, others.length));
    const reference = others[clamped] ?? null;
    // Real browsers drop focus when the focused node is re-inserted (the move
    // is a remove+insert), which would strand the keyboard grab after one
    // arrow press — restore it so focus rides the moved item.
    const active = document.activeElement;
    const hadFocus = active instanceof HTMLElement && item.contains(active);
    this.#list.insertBefore(item, reference);
    if (hadFocus) active.focus();
  }

  /**
   * Mirrors a step into the `status` live region. Copy is localizable through
   * `data-grabbed` / `data-moved` / `data-dropped` / `data-canceled` templates on
   * the status element (`%{name}` / `%{position}` / `%{total}` placeholders);
   * terse English is the fallback (same channel design as `stimeo--feed`).
   */
  #announce(key: "grabbed" | "moved" | "dropped" | "canceled", item: HTMLElement): void {
    if (!this.hasStatusTarget) return;
    const position = String(this.#items().indexOf(item) + 1);
    const total = String(this.#items().length);
    const name = this.#nameOf(item);
    const fallback = {
      grabbed: `Grabbed ${name}, position ${position} of ${total}`,
      moved: `${name}, position ${position} of ${total}`,
      dropped: `Dropped ${name} at position ${position} of ${total}`,
      canceled: `Reorder canceled, ${name} returned to position ${position} of ${total}`,
    } as const;
    // Single-pass function replacement keeps the substitution literal-safe:
    // `$`-sequences in the (author/content-derived) name never expand, and a
    // name that happens to contain a placeholder token is not re-substituted.
    const values: Record<string, string> = { name, position, total };
    const template = this.statusTarget.dataset[key];
    this.statusTarget.textContent = template
      ? template.replace(/%\{(name|position|total)\}/g, (match, token: string) => {
          return values[token] ?? match;
        })
      : fallback[key];
  }

  /** The announced item name: the authored override, else its collapsed text. */
  #nameOf(item: HTMLElement): string {
    const authored = item.getAttribute("data-stimeo--sortable-name");
    if (authored) return authored;
    return (item.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  /** Resolves the sortable item owning a bubbled `pointer-drag` event. */
  #itemFor(target: EventTarget | null): HTMLElement | null {
    const node = target as Node | null;
    if (!node) return null;
    return this.#items().find((item) => item === node || item.contains(node)) ?? null;
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
}
