import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { INTERACTIVE_HOST_SELECTOR, isInteractiveHost } from "../utils/interactive_host";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

/** Cycle order for a sortable column header's `aria-sort`. */
const SORT_CYCLE = ["none", "ascending", "descending"] as const;
type SortDirection = (typeof SORT_CYCLE)[number];

/**
 * Returns the next `aria-sort` direction in the cycle after `current`. Unknown or
 * ARIA-only values (e.g. `"other"`, or an empty/missing attribute) are treated as
 * `"none"`, so the first activation always advances to `"ascending"` instead of
 * stalling.
 */
function nextSortDirection(current: string): SortDirection {
  const index = SORT_CYCLE.indexOf(current as SortDirection);
  const from = index < 0 ? 0 : index;
  return SORT_CYCLE[(from + 1) % SORT_CYCLE.length] ?? "ascending";
}

/**
 * Headless, accessible **Data Grid** behavior: column sorting, row selection, and
 * roving keyboard navigation over an interactive table.
 *
 * Markup contract (identifier: `stimeo--data-grid`):
 *   <table data-controller="stimeo--data-grid" role="grid" aria-label="Users"
 *          data-stimeo--data-grid-selection-value="single">
 *     <thead><tr role="row">
 *       <th role="columnheader" aria-sort="none" tabindex="-1"
 *           data-stimeo--data-grid-target="columnHeader"
 *           data-action="click->stimeo--data-grid#sort
 *                        keydown->stimeo--data-grid#onKeydown">Name</th>
 *     </tr></thead>
 *     <tbody><tr role="row" aria-selected="false"
 *                data-stimeo--data-grid-target="row">
 *       <td role="gridcell" tabindex="0" data-stimeo--data-grid-target="cell"
 *           data-action="keydown->stimeo--data-grid#onKeydown">Jane</td>
 *     </tr></tbody>
 *   </table>
 *
 * Implements the WAI-ARIA APG **Grid** pattern plus `aria-sort`. The whole grid is
 * a single Tab stop (roving `tabindex`: exactly one cell/header is `0`, the rest
 * `-1`); arrow keys move both DOM focus and that tabbable position. Sort state is
 * exposed via `aria-sort` on headers, selection via `aria-selected` on rows.
 *
 * `selectionchange` dispatches `{ rows: HTMLElement[] }`; `sort` dispatches
 * `{ column: HTMLElement, direction: "ascending" | "descending" | "none" }`.
 *
 * @remarks
 * Behavior only — the consumer performs the actual data sort/render in response to
 * the `sort` event and owns all styling. No timers or observers are held, so there
 * is nothing to leak across Turbo navigations; `connect()` rebuilds the single tab
 * stop idempotently from the DOM, and the target callbacks rebuild it again after
 * rows or cells are added or removed at runtime.
 *
 * Behavior provided:
 * - `Arrow*` move between cells (clamped at edges); `Home`/`End` to the row's
 *   first/last cell; `Ctrl+Home`/`Ctrl+End` to the grid's first/last cell.
 * - `Enter`/`Space` cycles a header's sort (`none→ascending→descending`) or toggles
 *   the focused row's selection when selection is enabled.
 *
 * Consumer contract — controls nested inside a cell or header:
 * - APG's grid hosts working controls in its cells, so a keystroke or click that
 *   reached one — {@link INTERACTIVE_HOST_SELECTOR}, an editable host, or any
 *   widget that already called `preventDefault()` — is left to it entirely: no
 *   move, no sort, no selection. The one control that hands the event on is a
 *   sortable header's own `<button>`, whose activation is what the click carries.
 * - A control keeps its own Tab behavior, so give it `tabindex="-1"` to preserve
 *   the grid's single Tab stop. A sortable `columnheader` hosting a `<button>` is
 *   the common case: the roving position stays on the header, and the button's
 *   own activation reaches `sort` through the click that bubbles to it.
 * - Host `role="gridcell"` / `role="columnheader"` on a non-interactive element
 *   (`td`, `th`); an interactive host makes the grid stand down on that cell.
 */
export class DataGridController extends Controller<HTMLElement> {
  static override targets = ["columnHeader", "row", "cell"];
  static override values = {
    selection: { type: String, default: "none" },
  };
  static actions = ["onKeydown", "sort", "toggleSelect"] as const;
  static events = ["selectionchange", "sort"] as const;

