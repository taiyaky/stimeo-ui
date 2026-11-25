import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
import { BlurDeferral } from "../utils/blur_deferral";
import { LayoutObserver } from "../utils/layout_observer";

/**
 * Sub-pixel tolerance (px) applied to the overflow comparison.
 *
 * Fractional layout metrics (zoom, `border-box` rounding, fractional font
 * metrics) routinely make `scrollWidth` exceed `clientWidth` by a fraction of a
 * pixel on a trail that visually fits, which would collapse it for no reason.
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
 * `toggle` dispatches `{ expanded: boolean }`.
 *
 * @remarks
 * Behavior only — the consumer owns separators (CSS) and the look. The items to
 * collapse are the author-marked `collapsible` targets (the source of truth),
 * placed between the leading and trailing items that must always stay visible.
 *
 * Behavior provided:
 * - Detects overflow via a shared layout observer (element + viewport resize) and a
 *   `MutationObserver` on the list (content edits, Turbo Stream / morph item
 *   swaps); the public `update` action re-measures on demand.
 * - While overflowing and not expanded, hides the `collapsible` items and shows
 *   the `ellipsis` item; when it fits, shows everything, hides the ellipsis and
 *   resets the expanded state (so a later collapse starts collapsed).
 * - The disclosure `trigger` toggles `aria-expanded` and the collapsed items,
 *   dispatching `stimeo--breadcrumb:toggle`. `toggle` acts if the last measured
 *   trail overflowed, including when the disclosure is temporarily absent.
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
 * The disclosure borrows `hidden` on the items and ellipsis, and `aria-expanded`
 * on the trigger. An element that leaves those targets gets its authored value
 * back, including when the identifier is removed from a trail that stays in the
 * document. Moves within the same target scope and removal of the whole trail
 * preserve its state, so Turbo can restore the disclosure as the user left it.
 *
 * A consumer that also wants to own `hidden` on the same element (for a reason of
 * its own) is not supported: the overflow measurement clears it on every pass to
 * read the expanded width.
 *
 * Focus safety: hiding the element the user is standing on would drop focus to
 * `<body>`. Before a collapse, the controller records whether an item holds focus,
 * applies visibility, then moves that focus to the disclosure `trigger`. When the
 * ellipsis would be hidden while it holds focus, the hide waits for `blur`.
 *
 * **Fail-safe when the disclosure is incomplete.** Collapsing needs all of
 * `list`, one `collapsible`, `ellipsis`, and `trigger`; miss any and the trail
 * degrades to a plain APG breadcrumb (every item visible, ellipsis hidden,
 * `aria-expanded="false"`). Hiding the middle items
 * with no control that can reveal them puts the path out of reach for good — a
 * too-wide trail is the cheaper failure. The logical expanded state remains
 * available to the next complete disclosure.
 */
export class BreadcrumbController extends Controller<HTMLElement> {
  static override targets = ["list", "collapsible", "ellipsis", "trigger"];
  static actions = ["toggle", "update"] as const;
  static events = ["toggle"] as const;

  declare readonly listTarget: HTMLElement;
  declare readonly collapsibleTargets: HTMLElement[];
  declare readonly ellipsisTarget: HTMLElement;
  declare readonly ellipsisTargets: HTMLElement[];
  declare readonly triggerTarget: HTMLElement;
  declare readonly triggerTargets: HTMLElement[];
  declare readonly hasListTarget: boolean;
  declare readonly hasEllipsisTarget: boolean;
  declare readonly hasTriggerTarget: boolean;

  /** Guards target callbacks that can fire outside the connected window. */
  #connected = false;
  /** Whether the last complete trail measurement overflowed its container. */
  #overflowing = false;
  /** Whether the user has expanded the collapsed items via the disclosure. */
  #expanded = false;
  /** The list element currently observed (resize + mutations), if any. */
  #observedList: HTMLElement | null = null;
  #listMutations: MutationObserver | null = null;
  readonly #hidden = new AttributeLease<HTMLElement>("hidden", this.identifier);
  readonly #triggerExpanded = new AttributeLease<HTMLElement>("aria-expanded", this.identifier);
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
    this.#overflowing = false;
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
   * Re-measures when an `ellipsis` target arrives. The `ellipsis` and `trigger`
   * targets form the disclosure set, a precondition for collapsing at all, so they
   * need the same watching the list and items get: without their callbacks a swap
   * that breaks or completes the set would only take effect at the next resize or
   * list mutation, which may never come.
   */
  ellipsisTargetConnected(): void {
    this.#resync();
  }

