import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";
import { canTakeFocus } from "../utils/focus_candidate";
import { INTERACTIVE_HOST_SELECTOR, isInteractiveHost } from "../utils/interactive_host";
import { isRtl } from "../utils/logical_scroll";
import { RovingTabindex } from "../utils/roving_tabindex";
import { SafeTimeout } from "../utils/safe_timeout";
import { findTypeaheadMatch, isTypeaheadKey, Typeahead, typeaheadLabel } from "../utils/typeahead";

/**
 * Interactive descendants a `treeitem` may legitimately contain (inline rename
 * field, link, chevron). Keys and clicks raised inside one belong to it, not to
 * the tree, so the tree handlers step aside.
 *
 * The selector is matched with `closest()`, which also matches the item host
 * itself — deliberately. An item host that *is* one of these elements is out of
 * contract (see the class TSDoc), and the tree then stands down completely
 * rather than responding to some keys and not others.
 */
const NESTED_INTERACTIVE = INTERACTIVE_HOST_SELECTOR;

/**
 * Headless, accessible single-select tree view.
 *
 * Markup contract (identifier: `stimeo--tree-view`):
 *   <ul data-controller="stimeo--tree-view" role="tree" aria-label="Files">
 *     <li role="treeitem" aria-expanded="false" aria-selected="false" tabindex="0"
 *         data-stimeo--tree-view-target="item"
 *         data-action="keydown->stimeo--tree-view#onKeydown
 *                      click->stimeo--tree-view#onClick">
 *       <span>src</span>
 *       <button type="button" tabindex="-1" aria-hidden="true"
 *               data-action="click->stimeo--tree-view#toggle"></button>
 *       <ul role="group" data-stimeo--tree-view-target="group" hidden>
 *         <li role="treeitem" aria-selected="false" tabindex="-1"
 *             data-stimeo--tree-view-target="item" data-action="…">…</li>
 *       </ul>
 *     </li>
 *   </ul>
 *
 * Implements the WAI-ARIA APG **Tree View** (single-select) pattern. Parent/child
 * structure is read from the DOM nesting (`treeitem` → child `group`). The whole
 * tree is one Tab stop (roving tabindex); arrows navigate visible items, expand /
 * collapse, and move between parent and child.
 *
 * Behavior provided:
 * - `ArrowDown`/`ArrowUp` move between visible items; `Home`/`End` jump to the
 *   first / last visible item; printable characters typeahead by label prefix
 *   (`aria-label` first, else the item's own text), with a repeated character
 *   cycling through the items that start with it.
 * - `ArrowRight` expands a collapsed parent or steps into its first child;
 *   `ArrowLeft` collapses an expanded parent or steps to the parent item.
 * - `Enter`/`Space`/click select the item (single selection via `aria-selected`);
 *   an `aria-disabled="true"` item stays focusable but cannot be selected.
 * - `aria-expanded` and each child `group`'s `hidden` stay in sync, dispatching
 *   `stimeo--tree-view:toggle`; selection dispatches `stimeo--tree-view:select`.
 * - The optional `toggle` action expands / collapses the nearest item, so a
 *   chevron gives pointer users the reach that `ArrowRight` gives the keyboard.
 *
 * Contract notes:
 * - A child container is resolved by `role="group"`, not by the target: the
 *   `group` target is what `stimeo check`'s accessibility rule anchors on, which
 *   is why the contract still declares it.
 * - Nested interactive controls ({@link NESTED_INTERACTIVE}) and IME composition
 *   keys are left alone; a click on a child `group`'s own box (its indentation
 *   band) selects nothing rather than the parent row.
 * - A key a descendant already consumed (`event.defaultPrevented`) is yielded,
 *   so a composed widget inside a row never causes a double move.
 *
 * Consumer contract — the item host:
 * - **Host `role="treeitem"` on a non-interactive element** (`li`, `div`), never
 *   on {@link NESTED_INTERACTIVE}. APG's *Navigation Treeview* does host it on a
 *   link, but that variant activates on `Enter`, which this pattern has already
 *   spent on selection; a link host is therefore out of contract and would need
 *   `Enter` / click / `select` redefined first.
 * - An out-of-contract host makes `onKeydown` and `onClick` stand down
 *   **entirely** — no movement, no selection, no `select` — rather than respond
 *   partially. `stimeo check` reports the unsupported host before runtime.
 *
 * Consumer contract — controls nested inside a row:
 * - Keep them out of the Tab sequence (`tabindex="-1"`); the tree is one Tab
 *   stop and writes `tabindex` on nothing but its own item targets.
 * - Moving focus *into* a control (to start an inline rename) is the consumer's
 *   call — the tree never focuses one.
 * - When the edit or action ends, focus the `treeitem` itself. The roving
 *   position never moved, so that alone restores the keyboard path.
 * - The tree consumes none of the control's events, by two mechanisms:
 *   {@link NESTED_INTERACTIVE} names controls by *element shape*, the
 *   `defaultPrevented` yield covers widgets no selector can name.
 */
