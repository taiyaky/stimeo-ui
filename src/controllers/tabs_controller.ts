import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible tabs behavior.
 *
 * Markup contract (identifier: `stimeo--tabs`):
 *   <div data-controller="stimeo--tabs">
 *     <div role="tablist" aria-label="…">
 *       <button role="tab" id="tab-1" aria-controls="panel-1"
 *               data-stimeo--tabs-target="tab"
 *               data-action="stimeo--tabs#select
 *                            keydown->stimeo--tabs#onKeydown">Tab 1</button>
 *       <!-- more tabs -->
 *     </div>
 *     <div role="tabpanel" id="panel-1" aria-labelledby="tab-1"
 *          data-stimeo--tabs-target="panel">…</div>
 *     <!-- more panels -->
 *   </div>
 *
 * Implements the WAI-ARIA APG **Tabs** pattern with **automatic activation**:
 * moving focus with the arrow keys immediately selects the focused tab. Tabs are
 * paired to panels by index (the Nth tab controls the Nth panel).
 *
 * @remarks
 * Behavior only. State is exposed through `aria-selected`, roving `tabindex`
 * (`0` for the active tab, `-1` for the rest), and the panel `hidden` attribute;
 * the consumer owns all styling.
 *
 * Behavior provided:
 * - Click a tab to select it.
 * - `ArrowRight`/`ArrowLeft` move to and select the next/previous tab (wrapping);
 *   `Home`/`End` select the first/last tab.
 */
export class TabsController extends Controller<HTMLElement> {
  static override targets = ["tab", "panel"];
  static actions = ["onKeydown", "select"] as const;

  declare readonly tabTargets: HTMLButtonElement[];
  declare readonly panelTargets: HTMLElement[];

  /** Selects the initially active tab (the pre-selected one, else the first). */
  override connect(): void {
    const preselected = this.tabTargets.findIndex(
      (tab) => tab.getAttribute("aria-selected") === "true",
    );
    this.#selectIndex(preselected === -1 ? 0 : preselected, { focus: false });
  }

  /** Selects the clicked tab. Bound via `data-action` (click). */
  select(event: Event): void {
    const index = this.tabTargets.indexOf(event.currentTarget as HTMLButtonElement);
    if (index !== -1) this.#selectIndex(index, { focus: false });
  }

  /** Implements arrow/Home/End navigation with automatic activation. */
  onKeydown(event: KeyboardEvent): void {
    const tabs = this.tabTargets;
    const currentIndex = tabs.indexOf(event.currentTarget as HTMLButtonElement);
    if (currentIndex === -1) return;

    let nextIndex: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (currentIndex + 1) % tabs.length;
        break;
      case "ArrowLeft":
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    this.#selectIndex(nextIndex, { focus: true });
  }

  /**
   * Activates the tab/panel pair at `index`: updates `aria-selected`, the roving
   * `tabindex`, and panel visibility. Optionally moves focus to the new tab.
   */
  #selectIndex(index: number, { focus }: { focus: boolean }): void {
    this.tabTargets.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
    });
    this.panelTargets.forEach((panel, i) => {
      panel.hidden = i !== index;
    });
    if (focus) this.tabTargets[index]?.focus();
  }
}
