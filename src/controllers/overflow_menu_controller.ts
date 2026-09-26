import { Controller } from "@hotwired/stimulus";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { ownerOf } from "../utils/event_owner";
import { canTakeFocus } from "../utils/focus_candidate";
import { LayoutObserver } from "../utils/layout_observer";
import { SafeTimeout } from "../utils/safe_timeout";
import { TabindexLoan } from "../utils/tabindex_loan";
import type { MenuController } from "./menu_controller";

/** Suffix of the marker on an item living in the More menu (survives a DOM snapshot). */
const BANKED = "banked";
/**
 * Suffix of the canonical index persisted while anything is banked, so a fresh
 * instance can re-adopt.
 */
const INDEX = "index";
/**
 * Suffix of the marker on the inert split point retained only while every managed
 * item is banked.
 */
const BOUNDARY = "boundary";
/**
 * Suffixes of the attributes saving an item's authored values while it wears menu
 * semantics ("" = attribute was absent).
 */
const SAVED_ROLE = "role";
const SAVED_TABINDEX = "tabindex";
const SAVED_MENU_TARGET = "saved-menu";
/** Menu's target attribute — set to `item` while banked so Menu drives the item. */
const MENU_TARGET = "data-stimeo--menu-target";
/** Everything this controller writes on an item; all removed on the way back to the bar. */
const BOOKKEEPING = [BANKED, INDEX, SAVED_ROLE, SAVED_TABINDEX, SAVED_MENU_TARGET] as const;
/**
 * Suffix of the marker on the More label this controller wrote into the trigger;
 * the marker holds that label as its value. The trigger is this controller's only
 * while it holds that label and nothing else: text the consumer rewrites there, or
 * an element child, an `aria-label` or an `aria-labelledby` they add, makes it
 * theirs.
 */
const OWNED_LABEL = "owns-label";

/** `ParentNode.moveBefore` (Chromium 133+): relocates a node without removing it first. */
interface MovableParent {
  moveBefore?: (node: Node, child: Node | null) => void;
}