  /** Re-measures when an `ellipsis` target leaves the disclosure set. */
  ellipsisTargetDisconnected(element: HTMLElement): void {
    if (this.#leftTargets(element, this.ellipsisTargets)) {
      this.#deferredHide.releaseAll();
      this.#hidden.return(element);
    }
    this.#resync();
  }

  /** Re-measures when a `trigger` target joins the disclosure set. */
  triggerTargetConnected(): void {
    this.#resync();
  }

  /** Re-measures when a `trigger` target leaves the disclosure set. */
  triggerTargetDisconnected(element: HTMLElement): void {
    if (this.#leftTargets(element, this.triggerTargets)) this.#triggerExpanded.return(element);
    this.#resync();
  }

  /** Hands `hidden` back before re-measuring the remaining targets. */
  collapsibleTargetDisconnected(element: HTMLElement): void {
    if (this.#leftTargets(element, this.collapsibleTargets)) this.#hidden.return(element);
    this.#resync();
  }

  #leftTargets(element: HTMLElement, targets: readonly HTMLElement[]): boolean {
    return !this.scope.containsElement(element) || !targets.includes(element);
  }

  /**
   * Expands or re-collapses the trail and dispatches `toggle`.
   *
   * A trail that fits has nothing to expand. A temporarily incomplete
   * disclosure can still change the state established by its last measurement.
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
    if (this.#hasDisclosure()) {
      this.#overflowing = this.#measureOverflow();
      if (!this.#overflowing) this.#expanded = false;
    }
    this.#render();
  }

  /** Whether every target needed to expose the collapsed items is present. */
  #hasDisclosure(): boolean {
    return (
      this.hasListTarget &&
      this.hasEllipsisTarget &&
      this.hasTriggerTarget &&
      this.collapsibleTargets.length > 0
    );
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
   * The full disclosure set is a precondition for measuring. An incomplete
   * set temporarily renders as a plain breadcrumb.
   */
  #measureOverflow(): boolean {
    for (const item of this.collapsibleTargets) this.#hidden.write(item, null);
    this.#hidden.write(this.ellipsisTarget, "");
    return this.listTarget.scrollWidth > this.listTarget.clientWidth + OVERFLOW_EPSILON;
  }

  /**
   * Applies the collapsed/expanded state to the items, ellipsis, and trigger.
   */
  #render(): void {
    const showEllipsis = this.#overflowing && this.#hasDisclosure();
    const collapsed = showEllipsis && !this.#expanded;

    // Decided *before* the writes below: once a focused item is hidden the browser
    // drops focus to <body> and the information is gone.
    const rescueFocus =
      collapsed &&
      this.hasTriggerTarget &&
      this.collapsibleTargets.some((i) => this.#holdsFocus(i));

    for (const item of this.collapsibleTargets) this.#hidden.write(item, collapsed ? "" : null);
    if (this.hasEllipsisTarget) this.#applyEllipsisVisibility(showEllipsis);
    if (this.hasTriggerTarget) {
      // Never report expanded while the trail fits: nothing is collapsed to reveal.
      const expanded = showEllipsis && this.#expanded;
      this.#triggerExpanded.write(this.triggerTarget, expanded ? "true" : "false");
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
      this.#hidden.write(ellipsis, null);
      return;
    }

    const active = document.activeElement;
    if (active instanceof HTMLElement && ellipsis.contains(active)) {
      this.#hidden.write(ellipsis, null);
      this.#deferredHide.deferOnly(active);
      return;
    }

    this.#deferredHide.releaseAll();
    this.#hidden.write(ellipsis, "");
  }

  /** Whether `element` contains (or is) the currently focused element. */
  #holdsFocus(element: HTMLElement): boolean {
    const active = document.activeElement;
    return active instanceof HTMLElement && element.contains(active);
  }
}
