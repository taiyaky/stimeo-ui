import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";
import { claimsWhileFocusWithin, EscapeLayer } from "../utils/escape_layer";
import { isRtl } from "../utils/logical_scroll";
import { RovingTabindex } from "../utils/roving_tabindex";
import { SafeTimeout } from "../utils/safe_timeout";
import { findTypeaheadMatch, isTypeaheadKey, Typeahead } from "../utils/typeahead";

/** Where to land focus when a menu opens. */
type OpenFocus = "first" | "last";

/**
 * Attributes whose runtime change flips a top item's navigability, watched so the
 * single Tab stop survives a consumer disabling or hiding the item that held it.
 *
 * `tabindex` is deliberately absent — this controller writes it, and observing it
 * would feed back into the observer. `aria-disabled` is absent for a different
 * reason: per the APG it keeps an item focusable and only blocks activation, so
 * it never changes *which* top can hold the Tab stop.
 */
const STATE_ATTRIBUTES = ["disabled", "hidden"];

/**
 * Headless, accessible **menubar** behavior.
 *
 * Markup contract (identifier: `stimeo--menubar`):
 *   <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
 *     <button role="menuitem" aria-haspopup="menu" aria-expanded="false"
 *             aria-controls="m-file" data-stimeo--menubar-target="top"
 *             data-action="click->stimeo--menubar#toggle
 *                          keydown->stimeo--menubar#onTopKeydown">File</button>
 *     <ul id="m-file" role="menu" data-stimeo--menubar-target="menu" hidden>
 *       <li role="none">
 *         <button role="menuitem" tabindex="-1" data-stimeo--menubar-target="item"
 *                 data-action="click->stimeo--menubar#activate
 *                              keydown->stimeo--menubar#onItemKeydown">New</button>
 *       </li>
 *     </ul>
 *     <!-- more top items + menus -->
 *   </div>
 *
 * Implements the WAI-ARIA APG **Menubar** pattern (single level): the top items
 * form one Tab stop via roving tabindex and the arrow keys move between them;
 * `ArrowDown`/`Enter`/`Space` open a menu (`ArrowUp` opens it at the last item),
 * the arrow keys then move within the menu, and pressing `ArrowLeft`/`ArrowRight`
 * while a menu is open jumps to the adjacent top menu. `Escape` closes and
 * returns focus to the owning top item — while a menu is open the menubar is a
 * layer on the shared {@link EscapeLayer} stack, claiming a press only while
 * focus is inside the controller or fell to the body, so one keypress closes
 * exactly one layer. `Tab` and an outside click close.
 *
 * @remarks
 * Behavior only. Each top item↔menu pair is linked by `aria-controls`/`id` (not by
 * position), so *pairing* does not depend on the markup order. Where the order does
 * show is native `Tab`/`Shift+Tab`: the browser walks the DOM, so `Shift+Tab` out of
 * a menu lands on the owning top item only while the menu follows it — write the
 * conventional owner-then-menu order to get the destinations described here. Menu
 * placement and viewport-edge collision are out of scope — static placement is the
 * consumer's CSS, and dynamic placement is delegated to the opt-in
 * `stimeo-ui/positioning` module (never imported here, keeping the core
 * zero-dependency). Roving mechanics across the top items are delegated to
 * {@link RovingTabindex}.
 *
 * Focus-restoration contract: closing via `Escape` or an item activation returns
 * focus to the owning top item; `Tab` and an outside click deliberately do **not**
 * — they close where the user is already heading, and yanking focus back would
 * fight the pointer/Tab move.
 *
 * Disabledness follows the APG's two-attribute split, which is the consumer's way
 * of saying which one they mean:
 * - **`hidden` / natively `disabled`** — removed from the roving set entirely, so
 *   the lone Tab stop never lands on an unfocusable top item (which would drop the
 *   whole menubar out of the Tab order) and the arrow keys never stall on it.
 * - **`aria-disabled="true"`** — still reached by the arrow keys ("disabled menu
 *   items are focusable but cannot be activated"), so a screen-reader user can
 *   discover it; only *activation* is suppressed. Clicks on it — including the one
 *   a browser synthesizes for Enter/Space — are swallowed before consumer handlers
 *   run, and an `aria-disabled` top never opens its menu, since opening the popup
 *   is activation. Moving onto it still closes whatever menu was open, which the
 *   APG makes unconditional for a horizontal move.
 *
 * Arrow directions are logical: `ArrowRight` moves to the next top item under LTR
 * and to the previous one under RTL, on the bar and from inside an open menu. A top
 * item may also be a **plain command** with no `aria-controls` at all: moving to it
 * behaves the same way — the open menu closes and it takes the roving focus. A top
 * item whose `aria-controls` names no menu target is broken markup instead, and the
 * open/closed state is left alone rather than acted on by guesswork.
 *
 * A menu with no navigable items still opens (its `aria-expanded` flips and focus
 * stays on the top item) so a consumer that fills a menu asynchronously keeps
 * working; `Escape` or a second click closes it. While such a menu is
 * structurally empty the consumer **must** carry `aria-busy="true"` on it and drop
 * that once the items land — `role="menu"` requires owned `menuitem`s, and this
 * controller cannot tell "still loading" from "nothing to show", so it never
 * infers the state. A menu whose items exist but are all inert is not busy.
 *
 * Runtime DOM edits (Turbo Streams, a consumer swapping menus in) are reconciled
 * from the live targets: expanded flags, menu visibility, the single Tab stop, and
 * Escape-stack membership are re-derived whenever a top/menu target is added or
 * removed, and whenever `disabled`/`hidden` changes under the menubar.
 */