/**
 * Headless **overflow / priority menu**: items that no longer fit their container are
 * moved into a "More" dropdown (lowest `data-priority` first) and moved back as space
 * returns, watched with a {@link ResizeObserver} (no dedicated APG pattern — a
 * composition; the menu's a11y is delegated to Menu, so it is not re-implemented).
 *
 * Markup contract (identifier: `stimeo--overflow-menu`):
 *   <nav data-controller="stimeo--overflow-menu" aria-label="Actions">
 *     <div data-stimeo--overflow-menu-target="items">
 *       <button data-priority="1">Save</button>
 *       <button>Delete</button>
 *     </div>
 *     <div data-controller="stimeo--menu" data-stimeo--overflow-menu-target="more" hidden>
 *       <button id="more-trigger" data-stimeo--menu-target="trigger"
 *         aria-haspopup="menu" aria-expanded="false"
 *         data-action="click->stimeo--menu#toggle
 *                      keydown->stimeo--menu#onTriggerKeydown">More</button>
 *       <div role="menu" aria-labelledby="more-trigger"
 *            data-stimeo--menu-target="menu" hidden></div>
 *     </div>
 *   </nav>
 *
 * This controller does not own the root's role. It ships none: a navigation bar is
 * a named `<nav>` whose items stay in the normal Tab order. A consumer may add
 * `role="toolbar"`, but that alone is not an APG Toolbar — the single-tab-stop
 * roving is {@link ToolbarController}'s behavior, not this one's — and a named
 * role still needs `aria-label` / `aria-labelledby`.
 *
 * Two parts of that contract are load-bearing and easy to drop. The banked-items
 * container is a permissive single `role="menu"` element this controller appends to
 * directly; use a `<div>`, since a `<ul>` cannot directly own the moved controls. And the
 * trigger's `data-action` is **required, not decoration**: without it the More button
 * never opens, and `keydown->stimeo--menu#onTriggerKeydown` is what makes it reachable
 * by keyboard at all (`Enter` / `Space` / `ArrowDown`). It is spelled out above rather
 * than referenced, because the keyboard half of this contract lives *only* in the
 * consumer's markup — nothing in this controller's source would reveal its absence.
 * Items need no bindings of their own — Menu delegates their handling from its own
 * element, so a control that only becomes a menu item at runtime is operable the
 * moment it lands.
 *
 * A bare More trigger — no text, no element child, no `aria-label` or
 * `aria-labelledby` — gets `moreLabel` as its text on every pass, before the pass
 * measures it, marked with `data-<identifier>-owns-label` whose value is that
 * label. The trigger stays this controller's only while it holds that label and
 * nothing else — the text still matches the marker, and it has no element child,
 * `aria-label` or `aria-labelledby` — and only then does a `moreLabel` swapped at
 * runtime rewrite it, or an empty one hand it back bare. Any other trigger content
 * is the author's and is never written: a trigger the consumer has rewritten, or
 * added an element child or a name to, is neither rewritten nor emptied, and its
 * marker stays where it is. Once it holds the label alone again, it is this
 * controller's again.
 *
 * On connect (and every debounced resize) it measures the items against the container's
 * content width and, when they overflow, banks the lowest-priority ones into the More
 * menu — giving each `role="menuitem"` / `tabindex="-1"` and the menu's `item` target so
 * Menu drives it — until the rest fit beside the More button. When nothing overflows the
 * More wrapper (button *and* menu) is `hidden`. The controller element carries
 * `data-overflowing` / `data-overflow-count`, and a `change` event fires on connect and
 * on every later transition.
 *
 * `change` dispatches `{ overflowCount, total }`.
 *
 * @remarks
 * **Measuring.** The container's width must not be derived from its content (give the bar
 * an explicit width, `flex: 1`, or plain block layout): the More button is revealed before
 * measuring, so a shrink-to-fit container always reports "items + gap + More" and nothing
 * ever overflows. The budget is the container's *content box* (`clientWidth` minus its
 * horizontal padding); the gap between items comes from the items container, the gap
 * reserved for the More button from the bar itself. Item widths are cached (a natural
 * width is location-independent) so a pass reads only the items in the bar — one reflow,
 * not two. The trade-off: an item whose content changes *while banked* (a locale switch, a
 * badge update) keeps its stale width until it is back in the bar, so it may return one
 * pass late; re-measuring it in place would cost a second reflow every pass. An item the
 * author marked `hidden` is out of the budget, out of the drop order, and never banked; it
 * holds its canonical slot and rejoins as soon as the attribute goes away. Toggling
 * `hidden` is an attribute change, not a resize, so call `update` after it.
 *
 * **Moving.** Items are moved (never cloned), and only the nodes that are actually out of
 * place — a pass that changes nothing touches no node, because re-inserting a node removes
 * it first and the browser then drops focus to `<body>`. Where `moveBefore` is supported
 * the move preserves focus and transient element state outright.
 *
 * **Focus.** When the focused item (or a descendant of it) *starts* retreating into a
 * collapsed menu it would be hidden and lose focus, so focus is redirected to the More
 * trigger (falling back to the More wrapper when the markup has no trigger — give it one,
 * or focus is left to the browser). While the menu is expanded the item stays visible, so
 * focus is left alone — unless the focused item is the one returning to the bar, which
 * takes focus out of the wrapper and leaves the expanded menu with nothing that owns it;
 * the menu is then closed and focus stays on the returned item. When the last banked item
 * returns, the wrapper is about to be hidden: the menu is closed and focus is moved out of
 * it to the last item that can actually hold it (`hidden` and disabled ones cannot), or to
 * the root when none can.
 *
 * **Priority.** Lower `data-priority` is kept longer; a value that is absent, empty, or
 * not a number ranks lowest and drops first.
 *
 * **Turbo.** The managed set and the canonical order are rebuilt *from the DOM* every
 * pass, so a fresh `connect()` onto markup that already holds banked items (cache restore,
 * a morph, a clone, server-rendered overflow) re-adopts them instead of orphaning them
 * inside a wrapper it would then hide. Symmetrically, `disconnect()` and
 * `turbo:before-cache` return every item to the bar, collapse the composed menu (so it
 * releases its dismissal-stack membership rather than being snapshotted mid-gesture),
 * take back the More label the trigger still holds alone, and strip the items'
 * bookkeeping attributes, so a cached snapshot is the authored DOM. A trigger the
 * consumer added to after the label was written keeps the label and its marker:
 * taking either off would write to content that belongs to the consumer. The
 * `ResizeObserver` and debounce timer are released on `disconnect()` too.
 *
 * Behavior only — no styling.
 */
