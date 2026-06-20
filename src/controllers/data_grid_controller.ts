import { Controller } from "@hotwired/stimulus";

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
 * @remarks
 * Behavior only — the consumer performs the actual data sort/render in response to
 * the `sort` event and owns all styling. No timers or observers are held, so there
 * is nothing to leak across Turbo navigations; `connect()` rebuilds the single tab
 * stop idempotently from the DOM.
 *
 * Behavior provided:
 * - `Arrow*` move between cells (clamped at edges); `Home`/`End` to the row's
 *   first/last cell; `Ctrl+Home`/`Ctrl+End` to the grid's first/last cell.
 * - `Enter`/`Space` cycles a header's sort (`none→ascending→descending`) or toggles
 *   the focused row's selection when selection is enabled.
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

  /** Establishes a single tab stop across all navigable cells/headers. */
  override connect(): void {
    const cells = this.#navigableCells();
    const active = cells.find((cell) => cell.tabIndex === 0) ?? cells[0];
    this.#setActiveCell(active, { focus: false });
  }

  /**
   * Keeps `aria-multiselectable` in step with the `selection` Value. Fires on connect
   * (so it self-heals after a Turbo morph) and on any runtime change, so the ARIA
   * never drifts from the selection logic, which reads `selectionValue` live.
   */
  selectionValueChanged(): void {
    this.#syncSelectable();
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
    const row = (event.currentTarget as HTMLElement).closest<HTMLElement>("[role='row']");
    if (row && this.rowTargets.includes(row)) this.#toggleRow(row);
  }

  /** Grid navigation + sort/select activation. Bound to cells and headers. */
  onKeydown(event: KeyboardEvent): void {
    const cell = event.currentTarget as HTMLElement;
    const matrix = this.#matrix();
    const position = this.#locate(matrix, cell);
    if (!position) return;
    const [row, col] = position;
    const rowCells = matrix[row] ?? [];

    let target: HTMLElement | undefined;
    switch (event.key) {
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
      this.#setActiveCell(target, { focus: true });
    }
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
    if (this.selectionValue === "single" && !selected) {
      for (const other of this.rowTargets) other.setAttribute("aria-selected", "false");
    }
    row.setAttribute("aria-selected", selected ? "false" : "true");

    const rows = this.rowTargets.filter((r) => r.getAttribute("aria-selected") === "true");
    this.dispatch("selectionchange", { detail: { rows } });
  }

  /** Makes `cell` the single tabbable cell (roving) and optionally focuses it. */
  #setActiveCell(cell: HTMLElement | undefined, { focus }: { focus: boolean }): void {
    if (!cell) return;
    for (const candidate of this.#navigableCells()) {
      candidate.tabIndex = candidate === cell ? 0 : -1;
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
