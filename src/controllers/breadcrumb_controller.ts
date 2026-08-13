import { Controller } from "@hotwired/stimulus";
import { BlurDeferral } from "../utils/blur_deferral";
import { LayoutObserver } from "../utils/layout_observer";

/**
 * Sub-pixel tolerance (px) applied to the overflow comparison.
 *
 * Fractional layout metrics (zoom, `border-box` rounding, fractional font
 * metrics) routinely make `scrollWidth` exceed `clientWidth` by a fraction of a
 * pixel on a trail that visually fits, which would collapse it for no reason.
 * Same constant and rationale as `scroll_area_controller.ts`'s `EDGE_EPSILON`.
 */
const OVERFLOW_EPSILON = 1;

/**
 * Headless, accessible responsive breadcrumb behavior.
 *
 * Markup contract (identifier: `stimeo--breadcrumb`):
 *   <nav data-controller="stimeo--breadcrumb" aria-label="Breadcrumb">
 *     <ol data-stimeo--breadcrumb-target="list">
 *       <li><a href="/">Home</a></li>
 *       <li data-stimeo--breadcrumb-target="ellipsis" hidden>
 *         <button type="button" aria-expanded="false" aria-controls="bc-a bc-b"
 *                 aria-label="Show full path"
 *                 data-stimeo--breadcrumb-target="trigger"
 *                 data-action="click->stimeo--breadcrumb#toggle">…</button>
 *       </li>
 *       <li id="bc-a" data-stimeo--breadcrumb-target="collapsible"><a href="/a">Section A</a></li>
 *       <li id="bc-b" data-stimeo--breadcrumb-target="collapsible"><a href="/a/b">Sub B</a></li>
 *       <li><a href="/a/b/c" aria-current="page">Item C</a></li>
 *     </ol>
 *   </nav>
 *
 * Implements the WAI-ARIA APG **Breadcrumb** pattern. The base structure (`nav`
 * + `ol` + `aria-current="page"`) lives in the markup; this controller adds the
 * responsive behavior: when the trail overflows its container it collapses the
 * author-marked middle items behind a disclosure (`…`) button, which expands
 * them back on demand.
 *
 * @remarks
 * Behavior only — the consumer owns separators (CSS) and the look. The items to
 * collapse are the author-marked `collapsible` targets (the source of truth),
 * placed between the leading and trailing items that must always stay visible.
 *
 * Behavior provided:
 * - Detects overflow via {@link LayoutObserver} (element + viewport resize) and a
 *   `MutationObserver` on the list (content edits, Turbo Stream / morph item
 *   swaps); the public `update` action re-measures on demand.
 * - While overflowing and not expanded, hides the `collapsible` items and shows
 *   the `ellipsis` item; when it fits, shows everything, hides the ellipsis and
 *   resets the expanded state (so a later collapse starts collapsed).
 * - The disclosure `trigger` toggles `aria-expanded` and the collapsed items,
 *   dispatching `stimeo--breadcrumb:toggle`. `toggle` is a no-op (no state
 *   change, no event) while the trail fits, so a hidden trigger can never be
 *   left reporting `aria-expanded="true"`.
 *
 * Layout requirements the behavior depends on:
 * - **The list must not wrap** (`white-space: nowrap` / `flex-wrap: nowrap`). A
 *   wrapping list grows in height instead of scroll width, so
 *   `scrollWidth === clientWidth` always holds and overflow is never detected.
 * - **The list width must follow its container** (no shrink-to-fit / intrinsic
 *   width). Overflow is re-measured synchronously inside the resize
 *   notification, so a list that widens to its content would never report
 *   overflow. There is deliberately no debounce: the pass is one write → one
 *   forced read → one write on a single element.
 * - Consumers must not neutralize `[hidden]` (e.g. `display: inline-flex` on the
 *   items wins over the UA's `[hidden] { display: none }`); collapsing is
 *   expressed exclusively through the `hidden` attribute.
 *
 * Ownership of `hidden`: this controller owns the attribute on an element **for as
 * long as that element is a `collapsible` target and the controller is connected**.
 * Outside that window it does not write it:
 * - lose the marker while connected → the element becomes an always-visible item
 *   and the controller clears the `hidden` it owned;
 * - controller `disconnect()` → the collapsed state is left in the DOM on purpose,
 *   because that DOM is what Turbo caches and restores.
 *
 * A consumer that also wants to own `hidden` on the same element (for a reason of
 * its own) is not supported: `#measureOverflow` clears it on every measurement to
 * read the expanded width.
 *
 * Focus safety: hiding the element the user is standing on would drop focus to
 * `<body>`. When a collapse would hide the focused item, focus moves to the
 * disclosure `trigger` first; when the ellipsis would be hidden while it holds
 * focus, the hide waits for `blur`.
 *
 * **Fail-safe when the disclosure is incomplete.** Collapsing needs all of
 * `list`, one `collapsible`, `ellipsis`, and `trigger`; miss any and the trail
 * degrades to a plain APG breadcrumb (every item visible, ellipsis hidden,
 * `aria-expanded="false"`, `toggle` a silent no-op). Hiding the middle items
 * with no control that can reveal them puts the path out of reach for good — a
 * too-wide trail is the cheaper failure. Watched at runtime, so a swap that
 * breaks the set releases the items and one that completes it starts collapsing.
 */