export class OverflowMenuController extends Controller<HTMLElement> {
  /** One bookkeeping attribute, in the namespace this controller is registered under. */
  #attr(name: string): string {
    return `data-${this.identifier}-${name}`;
  }

  static override targets = ["items", "more"];
  static override values = {
    moreLabel: { type: String, default: "More" },
    debounce: { type: Number, default: 100 },
  };
  static actions = ["update"] as const;
  static events = ["change"] as const;

  declare readonly itemsTarget: HTMLElement;
  declare readonly moreTarget: HTMLElement;
  declare readonly hasItemsTarget: boolean;
  declare readonly hasMoreTarget: boolean;

  declare moreLabelValue: string;
  declare debounceValue: number;

  readonly #layout = new LayoutObserver(() => this.#scheduleUpdate());
  readonly #timers = new SafeTimeout();
  /** The managed items in canonical (authored) order, rebuilt from the DOM each pass. */
  #items: HTMLElement[] = [];
  #index = new WeakMap<HTMLElement, number>();
  /** Cached bar-context width per item; see the class remarks for the staleness caveat. */
  #widths = new WeakMap<HTMLElement, number>();
  /** Last reported overflow count, so `change` fires only on transitions. */
  #lastHidden: number | null = null;
  /** The `tabindex` this instance lends the root for the focus fallback. */
  readonly #tabindex = new TabindexLoan();

  /** Hands Turbo a snapshot of the bar with every item back in place. */
  readonly #beforeCache = new BeforeCacheReset(() => this.#restoreAll());
  /**
   * Whether `connect()` has run for this connection. Stimulus delivers Value
   * callbacks ahead of it, and the first pass writes the label anyway.
   */
  #connected = false;

  override connect(): void {
    this.#connected = true;
    if (!this.hasItemsTarget || !this.hasMoreTarget) return;

    this.#beforeCache.activate();
    this.#layout.observe(this.element);
    this.#layout.observeViewport();
    this.update();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#layout.disconnect();
    this.#timers.clearAll();
    this.#beforeCache.deactivate();
    this.#restoreAll();
    this.#lastHidden = null;
  }

  /**
   * Follows a More label swapped in place by a morph, on a trigger that still holds
   * the label this controller wrote and nothing else. Render only: nothing is
   * measured and `change` is not dispatched here; the next pass measures the bar.
   */
  moreLabelValueChanged(): void {
    if (!this.#connected || !this.hasItemsTarget || !this.hasMoreTarget) return;
    this.#syncLabel();
  }

  /** Re-measures and rebalances items between the bar and the More menu. */
  update(): void {
    if (!this.hasItemsTarget || !this.hasMoreTarget) return;
    // The label is part of the More button's width, so it is in place before the
    // button is measured below.
    this.#syncLabel();
    this.#syncItems();

    // Reveal More so its trigger is measurable, then refresh the widths of the items
    // currently in the bar (menu items keep their location-independent last value).
    this.moreTarget.hidden = false;
    // Server-rendered overflow arrives with items already in the menu, which is
    // hidden, so they measure zero and the budget would read as "everything fits".
    // Bring the set back to the bar once, unbanked, so the first balance works from
    // real widths taken in the context the items are actually laid out in — a
    // banked item can carry consumer styling of its own.
    if (
      this.#items.some((item) => item.parentElement !== this.itemsTarget && !this.#widths.has(item))
    ) {
      this.#removeBoundary();
      for (const item of this.#items) this.#unbank(item);
      this.#reorder(this.itemsTarget, this.#items);
    }
    for (const item of this.#items) {
      if (item.parentElement === this.itemsTarget) this.#widths.set(item, item.offsetWidth);
    }
    const moreWidth = (this.#trigger() ?? this.moreTarget).offsetWidth;
    const itemGap = this.#gap(this.itemsTarget); // between the items themselves
    const barGap = this.#gap(this.element); // between the items row and the More button

    const widthOf = (el: HTMLElement): number => this.#widths.get(el) ?? el.offsetWidth;
    const containerWidth = this.element.clientWidth - this.#paddingX(this.element);
    // An authored `hidden` item occupies no width, but a naive count would still
    // charge a gap for it and could bank a sibling that in fact fits — or raise a
    // More button whose menu has nothing operable in it. It keeps its canonical
    // slot; it just does not take part in the budget or in the drop order.
    const rendered = this.#items.filter((item) => this.#rendered(item));
    const itemsWidth = rendered.reduce((sum, el) => sum + widthOf(el), 0);
    let visibleWidth = itemsWidth + Math.max(0, rendered.length - 1) * itemGap;

    const hidden = new Set<HTMLElement>();
    if (visibleWidth > containerWidth) {
      const budget = containerWidth - moreWidth - barGap; // reserve the More button + its gap
      // Drop lowest-retention first: no usable `data-priority` (rank ∞), then highest
      // number; ties broken right-to-left so leading items survive.
      const dropOrder = [...rendered].sort(
        (a, b) => this.#rank(b) - this.#rank(a) || this.#indexOf(b) - this.#indexOf(a),
      );
      for (const item of dropOrder) {
        if (visibleWidth <= budget) break;
        hidden.add(item);
        visibleWidth -= widthOf(item) + itemGap; // dropping an item frees its width and a gap
      }
    }

    // Decided before any node moves, so it cannot race the browser's blur.
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focused = active === null ? null : this.#ownerOf(active);
    const retreating =
      focused !== null &&
      hidden.has(focused) &&
      focused.parentElement === this.itemsTarget && // i.e. *starting* to retreat
      !this.#menuExpanded();
    // The mirror image: the item holding focus is on its way *out* of an expanded
    // menu. Focus rides along with the node, but once it sits outside the More
    // wrapper the menu owns nothing that reaches it — the shared dismissal
    // resolver stops claiming for this layer, and the item's own menu bindings
    // fall out of Stimulus scope. Leaving the menu open would strand it with no
    // owner, so it is collapsed after the move (see below).
    const returning =
      focused !== null &&
      !hidden.has(focused) &&
      focused.parentElement !== this.itemsTarget && // i.e. *leaving* the menu
      this.#menuExpanded();

    // A fully-banked snapshot retains an inert split point so a fresh controller can
    // tell prepend from append. Once a real item remains in the bar, its saved index is
    // the stronger anchor and the boundary must not participate in DOM reordering.
    if (hidden.size === 0 || hidden.size !== this.#items.length) this.#removeBoundary();

    // The menu pass runs first, so retreating items leave the bar before it is reordered
    // (otherwise every trailing item would be shuffled needlessly).
    for (const item of this.#items) {
      if (hidden.has(item)) this.#bank(item);
      else this.#unbank(item);
    }
    this.#reorder(
      this.#menuList(),
      this.#items.filter((item) => hidden.has(item)),
    );
    this.#reorder(
      this.itemsTarget,
      this.#items.filter((item) => !hidden.has(item)),
    );

    if (retreating) (this.#trigger() ?? this.moreTarget).focus();
    else if (active !== null && this.#lostFocus(active)) active.focus();

    const count = hidden.size;
    // Keep the canonical positions on both sides while overflow exists. If the bar is
    // emptied, also retain an inert split point: a later prepend lands before it and an
    // append after it, preserving intent when a fresh controller adopts the snapshot.
    for (const item of this.#items) {
      if (count > 0) item.setAttribute(this.#attr(INDEX), String(this.#indexOf(item)));
      else item.removeAttribute(this.#attr(INDEX));
    }
    if (count > 0 && count === this.#items.length) this.#ensureBoundary();
    else this.#removeBoundary();
    const inMore =
      document.activeElement instanceof HTMLElement &&
      this.moreTarget.contains(document.activeElement);
    if (count === 0 || returning) {
      // Either the wrapper is about to be hidden — collapse the menu so it cannot
      // reappear expanded without a gesture, and move focus out before it
      // disappears — or the item that held focus just carried it out of the menu.
      // `close()` rather than the dismissal path, so the trigger does not take
      // back focus the user is now holding on the returned item; `inMore` is false
      // in that case, so the rescue below stays out of the way. Items still banked
      // remain reachable by reopening from the trigger.
      this.#closeMenu();
      if (inMore) this.#rescueFocus();
    }
    this.moreTarget.hidden = count === 0;
    if (count > 0) this.element.setAttribute("data-overflowing", "true");
    else this.element.removeAttribute("data-overflowing");
    this.element.setAttribute("data-overflow-count", String(count));

    if (this.#lastHidden !== count) {
      this.#lastHidden = count;
      this.dispatch("change", { detail: { overflowCount: count, total: this.#items.length } });
    }
  }

  /** The flex `column-gap` on `el` in px (0 when none / unsupported). */
  #gap(el: HTMLElement): number {
    const style = this.#styleOf(el);
    return style === null ? 0 : this.#px(style.columnGap || style.gap);
  }

  /** Horizontal padding on `el` in px — `clientWidth` counts it, the content box cannot. */
  #paddingX(el: HTMLElement): number {
    const style = this.#styleOf(el);
    return style === null ? 0 : this.#px(style.paddingLeft) + this.#px(style.paddingRight);
  }

  #styleOf(el: HTMLElement): CSSStyleDeclaration | null {
    return typeof window.getComputedStyle === "function" ? window.getComputedStyle(el) : null;
  }

  #px(value: string | undefined): number {
    const parsed = Number.parseFloat(value ?? "");
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  /**
   * Rebuilds the managed set and the canonical order from the DOM. The bar's children
   * give the order of everything inline (so a leading insert is not silently appended)
   * and {@link #merge} weaves the banked items back among them.
   */
  #syncItems(): void {
    const previous = this.#items;
    const bar: HTMLElement[] = [];
    let boundaryAt: number | undefined;
    for (const el of this.itemsTarget.children) {
      if (el instanceof HTMLTemplateElement && el.hasAttribute(this.#attr(BOUNDARY))) {
        boundaryAt ??= bar.length;
        continue;
      }
      if (el instanceof HTMLElement) bar.push(el);
    }

    const banked: HTMLElement[] = [];
    for (const el of this.#menuList().children) {
      if (el instanceof HTMLElement && el.hasAttribute(this.#attr(BANKED))) banked.push(el);
    }
    banked.sort((a, b) => this.#bankedIndex(a) - this.#bankedIndex(b));

    const items = this.#merge(bar, banked, boundaryAt);

    // An item re-homed elsewhere is no longer ours, but it would keep the menu
    // semantics we gave it — strip them before dropping it from the set.
    for (const el of previous) {
      if (!items.includes(el)) {
        this.#unbank(el);
        el.removeAttribute(this.#attr(INDEX));
      }
    }

    this.#items = items;
    this.#index = new WeakMap();
    items.forEach((el, i) => {
      this.#index.set(el, i);
    });
  }

  /**
   * Interleaves the banked items back among the bar's children.
   *
   * A saved index is a position in the *canonical* order, so it can only be compared
   * against another canonical position — never used as an offset into the current bar,
   * which is a shorter and differently-indexed list. (Doing so survives an untouched
   * round trip and silently scrambles the order as soon as the consumer inserts into a
   * bar that is already short, and `#bank()` then burns the scrambled index back into
   * the attribute, so widening never heals it.) Each bar child the controller already
   * knows carries its canonical index from the previous pass; a banked item goes in
   * front of the first known child whose index is higher.
   *
   * Children never seen before — inserted by the consumer since the last pass — have no
   * canonical position yet, so they keep their DOM neighbours. The exception is a
   * *trailing* run of them: appending to the bar means appending to the toolbar, so
   * everything banked is emitted before it.
   *
   * With no known child at all (a fresh instance connecting to markup that already
   * holds banked items), a fully-banked snapshot's inert boundary preserves whether an
   * unindexed run was prepended or appended before connect. Markup that holds banked items but no boundary —
   * server-rendered or hand-authored — uses the saved index as the
   * offset, the inverse of the move that banked it.
   */
  #merge(
    bar: readonly HTMLElement[],
    banked: readonly HTMLElement[],
    boundaryAt?: number,
  ): HTMLElement[] {
    const canonical = bar.map((el) => this.#index.get(el) ?? this.#savedIndex(el));
    let lastKnown = -1;
    canonical.forEach((index, i) => {
      if (index !== undefined) lastKnown = i;
    });

    if (lastKnown === -1) {
      if (boundaryAt !== undefined) {
        return [...bar.slice(0, boundaryAt), ...banked, ...bar.slice(boundaryAt)];
      }
      const restored = [...bar];
      for (const item of banked) {
        restored.splice(Math.min(this.#bankedIndex(item), restored.length), 0, item);
      }
      return restored;
    }

    const items: HTMLElement[] = [];
    let next = 0;
    const drainWhile = (accept: (saved: number) => boolean): void => {
      while (next < banked.length) {
        const item = banked[next];
        if (item === undefined || !accept(this.#bankedIndex(item))) break;
        items.push(item);
        next++;
      }
    };

    bar.forEach((el, i) => {
      const index = canonical[i];
      if (index !== undefined) drainWhile((saved) => saved < index);
      else if (i > lastKnown) drainWhile(() => true);
      items.push(el);
    });
    drainWhile(() => true);
    return items;
  }

  /** The canonical index a banked item saved, or ∞ (append) when it carries none. */
  #bankedIndex(item: HTMLElement): number {
    return this.#savedIndex(item) ?? Number.POSITIVE_INFINITY;
  }

  /** A finite canonical index stored on either side of the overflow split. */
  #savedIndex(item: HTMLElement): number | undefined {
    const raw = item.getAttribute(this.#attr(INDEX));
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  /** The inert split point written only when every managed item lives in More. */
  #boundary(): HTMLTemplateElement | null {
    for (const el of this.itemsTarget.children) {
      if (el instanceof HTMLTemplateElement && el.hasAttribute(this.#attr(BOUNDARY))) return el;
    }
    return null;
  }

  #ensureBoundary(): void {
    if (this.#boundary() !== null) return;
    const boundary = document.createElement("template");
    boundary.setAttribute(this.#attr(BOUNDARY), "");
    this.itemsTarget.appendChild(boundary);
  }

  #removeBoundary(): void {
    this.#boundary()?.remove();
  }

  /** Debounced re-measure for resize-driven churn. */
  #scheduleUpdate(): void {
    this.#timers.clearAll();
    this.#timers.set(() => this.update(), this.debounceValue);
  }

  /** Returns the menu list the items are banked into (falls back to the More wrapper). */
  #menuList(): HTMLElement {
    return (
      this.moreTarget.querySelector<HTMLElement>('[data-stimeo--menu-target="menu"]') ??
      this.moreTarget
    );
  }

  #trigger(): HTMLElement | null {
    return this.moreTarget.querySelector<HTMLElement>('[data-stimeo--menu-target="trigger"]');
  }

  /**
   * Keeps the More trigger's text on `moreLabel` wherever that text is this
   * controller's to write: a bare trigger, or one still holding the label this
   * controller wrote and nothing else. An empty `moreLabel` hands such a trigger
   * back bare. A pass that finds the label already in place writes nothing, and a
   * trigger that is neither is not written at all.
   *
   * @stimeoRenderRoot
   */
  #syncLabel(): void {
    const trigger = this.#trigger();
    if (trigger === null) return;
    const owned = this.#ownsLabel(trigger);
    if (!owned && !this.#isBareTrigger(trigger)) return;
    const label = this.moreLabelValue;
    if (label === "") {
      this.#releaseLabel(trigger);
      return;
    }
    if (owned && trigger.textContent === label) return;
    trigger.textContent = label;
    trigger.setAttribute(this.#attr(OWNED_LABEL), label);
  }

  /**
   * Whether the trigger holds the label this controller wrote there and nothing
   * else: the text still matches the marker, and the trigger carries nothing but
   * text. Ownership is read afresh on every call, so a trigger the consumer adds to
   * is theirs for as long as the addition is there.
   */
  #ownsLabel(trigger: HTMLElement): boolean {
    return (
      trigger.getAttribute(this.#attr(OWNED_LABEL)) === trigger.textContent &&
      this.#carriesOnlyText(trigger)
    );
  }

  /**
   * Takes the label this controller wrote back out of the trigger, leaving it bare.
   * A trigger that is not this controller's is left exactly as it is, marker
   * included: taking the marker off would itself write to it.
   */
  #releaseLabel(trigger: HTMLElement): void {
    if (!this.#ownsLabel(trigger)) return;
    trigger.textContent = "";
    trigger.removeAttribute(this.#attr(OWNED_LABEL));
  }

  /**
   * Whether the More trigger is bare, so the label is safe to write: no text, no
   * element child, no `aria-label` and no `aria-labelledby`. A trigger with neither
   * text, nor children, nor a name has nothing to lose and gets the fallback; one
   * that is empty *and* unnamed is the only case the label rescues.
   */
  #isBareTrigger(trigger: HTMLElement): boolean {
    return (trigger.textContent ?? "").trim() === "" && this.#carriesOnlyText(trigger);
  }

  /**
   * Whether the trigger carries nothing but text: no element child, no
   * `aria-label` and no `aria-labelledby`. Assigning `textContent` replaces
   * *every* child node, so a trigger holding an icon would silently lose it — and
   * the loss is permanent, since only the label this controller wrote is ever
   * taken back. A trigger that carries an accessible name is left alone too:
   * visible text written under a different `aria-label` would make the label and
   * the name disagree. Only a trigger that carries nothing but text is ever
   * written or emptied.
   */
  #carriesOnlyText(trigger: HTMLElement): boolean {
    return (
      trigger.firstElementChild === null &&
      !trigger.hasAttribute("aria-label") &&
      !trigger.hasAttribute("aria-labelledby")
    );
  }

  /**
   * Whether the More menu is expanded. Menu owns that state and reflects it on the
   * trigger's `aria-expanded`, so read the contract rather than guess from `hidden`
   * (which is absent until Menu connects).
   */
  #menuExpanded(): boolean {
    return this.#trigger()?.getAttribute("aria-expanded") === "true";
  }

  /**
   * Collapses the More menu before its wrapper is hidden. Menu owns the state (and the
   * Escape-stack membership that goes with it), so ask it; the DOM fallback covers markup
   * that reached an expanded state with no Menu mounted.
   */
  #closeMenu(): void {
    if (!this.#menuExpanded()) return;
    const menu = this.application.getControllerForElementAndIdentifier(
      this.moreTarget,
      "stimeo--menu",
    ) as MenuController | null;
    if (menu) {
      menu.close();
      return;
    }
    this.#trigger()?.setAttribute("aria-expanded", "false");
    const list = this.#menuList();
    if (list !== this.moreTarget) list.hidden = true;
  }

  /** The managed item that is, or contains, `el` — focus rescue works on either. */
  #ownerOf(el: HTMLElement): HTMLElement | null {
    return ownerOf(this.#items, el);
  }

  /** Whether the item takes up room in the bar; an authored `hidden` one does not. */
  #rendered(item: HTMLElement): boolean {
    return !item.hasAttribute("hidden");
  }

  /**
   * Moves focus out of the More wrapper just before it is hidden, to the last
   * item in canonical order that can hold it. When every item refuses, the root
   * takes focus instead of letting the browser drop it to `<body>`, borrowing a
   * `tabindex="-1"` just-in-time — not a Tab stop, and handed back on restore
   * when this controller was the one that added it.
   */
  #rescueFocus(): void {
    for (let i = this.#items.length - 1; i >= 0; i--) {
      const item = this.#items[i];
      // The shared pre-check, not `#rendered`: that one answers "does this item
      // take up room in the bar", which reads only the item's own `hidden`. Focus
      // eligibility has to see an ancestor's too — the same rule `#lostFocus`
      // applies below.
      if (item !== undefined && canTakeFocus(item)) {
        item.focus();
        return;
      }
    }
    this.#tabindex.lend(this.element);
    this.element.focus();
  }

  /**
   * Whether `el` held focus, is still in a visible part of this controller, and lost it —
   * what a re-insert does in a real browser. An item that retreated into a collapsed menu
   * is excluded: it sits in a `hidden` subtree and must not be focused back.
   */
  #lostFocus(el: HTMLElement): boolean {
    return (
      el.isConnected &&
      document.activeElement !== el &&
      this.element.contains(el) &&
      el.closest("[hidden]") === null
    );
  }

  /** Returns every item to the bar and removes all traces of this controller. */
  #restoreAll(): void {
    if (!this.hasItemsTarget || !this.hasMoreTarget) return;
    this.#syncItems();
    this.#removeBoundary();
    this.#reorder(this.itemsTarget, this.#items);
    for (const item of this.#items) {
      this.#unbank(item);
      item.removeAttribute(this.#attr(INDEX));
    }
    // The wrapper is being hidden for good, so the composed menu must not stay
    // expanded behind it: an unclosed menu keeps its dismissal-stack membership
    // and would be written into a Turbo snapshot mid-gesture. Focus is left
    // exactly where it is — this path runs at teardown, where moving it would be
    // the surprise.
    this.#closeMenu();
    const trigger = this.#trigger();
    if (trigger !== null) this.#releaseLabel(trigger);
    this.moreTarget.hidden = true;
    this.element.removeAttribute("data-overflowing");
    this.element.removeAttribute("data-overflow-count");
    this.#tabindex.returnAll();
  }

  /**
   * Makes `parent`'s managed children match `sequence`, moving only what is out of place.
   * Walking backwards lets each item be compared against the element that should follow
   * it, so an unchanged run costs zero DOM mutations — the point of the exercise, since
   * every re-insert blurs the focused node.
   */
  #reorder(parent: HTMLElement, sequence: readonly HTMLElement[]): void {
    let next: HTMLElement | null = null;
    for (let i = sequence.length - 1; i >= 0; i--) {
      const item = sequence[i];
      if (item === undefined) continue;
      if (item.parentElement !== parent || item.nextElementSibling !== next) {
        this.#insert(parent, item, next);
      }
      next = item;
    }
  }

  /** Relocates `item`, preferring `moveBefore` (keeps focus and element state). */
  #insert(parent: HTMLElement, item: HTMLElement, before: HTMLElement | null): void {
    const move = (parent as HTMLElement & MovableParent).moveBefore;
    if (typeof move === "function") {
      try {
        move.call(parent, item, before);
        return;
      } catch {
        // Not movable in place (e.g. a disconnected node) — fall through.
      }
    }
    parent.insertBefore(item, before);
  }

  /**
   * Gives an item menuitem semantics for Menu to drive and records its canonical index,
   * saving every authored value it overwrites ("" means the attribute was absent).
   */
  #bank(item: HTMLElement): void {
    if (!item.hasAttribute(this.#attr(BANKED))) {
      item.setAttribute(this.#attr(BANKED), "true");
      item.setAttribute(this.#attr(SAVED_ROLE), item.getAttribute("role") ?? "");
      item.setAttribute(this.#attr(SAVED_TABINDEX), item.getAttribute("tabindex") ?? "");
      item.setAttribute(this.#attr(SAVED_MENU_TARGET), item.getAttribute(MENU_TARGET) ?? "");
      item.setAttribute("role", "menuitem");
      item.setAttribute("tabindex", "-1");
      item.setAttribute(MENU_TARGET, "item");
    }
    item.setAttribute(this.#attr(INDEX), String(this.#indexOf(item)));
  }

  /** Undoes the banking: restores every authored value and drops the bookkeeping. */
  #unbank(item: HTMLElement): void {
    if (!item.hasAttribute(this.#attr(BANKED))) return;
    this.#restoreAttr(item, "role", item.getAttribute(this.#attr(SAVED_ROLE)));
    this.#restoreAttr(item, "tabindex", item.getAttribute(this.#attr(SAVED_TABINDEX)));
    this.#restoreAttr(item, MENU_TARGET, item.getAttribute(this.#attr(SAVED_MENU_TARGET)));
    for (const name of BOOKKEEPING) item.removeAttribute(this.#attr(name));
  }

  /** Re-applies a saved attribute value, or removes the attribute when it was absent. */
  #restoreAttr(item: HTMLElement, name: string, original: string | null): void {
    if (original === null || original === "") item.removeAttribute(name);
    else item.setAttribute(name, original);
  }

  #indexOf(item: HTMLElement): number {
    return this.#index.get(item) ?? 0;
  }

  /**
   * Retention rank: lower keeps longer. An absent, empty, or non-numeric `data-priority`
   * ranks lowest (drops first) — empty is the common ERB accident
   * (`data-priority="<%= maybe_nil %>"`), and `Number("")` is 0, which would otherwise
   * read as the *highest* retention.
   */
  #rank(item: HTMLElement): number {
    const raw = item.getAttribute("data-priority");
    if (raw === null || raw.trim() === "") return Number.POSITIVE_INFINITY;
    const value = Number(raw);
    return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
  }
}
