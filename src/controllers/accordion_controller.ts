import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible accordion behavior.
 *
 * Markup contract (identifier: `stimeo--accordion`):
 *   <div data-controller="stimeo--accordion">
 *     <h3>
 *       <button data-stimeo--accordion-target="trigger"
 *               data-action="stimeo--accordion#toggle
 *                            keydown->stimeo--accordion#onKeydown"
 *               aria-expanded="false" aria-controls="panel-1">Section 1</button>
 *     </h3>
 *     <div id="panel-1" data-stimeo--accordion-target="panel"
 *          role="region" hidden>…</div>
 *     <!-- repeat header/panel pairs -->
 *   </div>
 *
 * Implements the WAI-ARIA APG **Accordion** pattern. Each header button is
 * associated with its panel through `aria-controls`; the panel's `id` is the
 * single source of truth for the pairing, so headers and panels need not be
 * adjacent siblings.
 *
 * @remarks
 * Multiple panels may be open at once (this is the APG-allowed default). State
 * is reflected through `aria-expanded` on the header and the `hidden` attribute
 * on the panel — never through visual styling, which the consumer owns.
 *
 * Behavior provided:
 * - Click a header to toggle its panel (`aria-expanded` + `hidden` reflect state).
 * - `ArrowDown`/`ArrowUp` move focus between headers; `Home`/`End` jump to the
 *   first/last header. Hidden headers (including those inside a hidden subtree,
 *   e.g. a section a filter collapsed) are skipped so focus stays perceivable.
 * - {@link expandAll} / {@link collapseAll} open or close every panel at once,
 *   for an optional "expand all / collapse all" control pair anywhere in scope.
 */
export class AccordionController extends Controller<HTMLElement> {
  static override targets = ["trigger", "panel"];
  static actions = ["collapseAll", "expandAll", "onKeydown", "toggle"] as const;

  declare readonly triggerTargets: HTMLButtonElement[];
  declare readonly panelTargets: HTMLElement[];

  /** Toggles the panel controlled by the activated header. */
  toggle(event: Event): void {
    const trigger = event.currentTarget as HTMLButtonElement;
    const panel = this.#panelFor(trigger);
    if (!panel) return;

    this.#setExpanded(trigger, panel, trigger.getAttribute("aria-expanded") !== "true");
  }

  /** Opens every panel. Bound via `data-action` on an "expand all" control. */
  expandAll(): void {
    this.#setAll(true);
  }

  /** Closes every panel. Bound via `data-action` on a "collapse all" control. */
  collapseAll(): void {
    this.#setAll(false);
  }

  /** Drives every header/panel pair to the same expanded state. */
  #setAll(open: boolean): void {
    for (const trigger of this.triggerTargets) {
      const panel = this.#panelFor(trigger);
      if (panel) this.#setExpanded(trigger, panel, open);
    }
  }

  /** Reflects one header/panel pair's state through `aria-expanded` + `hidden`. */
  #setExpanded(trigger: HTMLButtonElement, panel: HTMLElement, open: boolean): void {
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    panel.hidden = !open;
  }

  /**
   * Moves focus between headers per the APG keyboard model, skipping any header
   * that is hidden or nested in a hidden subtree. A consumer may hide whole
   * sections (e.g. an `stimeo--filter` that collapses empty groups), and an
   * unperceivable header must never become an arrow-key target — otherwise
   * `.focus()` lands on nothing and navigation appears to stall.
   */
  onKeydown(event: KeyboardEvent): void {
    const current = event.currentTarget as HTMLButtonElement;
    if (this.triggerTargets.indexOf(current) === -1) return;

    // `closest("[hidden]")` catches both a directly-hidden header and one inside a
    // hidden ancestor (the filter-group case); navigate over the visible set only.
    const navigable = this.triggerTargets.filter((trigger) => trigger.closest("[hidden]") === null);
    const here = navigable.indexOf(current);
    if (here === -1) return;

    let next: HTMLButtonElement | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = navigable[(here + 1) % navigable.length];
        break;
      case "ArrowUp":
        next = navigable[(here - 1 + navigable.length) % navigable.length];
        break;
      case "Home":
        next = navigable[0];
        break;
      case "End":
        next = navigable[navigable.length - 1];
        break;
      default:
        return;
    }

    event.preventDefault();
    next?.focus();
  }

  /** Resolves the panel a header controls via its `aria-controls` reference. */
  #panelFor(trigger: HTMLButtonElement): HTMLElement | null {
    const id = trigger.getAttribute("aria-controls");
    return id ? (this.panelTargets.find((panel) => panel.id === id) ?? null) : null;
  }
}