export class BreadcrumbController extends Controller<HTMLElement> {
  static override targets = ["list", "collapsible", "ellipsis", "trigger"];
  static actions = ["toggle", "update"] as const;
  static events = ["toggle"] as const;

  declare readonly listTarget: HTMLElement;
  declare readonly collapsibleTargets: HTMLElement[];
  declare readonly ellipsisTarget: HTMLElement;
  declare readonly triggerTarget: HTMLElement;
  declare readonly hasListTarget: boolean;
  declare readonly hasEllipsisTarget: boolean;
  declare readonly hasTriggerTarget: boolean;

  /** Guards target callbacks that can fire outside the connected window. */
  #connected = false;
  /** Whether the trail currently overflows its container. */
  #overflowing = false;
  /** Whether the user has expanded the collapsed items via the disclosure. */
  #expanded = false;
  /** The list element currently observed (resize + mutations), if any. */
  #observedList: HTMLElement | null = null;
  #listMutations: MutationObserver | null = null;
  readonly #layout = new LayoutObserver(() => this.update());

  readonly #onListMutation = (): void => {
    this.update();
  };

  /** Holds the ellipsis hide back while it contains focus; re-renders on blur. */
  readonly #deferredHide = new BlurDeferral(() => {
    this.#render();
  });

  /** Starts observing for overflow and renders the initial state. */
  override connect(): void {
    this.#connected = true;
    // The DOM is the source of truth on reconnect (Turbo cache restore / morph):
    // the trigger's `aria-expanded` is where the expanded state lives, so a trail
    // the user opened survives a back-navigation instead of silently re-collapsing.
    this.#expanded = this.#initialExpanded();
    this.#layout.observeViewport();
    this.#syncListObservation();
    this.update();
  }

  /** Releases the resize/mutation observation (Turbo navigation included). */
  override disconnect(): void {
    this.#connected = false;
    this.#deferredHide.releaseAll();
    this.#stopObservingList();
    this.#layout.disconnect();
  }

  listTargetConnected(): void {
    this.#resync();
  }

  listTargetDisconnected(): void {
    this.#resync();
  }

  collapsibleTargetConnected(): void {
    this.#resync();
  }

  /**
   * Re-measures when the disclosure set gains or loses a member. The set is a
   * precondition for collapsing at all, so it needs the same watching the list
   * and items get: without these callbacks a swap that breaks or completes the
   * set would only take effect at the next resize or list mutation, which may
   * never come.
   */
  ellipsisTargetConnected(): void {
    this.#resync();
  }

  ellipsisTargetDisconnected(): void {
    this.#resync();
  }

  triggerTargetConnected(): void {
    this.#resync();
  }

  triggerTargetDisconnected(): void {
    this.#resync();
  }

  /**
   * Hands `hidden` back when an element stops being a `collapsible` target.
   *
   * The marker is the source of truth for what may be collapsed, so an element
   * that loses it while the controller is live is an always-visible item again —
   * and `#render` only walks the *current* targets, so nothing else would ever
   * clear the `hidden` this controller put there.
   *
   * The `#connected` guard is load-bearing, not defensive. Stimulus fires this
   * callback for **every** target during teardown as well (`Context.disconnect()`
   * stops the target observer after `disconnect()` has run), and there the
   * collapsed DOM must survive untouched so Turbo's cache restores the trail in
   * the state the user left it (see the ownership note in {@link BreadcrumbController}).
   *
   * @param element - the element that just left the `collapsible` target set
   */
  collapsibleTargetDisconnected(element: HTMLElement): void {
    if (this.#connected) element.hidden = false;
    this.#resync();
  }

  /**
   * Expands or re-collapses the trail and dispatches `toggle`.
   *
   * No-op while the trail fits: there is nothing collapsed to reveal, and the
   * (hidden) trigger would otherwise keep a stale `aria-expanded="true"` that
   * surfaces pre-expanded the next time the trail overflows. No event is
   * dispatched in that case.
   */
  toggle(): void {
    if (!this.#connected || !this.#overflowing) return;
    this.#expanded = !this.#expanded;
    this.#render();
    this.dispatch("toggle", { detail: { expanded: this.#expanded } });
  }

  /**
   * Re-measures overflow and re-renders. Wired to resizes and list mutations;
   * exposed as an action so consumers can re-measure after a change the
   * observers cannot see (e.g. a web font swap that only alters text width).
   */
  update(): void {
    if (!this.#connected) return;
    this.#overflowing = this.#measureOverflow();
    if (!this.#overflowing) this.#expanded = false;
    this.#render();
  }

  /** Re-attaches the list observation (targets may have been swapped) and re-measures. */
  #resync(): void {
    if (!this.#connected) return;
    this.#syncListObservation();
    this.update();
  }

  /** Reads the expanded state back from its DOM home (the trigger's `aria-expanded`). */
  #initialExpanded(): boolean {
    return this.hasTriggerTarget && this.triggerTarget.getAttribute("aria-expanded") === "true";
  }

  /**
   * Points the resize + mutation observation at the current `list` target.
   *
   * The list is re-resolved rather than captured at connect so a target swapped
   * at runtime (Turbo Stream replacement of the `<ol>`) is observed too. Only
   * `childList` / `subtree` / `characterData` are watched — deliberately **not**
   * `attributes`, which the controller's own `hidden` writes would re-trigger.
   */
  #syncListObservation(): void {
    const next = this.hasListTarget ? this.listTarget : null;
    if (next === this.#observedList) return;

    this.#stopObservingList();
    if (!next) return;

    this.#observedList = next;
    this.#layout.observe(next);
    if (typeof MutationObserver !== "undefined") {
      this.#listMutations = new MutationObserver(this.#onListMutation);
      this.#listMutations.observe(next, { childList: true, subtree: true, characterData: true });
    }
  }

  #stopObservingList(): void {
    if (this.#observedList) this.#layout.unobserve(this.#observedList);
    this.#observedList = null;
    this.#listMutations?.disconnect();
    this.#listMutations = null;
  }

  /**
   * Measures overflow against the **fully expanded** layout so hiding items does
   * not make the condition oscillate. Reveals every item, then compares the list's
   * own scroll width to its own client width; `#render` immediately re-applies
   * the correct hidden state afterward.
   *
   * Both widths are read from the list element itself (not the host `nav`) so the
   * check is independent of any padding/border on the host — comparing against the
   * host's `clientWidth` would over-report the available space by its padding and
   * miss real overflow in a padded container.
   *
   * With no `collapsible` items there is nothing to collapse, so the trail is
   * never reported as overflowing (which also keeps the disclosure out of the
   * tab order — a button controlling nothing).
   *
   * The full disclosure set is a precondition: collapsing without an `ellipsis`
   * *and* a `trigger` would hide items behind a control that does not exist, so
   * an incomplete set reports "not overflowing" and `#render` degrades the trail
   * to a plain breadcrumb. Losing layout is recoverable; losing the path is not.
   */
  #measureOverflow(): boolean {
    if (!this.hasListTarget || this.collapsibleTargets.length === 0) return false;
    if (!this.hasEllipsisTarget || !this.hasTriggerTarget) return false;
    for (const item of this.collapsibleTargets) item.hidden = false;
    // No `hasEllipsisTarget` check: the line above already returned without one.
    this.ellipsisTarget.hidden = true;
    return this.listTarget.scrollWidth > this.listTarget.clientWidth + OVERFLOW_EPSILON;
  }

  /**
   * Applies the collapsed/expanded state to the items, ellipsis, and trigger.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    const collapsed = this.#overflowing && !this.#expanded;
    const showEllipsis = this.#overflowing && this.collapsibleTargets.length > 0;

    // Decided *before* the writes below: once a focused item is hidden the browser
    // drops focus to <body> and the information is gone (same reasoning as
    // `overflow_menu_controller`'s pre-move focus decision).
    const rescueFocus =
      collapsed &&
      this.hasTriggerTarget &&
      this.collapsibleTargets.some((i) => this.#holdsFocus(i));

    for (const item of this.collapsibleTargets) item.hidden = collapsed;
    if (this.hasEllipsisTarget) this.#applyEllipsisVisibility(showEllipsis);
    if (this.hasTriggerTarget) {
      // Never report expanded while the trail fits: the trigger is hidden then.
      const expanded = this.#overflowing && this.#expanded;
      this.triggerTarget.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
    if (rescueFocus) this.triggerTarget.focus();
  }

  /**
   * Shows or hides the ellipsis item, deferring a hide that would blur the user.
   *
   * Hiding the element that currently holds focus drops focus to `<body>`, so the
   * hide waits for that element's `blur` and is re-applied then (the shared
   * `BlurDeferral` registry).
   */
  #applyEllipsisVisibility(show: boolean): void {
    const ellipsis = this.ellipsisTarget;
    if (show) {
      this.#deferredHide.releaseAll();
      ellipsis.hidden = false;
      return;
    }

    const active = document.activeElement;
    if (active instanceof HTMLElement && ellipsis.contains(active)) {
      ellipsis.hidden = false;
      this.#deferredHide.deferOnly(active);
      return;
    }

    this.#deferredHide.releaseAll();
    ellipsis.hidden = true;
  }

  /** Whether `element` contains (or is) the currently focused element. */
  #holdsFocus(element: HTMLElement): boolean {
    const active = document.activeElement;
    return active instanceof HTMLElement && element.contains(active);
  }
}