export class MenubarController extends Controller<HTMLElement> {
  static override targets = ["top", "menu", "item"];
  static actions = ["activate", "onItemKeydown", "onTopKeydown", "toggle"] as const;

  declare readonly topTargets: HTMLButtonElement[];
  declare readonly menuTargets: HTMLElement[];
  declare readonly itemTargets: HTMLButtonElement[];

  /** Roving tabindex across the top-level menuitems (one Tab stop). */
  readonly #roving = new RovingTabindex(() => this.topTargets);
  /** Typeahead query and its idle-reset timer (scoped to the open menu). */
  readonly #typeahead = new Typeahead();
  readonly #timers = new SafeTimeout();

  /** Escape-stack membership while a menu is open; the shared resolver dismisses via it. */
  readonly #escapeLayer = new EscapeLayer();
  /** Whether {@link #escapeLayer} is currently on the stack (see {@link #syncEscapeLayer}). */
  #layerActive = false;

  /** Watches `disabled`/`hidden` under the menubar; `null` while disconnected. */
  #observer: MutationObserver | null = null;
  /**
   * Live between `connect()` and `disconnect()`. Stimulus reports the *initial*
   * targets before `connect()` and re-reports them as disconnected afterwards;
   * gating on this keeps the target callbacks from clobbering the authored Tab
   * stop on mount and from resurrecting one after teardown.
   */
  #connected = false;

  /** The element inside the menubar that last took DOM focus, if any. */
  #focused: HTMLElement | null = null;