  declare readonly columnHeaderTargets: HTMLElement[];
  declare readonly rowTargets: HTMLElement[];
  declare readonly cellTargets: HTMLElement[];
  declare selectionValue: string;

  /**
   * Collapses the per-element target callbacks of one DOM mutation into a single
   * baseline pass, and refuses to run before `connect()` or after `disconnect()`.
   *
   * Stimulus reports every target one at a time, so an ungated pass would re-walk
   * the whole grid once per authored cell on mount and once per streamed cell
   * afterwards — quadratic in the cell count both times.
   */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#restoreBaseline());

  /**
   * Establishes a single tab stop across all navigable cells/headers and brings
   * the rows to their baseline.
   *
   * Normalizing here rather than leaving it to {@link selectionValueChanged}
   * guarantees exactly one pass per mount: a re-attached element reuses its
   * cached Stimulus context, whose value observer already knows the `selection`
   * attribute, so the Value callback does not fire a second time.
   */
  override connect(): void {
    this.#restoreBaseline();
    this.#reconcile.activate();
  }

  /** Closes the reconcile window so a queued pass cannot run against a detached tree. */
  override disconnect(): void {
    this.#reconcile.cancel();
  }

  /**
   * Rebuilds both DOM-owned baselines from the live grid: exactly one navigable
   * cell is in the Tab sequence, and every selectable row carries an explicit
   * `aria-selected`.
   *
   * The tab stop keeps whichever cell already holds it, so a rebuild triggered by
   * an unrelated row arriving does not throw the user's position away; only when
   * no cell holds it — the grid is fresh, or the holder was removed — does the
   * first navigable cell take over. Without that fallback a grid whose active row
   * is removed keeps every cell at `-1` and drops out of the Tab sequence
   * entirely.
   */
  #restoreBaseline(): void {
    const cells = this.#navigableCells();
    const active = cells.find((cell) => cell.tabIndex === 0) ?? cells[0];
    if (active) this.#setActiveCell(active, { focus: false }, cells);
    this.#normalizeSelection();
  }

  /**
   * Keeps `aria-multiselectable` in step with the `selection` Value. Fires on connect
   * (so it self-heals after a Turbo morph) and on any runtime change, so the ARIA
   * never drifts from the selection logic, which reads `selectionValue` live.
   */
  selectionValueChanged(): void {
    this.#syncSelectable();
    this.#normalizeSelection();
  }

  /** Re-establishes the baselines for a row added after connect. */
  rowTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Re-establishes the tab stop when a cell joins the grid after connect. */
  cellTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Re-establishes the tab stop when a cell leaves the grid. */
  cellTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Re-establishes the tab stop when a header joins the grid after connect. */
  columnHeaderTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Re-establishes the tab stop when a header leaves the grid. */
  columnHeaderTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /**
   * Brings the authored rows to the shape the APG requires, without changing
   * which rows the author chose.
   *
   * Every selectable row gets an explicit value — an absent `aria-selected` means
   * "not selectable" in ARIA, so a forgotten attribute hides a selectable row —
   * and a single-select grid keeps at most one `true`, first in DOM order.
   * A grid that declares `selection="none"` has no selectable rows, so the
   * attribute is removed rather than written: in ARIA its absence is what "not
   * selectable" looks like.
   */
  #normalizeSelection(): void {
    const rows = this.rowTargets;
    if (this.selectionValue === "none") {
      // Reclaim, do not merely skip: a grid that *became* unselectable would
      // otherwise keep announcing rows as selected while the logic refuses to
      // change them. In ARIA the absence of the attribute is what "not
      // selectable" looks like, so the rows have to lose it outright.
      for (const row of rows) row.removeAttribute("aria-selected");
      return;
    }
    const single = this.selectionValue === "single";
    const first = rows.find((row) => row.getAttribute("aria-selected") === "true");
    for (const row of rows) {
      if (single) {
        row.setAttribute("aria-selected", row === first ? "true" : "false");
      } else if (row.getAttribute("aria-selected") !== "true") {
        row.setAttribute("aria-selected", "false");
      }
    }
  }

  /**
   * Mirrors `selection="multiple"` onto `aria-multiselectable` (APG Grid) so SRs
   * announce that more than one row can be selected; cleared for single/none so a
   * grid never carries a misleading attribute.
   */
  #syncSelectable(): void {
    if (this.selectionValue === "multiple") {
      this.element.setAttribute("aria-multiselectable", "true");
    } else {
      this.element.removeAttribute("aria-multiselectable");
    }
  }

  /** Cycles the activated column header's sort and emits `sort`. */
  sort(event: Event): void {
    const header = event.currentTarget as HTMLElement;
    if (!this.columnHeaderTargets.includes(header)) return;
    if (event.defaultPrevented) return;
    // A sortable header hosts a `<button>`, and that button's activation is
    // exactly what this click carries, so it is the one control that does not
    // take the event away. A link or a field inside the header is its own
    // destination, and sorting on its click would act in parallel.
    const control = this.#claimingControl(event, header);
    if (control && !(control instanceof HTMLButtonElement)) return;

    const direction = nextSortDirection(header.getAttribute("aria-sort") ?? "none");

    // Only one column is sorted at a time: reset the others to `none`.
    for (const other of this.columnHeaderTargets) {
      other.setAttribute("aria-sort", other === header ? direction : "none");
    }

    this.#setActiveCell(header, { focus: false });
    this.dispatch("sort", { detail: { column: header, direction } });
  }

  /** Toggles selection of the row owning the event target. Bound optionally. */
  toggleSelect(event: Event): void {
    // The pointer path guards on `selection="none"` exactly as the keyboard path
    // does, so a grid that declares itself unselectable never grows selected rows.
    if (this.selectionValue === "none") return;
    // A widget that handled the click owns it, exactly as the keyboard path
    // stands down on a keystroke a descendant consumed.
    if (event.defaultPrevented) return;
    const host = event.currentTarget as HTMLElement;
    if (this.#claimedByDescendant(event, host)) return;
    const row = host.closest<HTMLElement>("[role='row']");
    if (row && this.rowTargets.includes(row)) this.#toggleRow(row);
  }

  /** Grid navigation + sort/select activation. Bound to cells and headers. */
  onKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key (a grabbed drag handle, a
    // nested menu) must not ALSO act on it — composition depends on this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    if (event.isComposing) return;
    const cell = event.currentTarget as HTMLElement;
    // A native control inside the cell never calls `preventDefault()` — its
    // activation IS the default action — so the yield above cannot see it. This
    // recognises those by element shape instead.
    if (this.#claimedByDescendant(event, cell)) return;
    const matrix = this.#matrix();
    const position = this.#locate(matrix, cell);
    if (!position) return;
    const [row, col] = position;
    const rowCells = matrix[row] ?? [];

    let target: HTMLElement | undefined;
    // Logical, not physical. The key is normalised rather than the
    // delta negated: these two branches are not mirror images — their guards
    // differ — so swapping the key keeps each guard with its own direction.
    switch (logicalArrowKey(event.key, this.element)) {
      case "ArrowRight":
        target = this.#cellInRow(matrix, row, col + 1);
        break;
      case "ArrowLeft":
        target = this.#cellInRow(matrix, row, Math.max(col - 1, 0));
        break;
      case "ArrowDown":
        target = this.#cellInRow(matrix, Math.min(row + 1, matrix.length - 1), col);
        break;
      case "ArrowUp":
        target = this.#cellInRow(matrix, Math.max(row - 1, 0), col);
        break;
      case "Home":
        target = event.ctrlKey ? this.#cellInRow(matrix, 0, 0) : rowCells[0];
        break;
      case "End":
        target = event.ctrlKey
          ? this.#cellInRow(matrix, matrix.length - 1, Number.POSITIVE_INFINITY)
          : rowCells[rowCells.length - 1];
        break;
      case "Enter":
      case " ":
        this.#activate(cell);
        event.preventDefault();
        return;
      default:
        return;
    }

    if (target) {
      event.preventDefault();
      this.#setActiveCell(target, { focus: true }, matrix.flat());
    }
  }

  /**
   * Whether the event was addressed to a control inside `host` rather than to the
   * grid.
   *
   * Cells and headers hold consumer markup, and APG's grid pattern expects that
   * markup to include working controls — a row action button, an inline editor.
   * Those own their own keystrokes and clicks, so the grid stands down entirely
   * rather than acting in parallel. An editable host (its `contenteditable` state
   * is inherited, so the walk is explicit) counts the same way.
   */
  #claimedByDescendant(event: Event, host: HTMLElement): boolean {
    return this.#claimingControl(event, host) !== null;
  }

  /**
   * The nested control this event belongs to, or `null` when the host owns it.
   *
   * Naming the control, rather than answering yes or no, is what lets the click
   * path treat a sortable header's `<button>` as the activation it is while every
   * other control still takes the event away.
   */
  #claimingControl(event: Event, host: HTMLElement): HTMLElement | null {
    const source = event.target as HTMLElement;
    const control = source.closest<HTMLElement>(INTERACTIVE_HOST_SELECTOR);
    if (control && host.contains(control)) return control;
    return isInteractiveHost(source) ? source : null;
  }

  /** Performs a header's sort or a cell row's selection toggle on activation. */
  #activate(cell: HTMLElement): void {
    if (this.columnHeaderTargets.includes(cell)) {
      this.#cycleSort(cell);
      return;
    }
    if (this.selectionValue === "none") return;
    const row = cell.closest<HTMLElement>("[role='row']");
    if (row && this.rowTargets.includes(row)) this.#toggleRow(row);
  }

  /** Shared sort logic for both click and keyboard activation. */
  #cycleSort(header: HTMLElement): void {
    const direction = nextSortDirection(header.getAttribute("aria-sort") ?? "none");
    for (const other of this.columnHeaderTargets) {
      other.setAttribute("aria-sort", other === header ? direction : "none");
    }
    this.dispatch("sort", { detail: { column: header, direction } });
  }

  /** Toggles a row's `aria-selected`, honoring single vs. multiple selection. */
  #toggleRow(row: HTMLElement): void {
    const selected = row.getAttribute("aria-selected") === "true";
    // Enforce single-ness on every toggle, not only when turning a row on:
    // switching one *off* would otherwise leave a second `true` behind, and
    // nothing else clears it for the rest of the session.
    if (this.selectionValue === "single") {
      for (const other of this.rowTargets) {
        if (other !== row) other.setAttribute("aria-selected", "false");
      }
    }
    row.setAttribute("aria-selected", selected ? "false" : "true");

    const rows = this.rowTargets.filter((r) => r.getAttribute("aria-selected") === "true");
    this.dispatch("selectionchange", { detail: { rows } });
  }

  /**
   * Makes `cell` the single tabbable cell (roving) and optionally focuses it.
   *
   * `cells` lets a caller that already walked the grid hand its collection over,
   * so one keystroke rebuilds the matrix once instead of twice. The write is
   * skipped where the attribute already holds the wanted value — comparing the
   * attribute rather than the IDL property, because a cell with no `tabindex` at
   * all reports `-1` and would then never receive the attribute it needs to be
   * focusable.
   */
  #setActiveCell(
    cell: HTMLElement,
    { focus }: { focus: boolean },
    cells?: readonly HTMLElement[],
  ): void {
    for (const candidate of cells ?? this.#navigableCells()) {
      const wanted = candidate === cell ? "0" : "-1";
      if (candidate.getAttribute("tabindex") !== wanted) {
        candidate.setAttribute("tabindex", wanted);
      }
    }
    if (focus) cell.focus();
  }

  /** All navigable elements (headers + cells) in DOM order. */
  #navigableCells(): HTMLElement[] {
    return this.#matrix().flat();
  }

  /** The grid as rows of navigable cells, derived from each `role="row"`. */
  #matrix(): HTMLElement[][] {
    const navigable = new Set<HTMLElement>([...this.columnHeaderTargets, ...this.cellTargets]);
    const rows = Array.from(this.element.querySelectorAll<HTMLElement>("[role='row']"));
    return rows
      .map((row) =>
        Array.from(row.children).filter((child): child is HTMLElement =>
          navigable.has(child as HTMLElement),
        ),
      )
      .filter((cells) => cells.length > 0);
  }

  /** Finds `[rowIndex, colIndex]` of `cell` within `matrix`, or null. */
  #locate(matrix: HTMLElement[][], cell: HTMLElement): [number, number] | null {
    for (let row = 0; row < matrix.length; row++) {
      const col = (matrix[row] ?? []).indexOf(cell);
      if (col !== -1) return [row, col];
    }
    return null;
  }

  /** The cell at `[row, col]`, clamping `col` to that row's last cell. */
  #cellInRow(matrix: HTMLElement[][], row: number, col: number): HTMLElement | undefined {
    const cells = matrix[row];
    if (!cells || cells.length === 0) return undefined;
    return cells[Math.min(col, cells.length - 1)];
  }
}
