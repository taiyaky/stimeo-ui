import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";
import { type StateReason, stateReasonFor } from "../utils/state_reason";
import { StateRegions } from "../utils/state_regions";

/**
 * Headless, accessible accordion behavior.
 *
 * Markup contract (identifier: `stimeo--accordion`):
 *   <div data-controller="stimeo--accordion">
 *     <h3>
 *       <button id="trigger-1"
 *               data-stimeo--accordion-target="trigger"
 *               data-action="click->stimeo--accordion#toggle
 *                            keydown->stimeo--accordion#onKeydown"
 *               aria-expanded="false" aria-controls="panel-1">
 *         <span data-stimeo--accordion-target="expandedLabel" hidden>Hide section 1</span>
 *         <span data-stimeo--accordion-target="collapsedLabel">Show section 1</span>
 *       </button>
 *     </h3>
 *     <div id="panel-1" data-stimeo--accordion-target="panel"
 *          role="region" aria-labelledby="trigger-1" hidden>…</div>
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
 * - A header may carry an `expandedLabel` / `collapsedLabel` pair: the half that
 *   matches its `aria-expanded` is shown and the other hidden, settled as soon as
 *   the header and both halves are connected — whichever of them arrives last.
 *   Both halves belong inside the same header; a header holding only one of them
 *   keeps it exactly as authored. The header's accessible name stays the
 *   consumer's to write.
 * - {@link expandAll} / {@link collapseAll} open or close every panel at once,
 *   for an optional "expand all / collapse all" control pair anywhere in scope.
 * - Each move of a panel is reported: `stimeo--accordion:open` and
 *   `stimeo--accordion:close` dispatch
 *   `{ reason: StateReason, index: number, trigger: HTMLElement, panel: HTMLElement }`
 *   — `index` is the header's position in `triggerTargets` — after
 *   `aria-expanded` and `hidden` are written. Both are informational, so
 *   neither is cancelable. {@link expandAll} / {@link collapseAll} report one
 *   event per pair that actually moved, so a second `expandAll` says nothing.
 *   The controller establishes no baseline of its own — a header and the panel it
 *   controls keep the state their markup carries — so a connection reports nothing.
 */
export class AccordionController extends Controller<HTMLElement> {
  static override targets = ["trigger", "panel", "expandedLabel", "collapsedLabel"];
  static actions = ["collapseAll", "expandAll", "onKeydown", "toggle"] as const;
  static events = ["close", "open"] as const;

  declare readonly triggerTargets: HTMLButtonElement[];
  declare readonly panelTargets: HTMLElement[];
  declare readonly expandedLabelTargets: HTMLElement[];
  declare readonly collapsedLabelTargets: HTMLElement[];

  /** Owns `hidden` on the label pair a header declares, narrowed to that header. */
  readonly #labels = new StateRegions({
    whenTrue: () => this.expandedLabelTargets,
    whenFalse: () => this.collapsedLabelTargets,
  });

  /** Settles the label pair of a header as it joins the group. */
  triggerTargetConnected(trigger: HTMLButtonElement): void {
    this.#reflectLabels(trigger);
  }

  /** Settles the pair of the header an arriving expanded half belongs to. */
  expandedLabelTargetConnected(label: HTMLElement): void {
    this.#settleLabelHost(label);
  }

  /** Settles the pair of the header an arriving collapsed half belongs to. */
  collapsedLabelTargetConnected(label: HTMLElement): void {
    this.#settleLabelHost(label);
  }

  /** Reflects the pair of the header a label half sits in, where a header holds it. */
  #settleLabelHost(label: HTMLElement): void {
    const trigger = this.triggerTargets.find((candidate) => candidate.contains(label));
    if (trigger) this.#reflectLabels(trigger);
  }

  /** Toggles the panel controlled by the activated header. */
  toggle(event: Event): void {
    const trigger = event.currentTarget as HTMLButtonElement;
    const panel = this.#panelFor(trigger);
    if (!panel) return;

    this.#setExpanded(
      trigger,
      panel,
      trigger.getAttribute("aria-expanded") !== "true",
      stateReasonFor(event),
    );
  }

  /** Opens every panel. Bound via `data-action` on an "expand all" control. */
  expandAll(event?: Event): void {
    this.#setAll(true, stateReasonFor(event));
  }

  /** Closes every panel. Bound via `data-action` on a "collapse all" control. */
  collapseAll(event?: Event): void {
    this.#setAll(false, stateReasonFor(event));
  }

  /** Drives every header/panel pair to the same expanded state. */
  #setAll(open: boolean, reason: StateReason): void {
    for (const trigger of this.triggerTargets) {
      const panel = this.#panelFor(trigger);
      if (panel) this.#setExpanded(trigger, panel, open, reason);
    }
  }

  /** Reflects one header/panel pair's state through `aria-expanded` + `hidden`. */
  #setExpanded(
    trigger: HTMLButtonElement,
    panel: HTMLElement,
    open: boolean,
    reason: StateReason,
  ): void {
    const was = trigger.getAttribute("aria-expanded") === "true";
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    panel.hidden = !open;
    this.#labels.reflect(trigger, open);
    if (was === open) return;
    const detail = { reason, index: this.triggerTargets.indexOf(trigger), trigger, panel };
    if (open) this.dispatch("open", { detail, cancelable: false });
    else this.dispatch("close", { detail, cancelable: false });
  }

  /** Shows the half of a header's label pair that belongs to its `aria-expanded`. */
  #reflectLabels(trigger: HTMLButtonElement): void {
    this.#labels.reflect(trigger, trigger.getAttribute("aria-expanded") === "true");
  }

  /**
   * Moves focus between headers per the APG keyboard model, skipping any header
   * that is hidden or nested in a hidden subtree. A consumer may hide whole
   * sections (e.g. an `stimeo--filter` that collapses empty groups), and an
   * unperceivable header must never become an arrow-key target — otherwise
   * `.focus()` lands on nothing and navigation appears to stall.
   */
  onKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key (a grabbed drag handle, a
    // nested menu) must not ALSO act on it — composition depends on this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
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