  /**
   * Records where DOM focus sits inside the menubar. `focusin` bubbles, so one
   * listener covers the top items and everything nested in their menus. The
   * record is needed because a top or menu becomes unreachable *before* this
   * controller hears about it, by which point the browser has already reset
   * `document.activeElement`.
   */
  readonly #onFocusIn = (event: FocusEvent): void => {
    this.#focused = event.target as HTMLElement | null;
  };

  /**
   * Forgets the record once focus genuinely lands on something else, so a later
   * mutation cannot pull focus back in. A `relatedTarget` of `null` is the case
   * that must be kept: it is what "focus went nowhere" looks like, which is
   * exactly the state the rescue exists for.
   */
  readonly #onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget as HTMLElement | null;
    if (next && !this.element.contains(next)) this.#focused = null;
  };

  /**
   * Establishes the closed baseline and the single tab stop: keep an existing tab
   * stop when it is still navigable (so a Turbo cache restore preserves the user's
   * position), else fall back to the first navigable top item.
   *
   * The outside-click listener is registered in the **capture** phase: in the
   * bubble phase an inside handler that removes its own click target detaches the
   * node before `contains()` runs, so an *inside* click would read as outside and
   * close the menu.
   */
  override connect(): void {
    this.#closeAllMenus();
    this.#reconcile();
    this.element.addEventListener("click", this.#onDisabledClickCapture, true);
    this.element.addEventListener("focusin", this.#onFocusIn);
    this.element.addEventListener("focusout", this.#onFocusOut);
    document.addEventListener("click", this.#onOutsideClick, true);
    if (typeof MutationObserver !== "undefined") {
      this.#observer = new MutationObserver(() => this.#reconcile());
      this.#observer.observe(this.element, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: STATE_ATTRIBUTES,
      });
    }
    this.#connected = true;
  }

  /** Removes the listeners, stack membership, and any pending timer (typeahead / Tab close). */
  override disconnect(): void {
    this.#connected = false;
    this.#escapeLayer.deactivate();
    this.#layerActive = false;
    this.element.removeEventListener("click", this.#onDisabledClickCapture, true);
    this.element.removeEventListener("focusin", this.#onFocusIn);
    this.element.removeEventListener("focusout", this.#onFocusOut);
    document.removeEventListener("click", this.#onOutsideClick, true);
    this.#focused = null;
    this.#observer?.disconnect();
    this.#observer = null;
    // The typeahead owns its own timer registry, so `#timers.clearAll()` does not
    // reach its pending reset — drop it explicitly or it outlives the element.
    this.#typeahead.reset();
    this.#timers.clearAll();
  }

  /**
   * A top item added at runtime is dropped out of the Tab sequence first — a fresh
   * `<button>` is tabbable by default, which would leave the menubar with two Tab
   * stops — before the lone stop is re-established.
   */
  topTargetConnected(top: HTMLButtonElement): void {
    if (!this.#connected) return;
    top.tabIndex = -1;
    this.#reconcile();
  }

  /**
   * Removing a top item can strand two things: the Tab stop it held, and the menu
   * it owned (which nothing could close afterwards).
   *
   * The departing element is handed back in a neutral state first. A target can
   * leave without leaving the document — a morph that only drops the
   * `data-*-target` token keeps the node — and it would then sit in the page
   * carrying this controller's `tabindex="0"` (a second Tab stop next to the one
   * re-established below) and an `aria-expanded="true"` nothing can collapse.
   * When the node really is gone these writes are harmless no-ops.
   */
  topTargetDisconnected(top: HTMLButtonElement): void {
    if (!this.#connected) return;
    top.tabIndex = -1;
    if (this.#isExpanded(top)) top.setAttribute("aria-expanded", "false");
    this.#reconcile();
  }

  /** See {@link MenubarController.menuTargetDisconnected}. */
  menuTargetConnected(): void {
    if (!this.#connected) return;
    this.#reconcile();
  }

  /**
   * A menu removed while open leaves its owner claiming `aria-expanded="true"` for
   * a popup that no longer exists, and the menubar holding an Escape layer that
   * would swallow presses meant for something else.
   *
   * As with {@link MenubarController.topTargetDisconnected}, the departing menu is
   * closed first: a token-only removal leaves a visible popup in the page that no
   * key and no click can dismiss any more.
   */
  menuTargetDisconnected(menu: HTMLElement): void {
    if (!this.#connected) return;
    if (!menu.hidden) menu.hidden = true;
    this.#reconcile();
  }

  /** Toggles a top item's menu. Bound via `data-action` (click on the top item). */
  toggle(event: Event): void {
    const top = event.currentTarget as HTMLButtonElement;
    if (this.#isExpanded(top)) {
      this.#closeMenu(top);
    } else {
      this.#openMenu(top, "first");
    }
  }

  /** Keyboard handling while focus is on a top item. */
  onTopKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key (a grabbed drag handle, an
    // inline editor) must not ALSO move the roving focus — composition depends on
    // this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    const tops = this.#navigableTops;
    const index = tops.indexOf(event.currentTarget as HTMLButtonElement);
    if (index === -1) return;
    const length = tops.length;
    // Whether a menu is currently open governs whether horizontal moves *open*
    // the adjacent menu or merely move the roving focus between top items.
    const anyOpen = this.#isAnyOpen;

    // Logical, not physical. APG defines these as "next / previous control", and
    // says a vertical arrangement swaps in Down/Up for the same meaning — so the
    // pair is one axis's spelling of an order, and the order reverses with the
    // writing direction. Read from the controller element: the container is what
    // lays the items out, and a child may carry its own `dir` (an LTR input inside
    // an RTL form is ordinary authoring).
    const step = isRtl(this.element) ? -1 : 1;

    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        this.#gotoTop(tops[(index + step + length) % length], anyOpen);
        break;
      case "ArrowLeft":
        event.preventDefault();
        this.#gotoTop(tops[(index - step + length) % length], anyOpen);
        break;
      case "ArrowDown":
        event.preventDefault();
        this.#openMenu(tops[index], "first");
        break;
      case "ArrowUp":
        event.preventDefault();
        this.#openMenu(tops[index], "last");
        break;
      case "Home":
        event.preventDefault();
        this.#gotoTop(tops[0], anyOpen);
        break;
      case "End":
        event.preventDefault();
        this.#gotoTop(tops[length - 1], anyOpen);
        break;
      case "Tab":
        // Focus is leaving the menubar: close, but let the browser's own Tab move
        // run first (see #closeMenusSoon).
        this.#closeMenusSoon();
        break;
      default:
        break;
    }
    // Enter/Space are intentionally left to the native button click, which runs
    // toggle(): it opens the menu at its first item, or closes it when that menu
    // is already open. Handling them here would double-fire.
    // Escape is owned by the shared EscapeLayer resolver (see #dismissOpenMenu).
  }

  /** Keyboard handling while focus is on a menu item. */
  onItemKeydown(event: KeyboardEvent): void {
    // See onTopKeydown: a key a descendant already consumed is not ours.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    const item = event.currentTarget as HTMLButtonElement;
    const menu = item.closest<HTMLElement>("[role='menu']");
    if (!menu) return;
    const items = this.#itemsIn(menu);
    // -1 when the key came from a non-navigable item (still focusable by mouse):
    // the relative moves below then land on the first navigable item.
    const index = items.indexOf(item);
    const length = items.length;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.#focusAt(items, (index + 1) % length);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.#focusAt(items, (index - 1 + length) % length);
        break;
      case "Home":
        event.preventDefault();
        this.#focusAt(items, 0);
        break;
      case "End":
        event.preventDefault();
        this.#focusAt(items, length - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        this.#moveToAdjacentMenu(menu, isRtl(this.element) ? -1 : 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        this.#moveToAdjacentMenu(menu, isRtl(this.element) ? 1 : -1);
        break;
      case "Tab":
        // Per APG, Tab closes the menubar but lets focus move on naturally.
        this.#closeMenusSoon();
        break;
      default:
        if (isTypeaheadKey(event)) {
          event.preventDefault();
          this.#typeaheadTo(items, index, event.key);
        }
        break;
    }
    // Enter/Space activate the item via its native button click → activate().
  }

  /** Closes the owning menu after an item is activated and refocuses its top. */
  activate(event: Event): void {
    const item = event.currentTarget as HTMLElement;
    const menu = item.closest<HTMLElement>("[role='menu']");
    const top = this.#topFor(menu);
    this.#closeAllMenus();
    this.#focusTop(top);
  }

  /** Moves the roving focus to `top`, opening its menu when one was open. */
  #gotoTop(top: HTMLButtonElement | undefined, reopen: boolean): void {
    if (!top) return;
    if (reopen) {
      this.#openMenu(top, "first");
    } else {
      // The roving index is resolved against the full target list, since that is
      // what carries the tabindex bookkeeping.
      this.#roving.setActive(this.topTargets.indexOf(top), { focus: true });
    }
  }

  /**
   * Opens `top`'s menu (closing others) and focuses its first/last item.
   *
   * Three kinds of top item never open a menu:
   * - **`aria-disabled`** — focusable but never activated, and opening a popup is
   *   activation.
   * - **plain command** (no `aria-controls` at all) — a legitimate top item that
   *   simply has no popup.
   * - **dangling `aria-controls`** (names a menu that is not a target) — broken
   *   markup.
   *
   * The first two still take the roving focus, and any open menu closes: the APG
   * makes closing unconditional for the horizontal move ("closes the submenu,
   * moves focus to the next menubar item, and *optionally* opens that item's
   * submenu"), so only the opening half is skipped. Leaving the old menu open
   * would strand a popup that no longer contains focus.
   *
   * The dangling case instead leaves the open/closed state and focus untouched
   * rather than closing everything and dropping focus to the body — but only on
   * this "open a menu" path. A dangling top is still an ordinary roving
   * destination while nothing is open.
   */
  #openMenu(top: HTMLButtonElement | null | undefined, focus: OpenFocus): void {
    if (!top) return;
    // Resolve the menu *before* touching any state, so the dangling case below
    // can bail out without having changed anything.
    const menu = this.#menuFor(top);
    if (!menu || this.#isActivationBlocked(top)) {
      // Broken markup (an `aria-controls` that resolves to nothing) is the one
      // case that must not act on a guess.
      if (menu || !top.hasAttribute("aria-controls")) {
        this.#closeAllMenus();
        this.#focusTop(top);
      }
      return;
    }
    // A reopen must discard a pending Tab close, or that stale task would slam
    // the freshly opened menu shut on the next tick.
    this.#timers.clearAll();
    this.#closeAllMenus();
    menu.hidden = false;
    top.setAttribute("aria-expanded", "true");
    this.#escapeLayer.activate(document, {
      onDismiss: () => this.#dismissOpenMenu(),
      claims: claimsWhileFocusWithin(this.element),
    });
    // Opening always re-registers, which puts this layer back on top of the
    // stack — the menubar is the innermost thing the user just interacted with.
    this.#layerActive = true;
    this.#roving.setActive(this.topTargets.indexOf(top));
    const items = this.#itemsIn(menu);
    this.#focusAt(items, focus === "first" ? 0 : items.length - 1);
  }

  /**
   * Hides `top`'s menu and reflects the collapsed state. A top item that controls
   * no menu (a plain command in an otherwise popup-bearing menubar) is left alone
   * — stamping `aria-expanded="false"` on it would announce a popup it lacks.
   */
  #closeMenu(top: HTMLButtonElement | null): void {
    if (!top) return;
    const menu = this.#menuFor(top);
    if (!menu) return;
    menu.hidden = true;
    top.setAttribute("aria-expanded", "false");
    this.#syncEscapeLayer();
  }

  /** Closes every menu and resets the typeahead query. */
  #closeAllMenus(): void {
    for (const top of this.topTargets) this.#closeMenu(top);
    this.#typeahead.reset();
  }

  /**
   * Closes every menu on the next task instead of synchronously.
   *
   * Used by `Tab`: closing right away removes the focused element before the
   * browser performs its own Tab move, which can restart traversal at the
   * document head and lose the user's place in the Tab order.
   */
  #closeMenusSoon(): void {
    if (!this.#isAnyOpen) return;
    this.#timers.clearAll();
    this.#timers.set(() => this.#closeAllMenus(), 0);
  }

  /**
   * Escape path, invoked by the shared resolver: pressed inside an open menu it
   * closes that menu and returns focus to its top item (the APG behavior);
   * pressed while focus is on a top item (or fell to the body) it closes every
   * menu without moving focus.
   */
  #dismissOpenMenu(): void {
    const active = document.activeElement;
    const menu = this.menuTargets.find((candidate) => candidate.contains(active));
    if (menu) {
      const top = this.#topFor(menu);
      this.#closeMenu(top);
      this.#focusTop(top);
      return;
    }
    this.#closeAllMenus();
  }

  /** Opens the menu of the navigable top item `delta` steps from `menu`'s owner. */
  #moveToAdjacentMenu(menu: HTMLElement, delta: number): void {
    const top = this.#topFor(menu);
    if (!top) return;
    const tops = this.#navigableTops;
    const current = tops.indexOf(top);
    if (current === -1) return;
    const next = (current + delta + tops.length) % tops.length;
    this.#openMenu(tops[next], "first");
  }

  /**
   * Closes when a click lands outside the controller's element. Focus is left on
   * whatever the user clicked — see the focus-restoration contract in the class
   * docs.
   */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (this.#isAnyOpen && !this.element.contains(event.target as Node)) this.#closeAllMenus();
  };

  /**
   * Captures clicks so `aria-disabled` top items and commands cannot reach
   * consumer handlers (nor `toggle`/`activate`). Native Enter/Space activation
   * also synthesizes a click and is blocked here; natively `disabled` buttons
   * dispatch no click at all.
   */
  readonly #onDisabledClickCapture = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    const blocked = [...this.topTargets, ...this.itemTargets].some(
      (element) => this.#isActivationBlocked(element) && element.contains(target),
    );
    if (!blocked) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /**
   * Re-derives every piece of state this controller owns from the live targets:
   * expanded flags, menu visibility, the single Tab stop, and Escape-stack
   * membership. Runtime DOM edits can leave those out of step with each other — a
   * top can claim `aria-expanded="true"` after its menu target was removed or after
   * being hidden itself, a menu can stay visible after its owning top was removed,
   * an open pair can appear from a morph with no layer registered for it, and the
   * Tab stop can end up on a now-inert top, on a runtime-added one, or on none at
   * all. Nothing is remembered between calls (except which side of the Escape stack
   * this layer is on, which the stack itself does not expose), so the outcome is the
   * same whichever mutation arrived and calling it more often than needed is free.
   */
  #reconcile(): void {
    for (const top of this.topTargets) {
      // A top is expanded only while its own menu resolves *and* is visible.
      // Both halves matter: the menu target can be removed outright, and a Turbo
      // Stream `replace` swaps it for a fresh (contract-`hidden`) one — which
      // still resolves, so a "did it disappear?" test alone would leave the top
      // claiming a popup nobody can see, and the Escape layer registered with it.
      // Only tops that already declare the attribute are touched: stamping
      // `aria-expanded` on a plain command would announce a popup it lacks.
      // The owner must also still be reachable: a consumer that `hidden`s or
      // natively disables an expanded top would otherwise leave its popup on
      // screen with no way back to the element that owns it.
      const own = this.#menuFor(top);
      if (this.#isExpanded(top) && (!own || own.hidden || !this.#isNavigable(top))) {
        top.setAttribute("aria-expanded", "false");
      }
    }
    for (const menu of this.menuTargets) {
      if (menu.hidden) continue;
      // A menu with no expanded owner can never be closed by the user again.
      const owner = this.#topFor(menu);
      if (!owner || !this.#isExpanded(owner)) menu.hidden = true;
    }
    this.#ensureTabStop();
    this.#rescueFocus();
    this.#syncEscapeLayer();
  }

  /**
   * Returns DOM focus to the menubar when the element holding it became
   * unreachable — hidden, natively disabled, or removed — and the document had
   * nowhere to put it. The destination is the top item that now owns the Tab
   * stop, which is where `Escape` from a closed menu would have left the user.
   *
   * Focus is only *restored*, never *stolen*: it moves solely when the tracked
   * element can no longer take it **and** focus is either already gone or still
   * sitting on that element. The second half is what makes a `hidden` ancestor
   * work — a browser blurs the element it hides on its next style pass, not when
   * the attribute is written, so waiting to observe `<body>` here would always
   * come too early. Removal is the other side of the same condition: the browser
   * has already fallen back to the body, or left a detached `activeElement`.
   */
  #rescueFocus(): void {
    const focused = this.#focused;
    if (!focused) return;
    // An ordinary close — Escape, Tab, an outside click — also leaves the focused
    // menu item inside a hidden subtree, but nothing went away and the user is
    // already on their way somewhere. Only an owner that can no longer be reached
    // is a reason to move focus, so the owner decides, not the item.
    const owner = this.topTargets.find(
      (top) => top === focused || this.#menuFor(top)?.contains(focused),
    );
    if (focused.isConnected && owner && this.#isNavigable(owner)) return;
    const doc = this.element.ownerDocument;
    const active = doc.activeElement;
    const lost =
      active === null ||
      active === doc.body ||
      active === doc.documentElement ||
      !active.isConnected ||
      active === focused ||
      focused.contains(active);
    if (!lost) return;
    const index = this.#roving.activeIndex;
    const top = index === -1 ? undefined : this.topTargets[index];
    if (top && top !== focused && !focused.contains(top)) top.focus();
  }

  /**
   * Brings Escape-stack membership back in line with what the DOM now says is
   * open, in both directions.
   *
   * The deactivate half is the common one (something closed). The activate half
   * covers a menu that became open *without* going through {@link #openMenu} —
   * a Turbo morph that patches `aria-expanded` and the menu's `hidden` in place,
   * which is legitimate here because the DOM is this controller's only source of
   * truth. Without it the popup is visible but `Escape` does nothing, since no
   * layer is registered to claim the press.
   *
   * `#layerActive` exists because re-activating an already-active layer moves it
   * to the top of the stack, which would reshuffle nested layers on every
   * unrelated mutation. Registering only on the false→true edge keeps activation
   * ordered by when each layer actually opened.
   */
  #syncEscapeLayer(): void {
    const open = this.#isAnyOpen;
    if (open === this.#layerActive) return;
    if (open) {
      this.#escapeLayer.activate(document, {
        onDismiss: () => this.#dismissOpenMenu(),
        claims: claimsWhileFocusWithin(this.element),
      });
    } else {
      this.#escapeLayer.deactivate();
    }
    this.#layerActive = open;
  }

  /**
   * Re-establishes the single Tab stop: keep the current one while it is still
   * navigable, else hand it to the first navigable top item. Every other top is
   * explicitly removed from the Tab sequence, so a top that arrived tabbable
   * cannot leave two stops behind. No Tab stop at all (`-1`) happens only when
   * every top is inert, and is recovered from as soon as one becomes navigable.
   */
  #ensureTabStop(): void {
    const active = this.#roving.activeIndex;
    const activeTop = active === -1 ? undefined : this.topTargets[active];
    if (activeTop && this.#isNavigable(activeTop)) {
      this.#roving.setActive(active);
      return;
    }
    const first = this.#navigableTops[0];
    this.#roving.setActive(first ? this.topTargets.indexOf(first) : -1);
  }

  /** The menu element controlled by `top` (matched by `aria-controls`/`id`). */
  #menuFor(top: HTMLElement): HTMLElement | null {
    const id = top.getAttribute("aria-controls");
    // Resolve against this controller's own menu targets (not a global id lookup)
    // so it stays scoped to this menubar instance.
    return id ? (this.menuTargets.find((menu) => menu.id === id) ?? null) : null;
  }

  /** The top item that controls `menu` (reverse of `#menuFor`). */
  #topFor(menu: HTMLElement | null): HTMLButtonElement | null {
    if (!menu) return null;
    return this.topTargets.find((top) => top.getAttribute("aria-controls") === menu.id) ?? null;
  }

  /** The navigable item targets that live inside `menu`, in DOM order. */
  #itemsIn(menu: HTMLElement): HTMLButtonElement[] {
    return this.itemTargets.filter((item) => menu.contains(item) && this.#isNavigable(item));
  }

  /** Top items eligible for the roving tab stop and the arrow keys. */
  get #navigableTops(): HTMLButtonElement[] {
    return this.topTargets.filter((top) => this.#isNavigable(top));
  }

  /**
   * Whether `element` can take roving focus: `hidden` and natively `disabled`
   * controls are out of reach and are skipped. `aria-disabled` is deliberately
   * **not** checked — the APG keeps such items focusable so they stay
   * discoverable, and {@link MenubarController.#isActivationBlocked} is what
   * suppresses acting on them. CSS-only visibility is not detectable headlessly
   * and stays the consumer's responsibility.
   */
  #isNavigable(element: HTMLButtonElement): boolean {
    if (element.hasAttribute("hidden")) return false;
    return !element.disabled;
  }

  /** Whether `element` is `aria-disabled`: reachable, but never activated. */
  #isActivationBlocked(element: Element): boolean {
    return element.getAttribute("aria-disabled") === "true";
  }

  /** Moves DOM focus to the item at `index` (no-op if out of range). */
  #focusAt(items: HTMLElement[], index: number): void {
    items[index]?.focus();
  }

  /** Returns roving focus to a top item (and makes it the single tab stop). */
  #focusTop(top: HTMLButtonElement | null): void {
    if (!top) return;
    this.#roving.setActive(this.topTargets.indexOf(top), { focus: true });
  }

  /** Whether `top`'s menu is currently expanded. */
  #isExpanded(top: HTMLElement): boolean {
    return top.getAttribute("aria-expanded") === "true";
  }

  /** Whether any top item's menu is currently open. */
  get #isAnyOpen(): boolean {
    return this.topTargets.some((top) => this.#isExpanded(top));
  }

  /** Advances focus to the next item in `items` matching the accumulated query. */
  #typeaheadTo(items: HTMLElement[], current: number, key: string): void {
    const index = findTypeaheadMatch(items, current, this.#typeahead.push(key));
    if (index !== -1) items[index]?.focus();
  }
}