export class TreeViewController extends Controller<HTMLElement> {
  static override targets = ["item", "group"];
  static actions = ["onClick", "onKeydown", "toggle"] as const;
  static events = ["select", "toggle"] as const;

  declare readonly itemTargets: HTMLElement[];

  readonly #roving = new RovingTabindex(() => this.itemTargets);
  readonly #typeahead = new Typeahead();
  readonly #timers = new SafeTimeout();
  #connected = false;
  /**
   * Item targets in DOM order as of the last connect / target change. A removed
   * item is gone from `itemTargets` by the time Stimulus reports it, so this is
   * the only record of where in the order the gap opened.
   */
  #order: HTMLElement[] = [];
  /** The `treeitem` that last took DOM focus inside this tree, if any. */
  #focused: HTMLElement | null = null;

  /**
   * Records which row owns DOM focus. `focusin` bubbles, so one listener covers
   * rows and anything nested in them; the tree needs this because a removal is
   * only reported *after* the fact, when the browser has already reset
   * `document.activeElement`.
   */
  readonly #onFocusIn = (event: FocusEvent): void => {
    const target = event.target as HTMLElement | null;
    this.#focused = target?.closest<HTMLElement>('[role="treeitem"]') ?? null;
  };

  /**
   * Forgets the tracked row when focus genuinely leaves the tree, so a later
   * removal of that row cannot be mistaken for "focus died with it" and pull
   * focus back in.
   *
   * A *removed* focused row must not clear the record — that is exactly the case
   * {@link TreeViewController.itemTargetDisconnected} needs it for. The two are
   * indistinguishable while the event is dispatching: Chromium fires `focusout`
   * for a removed row *before* the detach lands — `isConnected` still reads
   * `true` — with `document.activeElement` already on `<body>`, exactly like a
   * plain `blur()`. Deciding on a microtask separates them — a row that is gone
   * by then was removed. Focus moving between two rows needs no handling:
   * `focusin` overwrites the record right after.
   */
  readonly #onFocusOut = (event: FocusEvent): void => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('[role="treeitem"]') ?? null;
    if (!row || row !== this.#focused) return;
    const next = event.relatedTarget;
    if (next instanceof Node && this.element.contains(next)) return;
    queueMicrotask(() => {
      if (this.#focused === row && row.isConnected) this.#focused = null;
    });
  };

  /**
   * Reconciles authored expansion state and establishes the single tab stop.
   * Idempotent, so a Turbo cache restore / morph re-runs it safely (re-adding
   * the same listener reference is a no-op per the DOM spec).
   */
  override connect(): void {
    this.element.addEventListener("focusin", this.#onFocusIn);
    this.element.addEventListener("focusout", this.#onFocusOut);
    this.#seedFocused();
    this.#reconcileExpansion();
    this.#normalizeSelection();
    this.#normalizeTabStop();
    this.#order = [...this.itemTargets];
    this.#connected = true;
  }

  /** Detaches the focus trackers, drops the typeahead buffer and its timer. */
  override disconnect(): void {
    this.element.removeEventListener("focusin", this.#onFocusIn);
    this.element.removeEventListener("focusout", this.#onFocusOut);
    this.#connected = false;
    this.#typeahead.reset();
    this.#timers.clearAll();
    this.#order = [];
    this.#focused = null;
  }

  /**
   * Seeds the focus record from the live document. A row can already hold focus
   * when the controller connects (a Turbo restore, or `data-controller` added to
   * a tree the user was already in), and the `focusin` listener alone would
   * never learn about it.
   */
  #seedFocused(): void {
    const active = this.element.ownerDocument.activeElement;
    this.#focused =
      active instanceof HTMLElement && this.element.contains(active)
        ? active.closest<HTMLElement>('[role="treeitem"]')
        : null;
  }

  /**
   * Re-normalizes the tab stop when a `treeitem` is added at runtime, so an
   * appended item carrying `tabindex="0"` cannot turn the tree into two Tab
   * stops. Skipped before `connect()`: Stimulus registers the initial targets
   * first, and `connect()` owns the initial tab-stop policy.
   */
  itemTargetConnected(): void {
    if (!this.#connected) return;
    this.#normalizeSelection();
    this.#normalizeTabStop();
    this.#trackOrder();
  }

  /**
   * Brings authored `aria-selected` to the shape the APG requires, without
   * changing which item the author chose.
   *
   * Every item gets an explicit value — an absent `aria-selected` means "not
   * selectable" in ARIA, so a forgotten attribute hides a selectable row — and a
   * single-select tree keeps at most one `true`, first in DOM order. `connect()`
   * reconciles authored expansion the same way. The scan is the `item` target
   * set: a `role="treeitem"` without the target is outside the contract and is
   * neither counted nor written.
   */
  #normalizeSelection(): void {
    const items = this.itemTargets;
    const selected = items.find((item) => item.getAttribute("aria-selected") === "true");
    for (const item of items) {
      item.setAttribute("aria-selected", item === selected ? "true" : "false");
    }
  }

  /**
   * Restores the roving invariants when a `treeitem` leaves at runtime — a Turbo
   * Stream `remove`, a morph, or plain DOM surgery. The mirror of
   * {@link TreeViewController.itemTargetConnected}: without it, removing the row
   * that held `tabindex="0"` leaves every survivor at `-1`, i.e. a tree with
   * **no** Tab stop, and drops DOM focus to `<body>` when the removed subtree
   * held it.
   *
   * The replacement is the nearest surviving *visible* item in the pre-removal
   * order — the one after the gap, else the one before it — which is the row
   * `ArrowDown` would have reached. Removing a non-active item changes nothing.
   * When no visible item survives, a tree with zero Tab stops is the correct end
   * state.
   *
   * Focus is only *restored*, never *stolen*: DOM focus moves solely when it was
   * inside the removed subtree and the document has nowhere left to put it.
   */
  itemTargetDisconnected(item: HTMLElement): void {
    // Stimulus drains the target callbacks for a removed *tree* before calling
    // `disconnect()`; recovering a roving position for a widget that is already
    // gone would move focus for nothing.
    if (!this.#connected || !this.element.isConnected) return;
    const stranded = this.#focusDiedWith(item);
    if (stranded) this.#focused = null;
    if (stranded || this.#roving.activeIndex === -1) {
      const next = this.#neighborOf(item);
      if (next) this.#roving.setActive(this.itemTargets.indexOf(next), { focus: stranded });
    }
    // Drop only the item just reported. One DOM mutation batch arrives as
    // several callbacks, so rebuilding from `itemTargets` here would also erase
    // the recorded position of every sibling whose callback has yet to run.
    this.#order = this.#order.filter((tracked) => tracked !== item);
  }

  /**
   * Folds newly connected targets into the DOM-order snapshot, keeping the slot
   * of any item whose disconnect callback has not arrived yet — a morph that
   * both adds and removes rows reports one batch as several callbacks, and
   * {@link TreeViewController.#neighborOf} needs those slots.
   */
  #trackOrder(): void {
    const live = this.itemTargets;
    const pending = this.#order.filter((tracked) => !live.includes(tracked));
    if (pending.length === 0) {
      this.#order = live;
      return;
    }
    // `pending` is in ascending recorded order, so re-inserting each at the
    // index it held rebuilds the pre-mutation sequence.
    const merged = [...live];
    for (const tracked of pending) {
      merged.splice(Math.min(this.#order.indexOf(tracked), merged.length), 0, tracked);
    }
    this.#order = merged;
  }

  /**
   * Routes tree keyboard interaction. Because `treeitem`s nest, only the handler
   * on the nearest item to the event target acts; the same keydown bubbling to an
   * ancestor item's handler is ignored to avoid double moves / selections. Keys
   * from a nested interactive control (or an IME composition) are left untouched.
   */
  onKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key (a grabbed drag handle, a
    // nested custom control) must not ALSO move the roving focus — composition
    // depends on this yield. `#ownerItem` covers the controls a selector can
    // name; this covers the ones it cannot.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    if (event.isComposing) return;
    const item = this.#ownerItem(event);
    if (!item) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.#moveBy(item, 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.#moveBy(item, -1);
        break;
      // Logical, not physical: APG describes these as "to the child level" and
      // "to the parent level" — a spatial move — so they follow the writing
      // direction, exactly as horizontal roving does. `isRtl()` is the shared
      // detector; never introduce a second one.
      //
      // Direction comes from the tree, not from `item`: the tree is what lays
      // the rows out, and a row may carry its own `dir` (an LTR path inside an
      // RTL browser is ordinary bidi authoring). Probing the focused row instead
      // would let one row's arrows mean the opposite of its sibling's.
      case "ArrowRight":
        event.preventDefault();
        if (isRtl(this.element)) this.#collapseOrLeave(item);
        else this.#expandOrEnter(item);
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (isRtl(this.element)) this.#expandOrEnter(item);
        else this.#collapseOrLeave(item);
        break;
      case "Home":
        event.preventDefault();
        this.#focusEdge(0);
        break;
      case "End":
        event.preventDefault();
        this.#focusEdge(-1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        this.#select(item);
        break;
      default:
        if (isTypeaheadKey(event)) {
          event.preventDefault();
          this.#typeaheadTo(item, event.key);
        }
        break;
    }
  }

  /** Selects the clicked item (nearest to the target only). */
  onClick(event: Event): void {
    const item = this.#ownerItem(event);
    if (!item) return;
    // The indentation band of a child group is the group's own box, not the
    // parent row: a click that lands there must select nothing.
    const group = this.#childGroup(item);
    if (group?.contains(event.target as Node)) return;
    this.#focusItem(item);
    this.#select(item);
  }

  /**
   * Expands or collapses the `treeitem` nearest to the event target. Optional:
   * wire it on a chevron control so pointer users can reach child nodes, which
   * otherwise only `ArrowRight` / `ArrowLeft` can do. A leaf item is a no-op.
   *
   * The toggled row then takes focus and the tab stop, matching what the keyboard
   * path guarantees. Without it, a browser that focuses buttons on mousedown leaves
   * focus on the clicked chevron: arrows would stop working until focus returns to a
   * row, and a decorative `aria-hidden` chevron would hold focus. The synchronous
   * `stimeo--tree-view:toggle` event is observed before this final focus hand-off.
   */
  toggle(event: Event): void {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!item || !this.element.contains(item)) return;
    if (!this.#childGroup(item)) return;
    this.#setExpanded(item, !this.#isExpanded(item));
    this.#focusItem(item);
  }

  /**
   * The item a raw event belongs to, or `null` when the tree must not act: the
   * event came from a nested `treeitem` (it bubbled to an ancestor's handler) or
   * from an interactive control inside the item.
   */
  #ownerItem(event: Event): HTMLElement | null {
    const item = event.currentTarget as HTMLElement;
    const target = event.target as HTMLElement;
    if (target.closest('[role="treeitem"]') !== item) return null;
    const control = target.closest<HTMLElement>(NESTED_INTERACTIVE);
    if (control && item.contains(control)) return null;
    if (isInteractiveHost(target)) return null;
    return item;
  }

  /**
   * The surviving visible item that inherits `removed`'s position: the next one
   * in the pre-removal order, else the previous one. Falls back to the first
   * visible item when `removed` is not in that order — a target that arrived and
   * left between two callbacks — and to `undefined` when nothing visible is left.
   */
  #neighborOf(removed: HTMLElement): HTMLElement | undefined {
    const visible = this.#visibleItems;
    const index = this.#order.indexOf(removed);
    for (let at = index + 1; at < this.#order.length; at += 1) {
      const candidate = this.#order[at];
      if (candidate && visible.includes(candidate)) return candidate;
    }
    for (let at = index - 1; at >= 0; at -= 1) {
      const candidate = this.#order[at];
      if (candidate && visible.includes(candidate)) return candidate;
    }
    return visible[0];
  }

  /**
   * Whether DOM focus went down with `removed`: it sat on that row (or inside
   * it) and the document now has nowhere to put focus. A browser falls back to
   * `<body>`; a still-referenced but detached `activeElement` is the same
   * condition seen from the other side. Focus that landed on a real element —
   * inside this tree or anywhere else on the page — is left alone, so a removal
   * can never steal it.
   */
  #focusDiedWith(removed: HTMLElement): boolean {
    const focused = this.#focused;
    if (!focused || (focused !== removed && !removed.contains(focused))) return false;
    const doc = this.element.ownerDocument;
    const active = doc.activeElement;
    if (active === null || active === doc.body || active === doc.documentElement) return true;
    return !active.isConnected;
  }

  /** Moves focus to the next (`delta=1`) or previous visible item, if any. */
  #moveBy(item: HTMLElement, delta: number): void {
    const visible = this.#visibleItems;
    const current = visible.indexOf(item);
    // An item outside the visible set has no neighbors; without this guard a
    // `-1 + 1` index would warp focus to the top of the tree.
    if (current === -1) return;
    const next = visible[current + delta];
    if (next) this.#focusItem(next);
  }

  /**
   * Expands a collapsed parent, else steps into the first child.
   *
   * Bound to `ArrowRight` under LTR and `ArrowLeft` under RTL — the caller picks;
   * this method only knows "toward the child level".
   */
  #expandOrEnter(item: HTMLElement): void {
    const group = this.#childGroup(item);
    if (!group) return;
    if (!this.#isExpanded(item)) {
      this.#setExpanded(item, true);
      return;
    }
    // Never move the only tab stop into a subtree a consumer hid directly.
    if (group.hidden) return;
    // The first child that is not itself hidden. Matched on the element rather
    // than through `#visibleItems`, so a `role="treeitem"` without the item
    // target still receives focus (the fallback in `#focusItem`).
    const firstChild = Array.from(
      group.querySelectorAll<HTMLElement>(':scope > [role="treeitem"]'),
    ).find((child) => !child.hidden);
    if (firstChild) this.#focusItem(firstChild);
  }

  /** `ArrowLeft`: collapse an expanded parent, else step out to the parent item. */
  #collapseOrLeave(item: HTMLElement): void {
    if (this.#childGroup(item) && this.#isExpanded(item)) {
      this.#setExpanded(item, false);
      return;
    }
    const parent = this.#parentItem(item);
    if (parent) this.#focusItem(parent);
  }

  /** Focuses the first (`0`) or last (`-1`) visible item. */
  #focusEdge(index: number): void {
    const visible = this.#visibleItems;
    const target = index < 0 ? visible[visible.length - 1] : visible[index];
    if (target) this.#focusItem(target);
  }

  /**
   * Whether the item is disabled — **its own attribute or an ancestor's**.
   *
   * ARIA is explicit that the state carries down: "The state of being disabled
   * applies to the current element *and all focusable descendant elements* of the
   * element on which the `aria-disabled` attribute is applied." A tree is the only
   * pattern here whose items nest, so it is the only place the inheritance is
   * observable — but the rule is the shared one.
   *
   * The walk stops at the controller element: an `aria-disabled` on the tree root
   * would otherwise disable every row, and a disabled *tree* is the consumer's
   * call to make with `inert`, not something this controller infers.
   */
  #isDisabled(item: HTMLElement): boolean {
    let current: HTMLElement | null = item;
    while (current && current !== this.element) {
      if (current.getAttribute("aria-disabled") === "true") return true;
      current = current.parentElement;
    }
    return false;
  }

  /**
   * Applies single selection and dispatches `select`. An `aria-disabled="true"`
   * item stays focusable (APG keeps disabled nodes reachable) but is never
   * activated, so consumers see no `select` for it.
   */
  #select(item: HTMLElement): void {
    if (this.#isDisabled(item)) return;
    for (const candidate of this.itemTargets) {
      candidate.setAttribute("aria-selected", candidate === item ? "true" : "false");
    }
    this.dispatch("select", { detail: { item } });
  }

  /** Updates expansion, reconciles a collapsed subtree, then synchronously dispatches `toggle`. */
  #setExpanded(item: HTMLElement, expanded: boolean): void {
    const group = this.#childGroup(item);
    if (!group) return;
    item.setAttribute("aria-expanded", String(expanded));
    group.hidden = !expanded;
    if (!expanded) this.#escapeCollapsedSubtree(item, group);
    this.dispatch("toggle", { detail: { item, expanded } });
  }

  /**
   * Reconciles focus and the roving tab stop before a synchronous `toggle` event
   * observes a newly collapsed group. If DOM focus remains inside the group,
   * both move to the parent. Otherwise only a stranded tab stop moves, preserving
   * DOM focus. A native chevron click takes this path when mousedown has already
   * focused the button. {@link TreeViewController.toggle} completes its focus
   * hand-off after this reconciliation and event dispatch.
   */
  #escapeCollapsedSubtree(item: HTMLElement, group: HTMLElement): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && group.contains(active)) {
      this.#focusItem(item);
      return;
    }
    // Focus is elsewhere on the page: relocate the tab stop without stealing it.
    const activeIndex = this.#roving.activeIndex;
    const tabbable = activeIndex === -1 ? undefined : this.itemTargets[activeIndex];
    if (!tabbable || !group.contains(tabbable)) return;
    const index = this.itemTargets.indexOf(item);
    if (index !== -1) this.#roving.setActive(index);
  }

  /** Makes `item` the single tab stop and moves DOM focus to it. */
  #focusItem(item: HTMLElement): void {
    const index = this.itemTargets.indexOf(item);
    if (index !== -1) {
      this.#roving.setActive(index, { focus: true });
      return;
    }
    // A `role="treeitem"` without the item target is outside roving bookkeeping,
    // yet DOM structure still reaches it as a parent / first child. Focus it so
    // the tree never silently stops responding; `tabindex="-1"` keeps the single
    // Tab stop on a real target.
    //
    // Checked first: `hidden` and natively disabled elements swallow `focus()`,
    // and moving toward one would leave the caret where it was with no signal.
    // Refusing is the honest outcome here — there is no better destination to
    // fall back to, since roving already declined this node.
    if (!canTakeFocus(item)) return;
    item.tabIndex = -1;
    item.focus();
  }

  /** Advances the typeahead query and focuses the next matching visible item. */
  #typeaheadTo(item: HTMLElement, char: string): void {
    const query = this.#typeahead.push(char);
    // Only visible rows are candidates: an item inside a collapsed group is not
    // reachable by arrow keys either, so typeahead must not tunnel into one.
    const visible = this.#visibleItems;
    const index = findTypeaheadMatch(visible, visible.indexOf(item), query, (candidate) =>
      this.#label(candidate),
    );
    // A miss reads back as `undefined` (`visible[-1]`), so the guard below is the
    // only branch — spelling the `-1` out again would add an unreachable one.
    const match = visible[index];
    if (match) this.#focusItem(match);
  }

  /**
   * Aligns each parent's `aria-expanded` with its child `group`'s `hidden`.
   * `aria-expanded` wins when authored (it is what assistive tech reads); a
   * parent without it derives one from `hidden` (establish-only-when-absent, so
   * a restored snapshot is never clobbered). Disagreeing markup would otherwise
   * strand the only tab stop on an invisible item.
   */
  #reconcileExpansion(): void {
    for (const item of this.itemTargets) {
      const group = this.#childGroup(item);
      if (!group) continue;
      if (item.hasAttribute("aria-expanded")) {
        group.hidden = !this.#isExpanded(item);
      } else {
        item.setAttribute("aria-expanded", String(!group.hidden));
      }
    }
  }

  /**
   * Leaves exactly one item tabbable. An existing, still-visible tab stop wins
   * (the DOM is the source of truth after a Turbo restore, so the user's roving
   * position survives); otherwise the selected item takes it (APG: a single-select
   * tree puts initial focus on its selected node), else the first visible item.
   */
  #normalizeTabStop(): void {
    const items = this.itemTargets;
    const visible = this.#visibleItems;
    const activeIndex = this.#roving.activeIndex;
    const active = activeIndex === -1 ? undefined : items[activeIndex];
    if (active && visible.includes(active)) {
      this.#roving.setActive(activeIndex);
      return;
    }
    const selected = visible.find((item) => item.getAttribute("aria-selected") === "true");
    const next = selected ?? visible[0];
    this.#roving.setActive(next ? items.indexOf(next) : -1);
  }

  /**
   * The visible items: those with no `hidden` ancestor up to the tree, and not
   * `hidden` themselves. A hidden row is out of the move set — it can hold
   * neither DOM focus nor the only Tab stop — and neither can anything nested
   * under one, which is why the walk tests every ancestor rather than only the
   * collapsed `role="group"` containers.
   */
  get #visibleItems(): HTMLElement[] {
    return this.itemTargets.filter((item) => {
      let node: HTMLElement | null = item;
      while (node && node !== this.element) {
        if (node.hidden) return false;
        node = node.parentElement;
      }
      return true;
    });
  }

  /** The child `group` owned directly by `item`, or `null` for a leaf. */
  #childGroup(item: HTMLElement): HTMLElement | null {
    return item.querySelector<HTMLElement>(':scope > [role="group"]');
  }

  /** The nearest ancestor `treeitem`, or `null` at the root level. */
  #parentItem(item: HTMLElement): HTMLElement | null {
    return item.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? null;
  }

  /** Whether a parent item is currently expanded. */
  #isExpanded(item: HTMLElement): boolean {
    return item.getAttribute("aria-expanded") === "true";
  }

  /**
   * `item`'s name for typeahead. The fallback is the item's *own* text: a parent
   * row's nested child group is rendered inside it, and folding a whole subtree
   * into one name would let "readme" match the folder containing it.
   */
  #label(item: HTMLElement): string {
    return typeaheadLabel(item, () => {
      let text = "";
      for (const node of Array.from(item.childNodes)) {
        if (node.nodeType === Node.ELEMENT_NODE && (node as Element).matches('[role="group"]')) {
          continue;
        }
        text += node.textContent ?? "";
      }
      return text;
    });
  }
}
