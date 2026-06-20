import { Controller } from "@hotwired/stimulus";
import { LayoutObserver } from "../utils/layout_observer";

/**
 * Headless, accessible responsive breadcrumb behavior.
 *
 * Markup contract (identifier: `stimeo--breadcrumb`):
 *   <nav data-controller="stimeo--breadcrumb" aria-label="Breadcrumb">
 *     <ol data-stimeo--breadcrumb-target="list">
 *       <li><a href="/">Home</a></li>
 *       <li data-stimeo--breadcrumb-target="ellipsis" hidden>
 *         <button type="button" aria-expanded="false" aria-controls="bc-collapsed"
 *                 aria-label="Show full path"
 *                 data-stimeo--breadcrumb-target="trigger"
 *                 data-action="stimeo--breadcrumb#toggle">…</button>
 *       </li>
 *       <li id="bc-collapsed" data-stimeo--breadcrumb-target="collapsible"><a href="/a">Section A</a></li>
 *       <li data-stimeo--breadcrumb-target="collapsible"><a href="/a/b">Sub B</a></li>
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
 * - Detects overflow via {@link LayoutObserver} (element + viewport resize).
 * - While overflowing and not expanded, hides the `collapsible` items and shows
 *   the `ellipsis` item; when it fits, shows everything and hides the ellipsis.
 * - The disclosure `trigger` toggles `aria-expanded` and the collapsed items,
 *   dispatching `stimeo--breadcrumb:toggle`.
 */
export class BreadcrumbController extends Controller<HTMLElement> {
  static override targets = ["list", "collapsible", "ellipsis", "trigger"];
  static actions = ["toggle"] as const;
  static events = ["toggle"] as const;

  declare readonly listTarget: HTMLElement;
  declare readonly collapsibleTargets: HTMLElement[];
  declare readonly ellipsisTarget: HTMLElement;
  declare readonly triggerTarget: HTMLElement;
  declare readonly hasListTarget: boolean;
  declare readonly hasEllipsisTarget: boolean;
  declare readonly hasTriggerTarget: boolean;

  /** Whether the trail currently overflows its container. */
  #overflowing = false;
  /** Whether the user has expanded the collapsed items via the disclosure. */
  #expanded = false;

  readonly #layout = new LayoutObserver(() => this.#update());

  /** Starts observing for overflow and renders the initial state. */
  override connect(): void {
    if (this.hasListTarget) this.#layout.observe(this.listTarget);
    this.#layout.observeViewport();
    this.#update();
  }

  /** Releases the resize observation (Turbo navigation included). */
  override disconnect(): void {
    this.#layout.disconnect();
  }

  /** Expands or re-collapses the trail and dispatches `toggle`. */
  toggle(): void {
    this.#expanded = !this.#expanded;
    this.#render();
    this.dispatch("toggle", { detail: { expanded: this.#expanded } });
  }

  /** Re-measures overflow and re-renders (e.g. on resize). */
  #update(): void {
    this.#overflowing = this.#measureOverflow();
    if (!this.#overflowing) this.#expanded = false;
    this.#render();
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
   */
  #measureOverflow(): boolean {
    if (!this.hasListTarget) return false;
    for (const item of this.collapsibleTargets) item.hidden = false;
    if (this.hasEllipsisTarget) this.ellipsisTarget.hidden = true;
    return this.listTarget.scrollWidth > this.listTarget.clientWidth;
  }

  /** Applies the collapsed/expanded state to the items, ellipsis, and trigger. */
  #render(): void {
    const collapsed = this.#overflowing && !this.#expanded;
    for (const item of this.collapsibleTargets) item.hidden = collapsed;
    if (this.hasEllipsisTarget) this.ellipsisTarget.hidden = !this.#overflowing;
    if (this.hasTriggerTarget) {
      this.triggerTarget.setAttribute("aria-expanded", this.#expanded ? "true" : "false");
    }
  }
}
